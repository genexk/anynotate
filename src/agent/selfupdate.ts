import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Platform } from "../platform/os";

class UpdateError extends Error {}

export const RELEASES_API = "https://api.github.com/repos/genexk/anynotate/releases/latest";

// Release downloads redirect from github.com to GitHub's asset storage; nothing else is ever fetched.
const ALLOWED_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
export const DEFAULT_LIMITS = { text: 64 * 1024, binary: 200 * 1024 * 1024 };

const ASSET_OS: Record<Platform, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const SUPPORTED = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"]);

export function assetName(p: Platform, arch: string): string {
  const target = `${ASSET_OS[p]}-${arch}`;
  if (!SUPPORTED.has(target)) throw new Error(`no release build for ${target}`);
  return `anynotate-${target}${p === "win32" ? ".exe" : ""}`;
}

type Version = { core: number[]; pre: string | null };

function parseVersion(v: string): Version {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) throw new Error(`not a version: ${JSON.stringify(v)}`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

function comparePre(a: string, b: string): number {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]!);
    const ny = /^\d+$/.test(y[i]!);
    if (nx && ny && Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return 0;
}

// Semver precedence: a leading v is ignored, and a prerelease sorts before the release it precedes.
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return comparePre(x.pre, y.pre);
}

// `<hex>  <name>` per line, as sha256sum writes it; a `*` before the name marks binary mode. Unparseable lines are
// skipped, except one naming `target`; a name listed twice with different hashes makes the whole file untrustworthy.
export function parseSums(text: string, target?: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!m) {
      if (target !== undefined && line.split(/\s+/).at(-1)?.replace(/^\*/, "") === target) {
        throw new UpdateError(`malformed SHA256SUMS line for ${target}`);
      }
      continue;
    }
    const [, hex, name] = m;
    const prev = sums.get(name!);
    if (prev !== undefined && prev !== hex!.toLowerCase()) throw new UpdateError(`SHA256SUMS lists ${name} twice with different hashes`);
    sums.set(name!, hex!.toLowerCase());
  }
  return sums;
}

export type SelfUpdateOptions = {
  platform: Platform;
  arch: string;
  current: string;
  exe: string;
  fetch: typeof fetch;
  dryRun: boolean;
  log: (line: string) => void;
  err: (line: string) => void;
  // Stops the bridge; called only on Windows, where the running executable must not be held open by it.
  stop: () => boolean;
  // Runs `install --no-hints` with the given (new) executable, which also restarts the bridge; returns its exit code.
  reinstall: (exe: string) => number;
  // The binary install.json records; a different running copy is updated anyway, with a warning.
  recordedPath?: string | null;
  limits?: { text: number; binary: number };
  rename?: (from: string, to: string) => void;
};

function checkHost(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UpdateError(`not a URL: ${url}`);
  }
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new UpdateError(`refusing to fetch from ${u.host || url}: not GitHub`);
  return u;
}

async function get(o: SelfUpdateOptions, url: string, accept: string, timeoutMs: number): Promise<Response> {
  let next = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkHost(next);
    let res: Response;
    try {
      res = await o.fetch(next, {
        headers: { "User-Agent": `anynotate/${o.current}`, Accept: accept },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new UpdateError(`cannot fetch ${next}: ${(e as Error).message}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await discard(res);
      next = new URL(location, next).toString();
      continue;
    }
    if (!res.ok) {
      await discard(res);
      throw new UpdateError(`cannot fetch ${next}: HTTP ${res.status}`);
    }
    return res;
  }
  throw new UpdateError(`too many redirects fetching ${url}`);
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {}
}

// Reads at most `cap` bytes: a larger declared length is refused unread, and a body that runs past it is cancelled.
async function readCapped(res: Response, cap: number, what: string): Promise<Uint8Array> {
  const tooLarge = () => new UpdateError(`${what} is too large (over ${cap} bytes)`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await discard(res);
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError(`cannot read ${what}: ${(e as Error).message}`);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const limitsOf = (o: SelfUpdateOptions) => o.limits ?? DEFAULT_LIMITS;

type Release = { tag: string; assets: Map<string, string> };

async function latestRelease(o: SelfUpdateOptions): Promise<Release> {
  const res = await get(o, RELEASES_API, "application/vnd.github+json", API_TIMEOUT_MS);
  const body = await readCapped(res, limitsOf(o).text, "the release JSON");
  let json: { tag_name?: unknown; assets?: unknown };
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new UpdateError("the GitHub releases API returned something other than JSON");
  }
  if (typeof json.tag_name !== "string") throw new UpdateError("the latest release has no tag");
  const assets = new Map<string, string>();
  for (const a of Array.isArray(json.assets) ? json.assets : []) {
    if (typeof a?.name === "string" && typeof a?.browser_download_url === "string") assets.set(a.name, a.browser_download_url);
  }
  return { tag: json.tag_name, assets };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function selfUpdate(o: SelfUpdateOptions): Promise<number> {
  const { exe, log } = o;
  const fail = (why: string) => {
    o.err(`anynotate update: ${why}`);
    return 1;
  };
  const staged = `${exe}.new`;
  const old = `${exe}.old`;
  const rename = o.rename ?? renameSync;
  const limits = limitsOf(o);

  if (o.recordedPath && o.recordedPath !== exe) {
    o.err(`anynotate update: warning: install.json records ${o.recordedPath}, but this is ${exe}; updating ${exe}`);
  }

  // The previous run's executable, renamed aside while it was still running; it may still be locked.
  if (o.platform === "win32" && !o.dryRun) {
    try {
      rmSync(old, { force: true });
    } catch {}
  }

  try {
    const name = assetName(o.platform, o.arch);
    const release = await latestRelease(o);
    const latest = release.tag.replace(/^v/, "");
    if (parseVersion(latest).pre !== null) {
      log(`anynotate ${o.current} is up to date (latest release ${release.tag} is a prerelease)`);
      return 0;
    }
    const order = compareVersions(latest, o.current);
    if (order === 0) {
      log(`anynotate ${o.current} is up to date`);
      return 0;
    }
    if (order < 0) {
      log(`anynotate ${o.current} is newer than the latest release ${latest}; not downgrading`);
      return 0;
    }

    const assetUrl = release.assets.get(name);
    const sumsUrl = release.assets.get("SHA256SUMS");
    if (!assetUrl) throw new UpdateError(`release ${release.tag} has no ${name}`);
    if (!sumsUrl) throw new UpdateError(`release ${release.tag} has no SHA256SUMS`);
    checkHost(assetUrl);
    checkHost(sumsUrl);

    if (o.dryRun) {
      log(`anynotate ${o.current} → ${latest}`);
      log(`would download ${assetUrl}`);
      log(`would verify it against ${sumsUrl}`);
      if (o.platform === "win32") log("would stop the bridge");
      log(`would replace ${exe}`);
      log(`would run ${exe} install --no-hints`);
      return 0;
    }

    const sumsRes = await get(o, sumsUrl, "application/octet-stream", API_TIMEOUT_MS);
    const sums = parseSums(new TextDecoder().decode(await readCapped(sumsRes, limits.text, "SHA256SUMS")), name);
    const expected = sums.get(name);
    if (!expected) throw new UpdateError(`SHA256SUMS of ${release.tag} has no entry for ${name}`);
    const assetRes = await get(o, assetUrl, "application/octet-stream", DOWNLOAD_TIMEOUT_MS);
    const bytes = await readCapped(assetRes, limits.binary, name);
    if (sha256(bytes) !== expected) throw new UpdateError(`checksum mismatch for ${name}; nothing was changed`);

    try {
      // A fresh file: whatever sits at exe.new (a leftover, or a planted symlink) is removed, never written through.
      rmSync(staged, { force: true });
      writeFileSync(staged, bytes, { mode: 0o755, flag: "wx" });
      chmodSync(staged, 0o755);
      if (sha256(readFileSync(staged)) !== expected) throw new UpdateError(`checksum mismatch after writing ${staged}; nothing was changed`);
      if (o.platform !== "win32") rename(staged, exe);
    } catch (e) {
      rmSync(staged, { force: true });
      throw e;
    }

    // Windows will not replace a running executable, but it will rename one: move it aside, then move the new one in.
    if (o.platform === "win32") {
      if (!o.stop()) {
        rmSync(staged, { force: true });
        throw new UpdateError("could not stop the bridge; nothing was changed");
      }
      const restartOld = (why: string) => {
        rmSync(staged, { force: true });
        const code = o.reinstall(exe);
        const restarted = code === 0 ? "the bridge was restarted on it" : `restarting the bridge failed (exit ${code}); run \`anynotate install\``;
        return fail(`${why}; ${exe} is unchanged and ${restarted}`);
      };
      try {
        rename(exe, old);
      } catch (e) {
        return restartOld(`could not move ${exe} aside: ${(e as Error).message}`);
      }
      try {
        rename(staged, exe);
      } catch (e) {
        const why = `could not move the new binary into ${exe}: ${(e as Error).message}`;
        try {
          rename(old, exe);
        } catch {
          rmSync(staged, { force: true });
          return fail(`${why}; could not restore ${exe}; rename ${old} back to ${exe} manually`);
        }
        return restartOld(why);
      }
    }
    log(`replaced ${exe} with ${release.tag}`);

    const code = o.reinstall(exe);
    if (code !== 0) return fail(`${exe} install --no-hints failed (exit ${code}); the new binary is in place, re-run \`anynotate install\``);
    log(`anynotate ${o.current} → ${latest}`);
    return 0;
  } catch (e) {
    return fail((e as Error).message);
  }
}
