import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Agent, Bundle, BUNDLE_ID, type BundleInput, Status } from "@anynotate/protocol";

export { BUNDLE_ID };
import { makePrivateDir } from "../platform/files";
import { clearLatest, readLatest, writeLatest } from "../platform/latest";
import { archiveDir, ensureHome, inboxDir } from "./paths";
import { renderReadme } from "./readme";

const ALLOWED_FILE = /^(page\.md|screenshot\.png|snapshot\.html|crops\/A\d+\.png)$/;
const pad = (n: number) => String(n).padStart(2, "0");

export function bundleDir(id: string): string {
  if (!BUNDLE_ID.test(id)) throw new Error(`invalid bundle id: ${id}`);
  return join(inboxDir(), id);
}

function ensureInbox(): string {
  ensureHome();
  return makePrivateDir(inboxDir());
}

const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

function parseUrl(url: string | undefined): URL | null {
  try {
    return url ? new URL(url) : null;
  } catch {
    return null;
  }
}

function fileStem(u: URL): string {
  const base = u.pathname.split("/").pop() ?? "";
  let name: string;
  try {
    name = decodeURIComponent(base);
  } catch {
    name = base;
  }
  return name.replace(/\.[^.]*$/, "");
}

function urlSlug(url: string | undefined): string {
  const u = parseUrl(url);
  if (!u) return "";
  return slugify(u.protocol === "file:" ? fileStem(u) : u.hostname);
}

export function newBundleId(title: string, now = new Date(), url?: string): string {
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${ts}-${slugify(title) || urlSlug(url) || "page"}`;
}

function writeJsonAtomic(path: string, value: unknown, tag: string) {
  const tmp = `${path}.tmp-${tag}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function writeBundle(input: BundleInput, files: Record<string, Uint8Array>, now = new Date()): Bundle {
  for (const name of Object.keys(files)) {
    if (!ALLOWED_FILE.test(name)) throw new Error(`unexpected file name: ${name}`);
  }
  const inbox = ensureInbox();
  const base = newBundleId(input.title, now, input.url);
  let id = base;
  for (let n = 2; existsSync(join(inbox, id)); n++) id = `${base}-${n}`;

  const bundle = Bundle.parse({
    ...input,
    id,
    files: {
      page: "page.md",
      screenshot: "screenshot.png",
      ...(files["snapshot.html"] ? { snapshot: "snapshot.html" } : {}),
    },
  });

  const tmp = join(inbox, `.tmp-${id}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmp, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(tmp, name)), { recursive: true });
    writeFileSync(join(tmp, name), bytes);
  }
  writeFileSync(join(tmp, "annotations.json"), JSON.stringify(bundle, null, 2));
  writeFileSync(join(tmp, "README.md"), renderReadme(bundle, new Set(Object.keys(files))));
  writeFileSync(join(tmp, "status.json"), JSON.stringify({ state: "queued", at: now.toISOString() } satisfies Status, null, 2));
  renameSync(tmp, join(inbox, id));
  pointLatestAt(id);
  return bundle;
}

function pointLatestAt(id: string | undefined): void {
  if (id) writeLatest(inboxDir(), id);
  else clearLatest(inboxDir());
}

export function latestBundleId(): string | undefined {
  const id = readLatest(inboxDir());
  if (id && existsSync(join(inboxDir(), id, "annotations.json"))) return id;
  return listBundles(1)[0]?.bundle.id;
}

export function readBundle(id: string): Bundle {
  return Bundle.parse(JSON.parse(readFileSync(join(bundleDir(id), "annotations.json"), "utf8")));
}

function parseStatusFile(path: string): Status | null {
  try {
    return Status.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function newestClaim(dir: string): string | null {
  let best: { file: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("status.json.claim-")) continue;
      const file = join(dir, name);
      try {
        const mtime = statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      } catch {}
    }
  } catch {}
  return best?.file ?? null;
}

export function readStatus(id: string): Status | null {
  let dir: string;
  try {
    dir = bundleDir(id);
  } catch {
    return null;
  }
  const path = join(dir, "status.json");
  if (existsSync(path)) return parseStatusFile(path);
  const held = newestClaim(dir);
  return held ? parseStatusFile(held) : null;
}

// A claim file older than this belongs to a process that died between claim and release.
export const STALE_CLAIM_MS = 60_000;

function recoverStaleClaim(dir: string, path: string): void {
  if (existsSync(path)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("status.json.claim-")) continue;
    const file = join(dir, name);
    try {
      if (Date.now() - statSync(file).mtimeMs <= STALE_CLAIM_MS) continue;
      renameSync(file, path);
      return;
    } catch {
      // Another claimant recovered it first, or it vanished; move on.
    }
  }
}

// Renaming status.json away is the lock: only one claimant can win the rename.
export function claim(id: string, owner: string): Status | null {
  if (!BUNDLE_ID.test(id)) return null;
  const dir = bundleDir(id);
  const path = join(dir, "status.json");
  const claimed = `${path}.claim-${owner}`;
  recoverStaleClaim(dir, path);
  try {
    renameSync(path, claimed);
  } catch {
    return null;
  }
  try {
    // rename keeps the old mtime; stamp the claim time so stale recovery measures claim age.
    const now = new Date();
    utimesSync(claimed, now, now);
    return Status.parse(JSON.parse(readFileSync(claimed, "utf8")));
  } catch {
    renameSync(claimed, path);
    return null;
  }
}

export function release(id: string, owner: string, next: Status): void {
  const path = join(bundleDir(id), "status.json");
  writeJsonAtomic(path, Status.parse(next), owner);
  rmSync(`${path}.claim-${owner}`, { force: true });
}

// Undo a claim without writing a new status: the claimed file goes back to status.json.
export function restoreClaim(id: string, owner: string): void {
  const path = join(bundleDir(id), "status.json");
  renameSync(`${path}.claim-${owner}`, path);
}

export function updateStatus(id: string, owner: string, fn: (s: Status) => Status): boolean {
  const current = claim(id, owner);
  if (!current) return false;
  try {
    release(id, owner, { ...fn(current), at: new Date().toISOString() });
  } catch (err) {
    restoreClaim(id, owner);
    throw err;
  }
  return true;
}

export function listBundles(limit = Number.POSITIVE_INFINITY): { bundle: Bundle; status: Status | null }[] {
  if (!existsSync(inboxDir())) return [];
  const out: { bundle: Bundle; status: Status | null }[] = [];
  for (const id of readdirSync(inboxDir()).filter((n) => BUNDLE_ID.test(n)).sort().reverse()) {
    if (out.length >= limit) break;
    try {
      out.push({ bundle: readBundle(id), status: readStatus(id) });
    } catch {
      // Skip folders that are not valid bundles.
    }
  }
  return out;
}

export function archiveOlderThan(days: number, now = new Date()): string[] {
  const cutoff = now.getTime() - days * 86_400_000;
  const moved: string[] = [];
  for (const { bundle } of listBundles()) {
    // NaN (an unparseable sentAt) is never "older", so such a bundle stays in the inbox.
    if (!(Date.parse(bundle.sentAt) < cutoff)) continue;
    // One bundle that can't be moved must not stop the sweep, nor crash the bridge that runs it.
    try {
      ensureHome();
      makePrivateDir(archiveDir());
      renameSync(bundleDir(bundle.id), join(archiveDir(), bundle.id));
      moved.push(bundle.id);
    } catch (err) {
      console.error(`anynotate: could not archive ${bundle.id}:`, err);
    }
  }
  repointLatestIfGone(moved);
  return moved;
}

// Points inbox/latest at the newest remaining bundle when its target is among the removed ids (or it is missing).
export function repointLatestIfGone(removed: string[]): void {
  if (!removed.length) return;
  const current = readLatest(inboxDir());
  if (current === null || removed.includes(current)) pointLatestAt(listBundles(1)[0]?.bundle.id);
}

export function queuedFor(agent: Agent, sessionId: string | undefined, cwd: string): Bundle[] {
  return listBundles()
    .filter(({ bundle, status }) => {
      if (status?.state !== "queued" || bundle.target.agent !== agent) return false;
      if (bundle.target.sessionId) return bundle.target.sessionId === sessionId;
      return bundle.target.cwd === cwd;
    })
    .map(({ bundle }) => bundle);
}
