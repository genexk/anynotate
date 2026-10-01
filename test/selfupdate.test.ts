import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, compareVersions, parseSums, RELEASES_API, selfUpdate, type SelfUpdateOptions } from "../src/agent/selfupdate";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const DL = "https://github.com/genexk/anynotate/releases/download";

let dir: string;
let exe: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anynotate-selfupdate-"));
  exe = join(dir, "anynotate");
  writeFileSync(exe, "old binary", { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Served = { status?: number; body?: string; headers?: Record<string, string> };

function release(tag: string, name = "anynotate-darwin-arm64", newBytes = "new binary", sums?: string) {
  const routes: Record<string, Served> = {
    [RELEASES_API]: {
      body: JSON.stringify({
        tag_name: tag,
        assets: [
          { name, browser_download_url: `${DL}/${tag}/${name}` },
          { name: "SHA256SUMS", browser_download_url: `${DL}/${tag}/SHA256SUMS` },
        ],
      }),
    },
    [`${DL}/${tag}/${name}`]: { body: newBytes },
    [`${DL}/${tag}/SHA256SUMS`]: { body: sums ?? `${sha("other")}  anynotate-linux-x64\n${sha(newBytes)}  ${name}\n` },
  };
  return routes;
}

function fakeFetch(routes: Record<string, Served>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { calls, fetch: f };
}

async function run(routes: Record<string, Served>, o: Partial<SelfUpdateOptions> = {}) {
  const f = fakeFetch(routes);
  const out: string[] = [];
  const err: string[] = [];
  const reinstalls: string[] = [];
  let stops = 0;
  const code = await selfUpdate({
    platform: "darwin",
    arch: "arm64",
    current: "0.4.0",
    exe,
    fetch: f.fetch,
    dryRun: false,
    log: (l) => out.push(l),
    err: (l) => err.push(l),
    stop: () => {
      stops++;
      return true;
    },
    reinstall: (e) => {
      reinstalls.push(e);
      return 0;
    },
    ...o,
  });
  return { code, out, err, calls: f.calls, reinstalls, stops };
}

test("asset names match the release builder", () => {
  expect(assetName("darwin", "arm64")).toBe("anynotate-darwin-arm64");
  expect(assetName("darwin", "x64")).toBe("anynotate-darwin-x64");
  expect(assetName("linux", "x64")).toBe("anynotate-linux-x64");
  expect(assetName("linux", "arm64")).toBe("anynotate-linux-arm64");
  expect(assetName("win32", "x64")).toBe("anynotate-windows-x64.exe");
  expect(() => assetName("win32", "arm64")).toThrow();
  expect(() => assetName("linux", "ia32")).toThrow();
});

test("versions compare numerically, with or without a v prefix, and a prerelease sorts before its release", () => {
  expect(compareVersions("v0.4.1", "0.4.0")).toBeGreaterThan(0);
  expect(compareVersions("0.10.0", "v0.9.9")).toBeGreaterThan(0);
  expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("0.3.9", "0.4.0")).toBeLessThan(0);
  expect(compareVersions("0.5.0-beta.1", "0.5.0")).toBeLessThan(0);
  expect(compareVersions("0.5.0-beta.1", "0.4.0")).toBeGreaterThan(0);
  expect(() => compareVersions("latest", "0.4.0")).toThrow();
});

test("SHA256SUMS lines parse into name → hash, ignoring the binary-mode marker", () => {
  const a = sha("a");
  const m = parseSums(`${a}  anynotate-linux-x64\n${a} *anynotate-windows-x64.exe\n\ngarbage\n`);
  expect(m.get("anynotate-linux-x64")).toBe(a);
  expect(m.get("anynotate-windows-x64.exe")).toBe(a);
  expect(m.size).toBe(2);
});

test("up to date: no download, binary untouched", async () => {
  const r = await run(release("v0.4.0"));
  expect(r.code).toBe(0);
  expect(r.out).toEqual(["anynotate 0.4.0 is up to date"]);
  expect(r.calls.map((c) => c.url)).toEqual([RELEASES_API]);
  expect(readFileSync(exe, "utf8")).toBe("old binary");
  expect(r.reinstalls).toEqual([]);
});

test("the API request identifies itself, asks for GitHub JSON, has a timeout and sends no token", async () => {
  const r = await run(release("v0.4.0"));
  const h = new Headers(r.calls[0]!.init?.headers);
  expect(h.get("user-agent")).toBe("anynotate/0.4.0");
  expect(h.get("accept")).toBe("application/vnd.github+json");
  expect(h.get("authorization")).toBeNull();
  expect(r.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
});

test("newer release: binary replaced, reinstalled once from the new binary, versions printed", async () => {
  const r = await run(release("v0.4.1"));
  expect(r.err).toEqual([]);
  expect(r.code).toBe(0);
  expect(readFileSync(exe, "utf8")).toBe("new binary");
  expect(statSync(exe).mode & 0o777).toBe(0o755);
  expect(existsSync(`${exe}.new`)).toBe(false);
  expect(r.reinstalls).toEqual([exe]);
  expect(r.stops).toBe(0);
  expect(r.out.at(-1)).toBe("anynotate 0.4.0 → 0.4.1");
  for (const c of r.calls.slice(1)) expect(c.init?.signal).toBeInstanceOf(AbortSignal);
});

test("follows a release redirect to GitHub's asset host", async () => {
  const routes = release("v0.4.1");
  routes[`${DL}/v0.4.1/anynotate-darwin-arm64`] = { status: 302, headers: { location: "https://objects.githubusercontent.com/x/bin" } };
  routes["https://objects.githubusercontent.com/x/bin"] = { body: "new binary" };
  const r = await run(routes);
  expect(r.code).toBe(0);
  expect(readFileSync(exe, "utf8")).toBe("new binary");
});

test("refuses a redirect off GitHub and leaves the binary alone", async () => {
  const routes = release("v0.4.1");
  routes[`${DL}/v0.4.1/anynotate-darwin-arm64`] = { status: 302, headers: { location: "https://example.com/bin" } };
  routes["https://example.com/bin"] = { body: "new binary" };
  const r = await run(routes);
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toContain("example.com");
  expect(r.calls.map((c) => c.url)).not.toContain("https://example.com/bin");
  expect(readFileSync(exe, "utf8")).toBe("old binary");
});

test("refuses an asset URL off GitHub in the release JSON", async () => {
  const routes = release("v0.4.1");
  const json = JSON.parse(routes[RELEASES_API]!.body!);
  json.assets[0].browser_download_url = "https://example.com/anynotate-darwin-arm64";
  routes[RELEASES_API] = { body: JSON.stringify(json) };
  const r = await run(routes);
  expect(r.code).toBe(1);
  expect(r.calls.map((c) => c.url)).toEqual([RELEASES_API]);
  expect(readFileSync(exe, "utf8")).toBe("old binary");
});

test("checksum mismatch: exit 1, original bytes intact, no exe.new left", async () => {
  const r = await run(release("v0.4.1", "anynotate-darwin-arm64", "new binary", `${sha("tampered")}  anynotate-darwin-arm64\n`));
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toContain("checksum");
  expect(readFileSync(exe, "utf8")).toBe("old binary");
  expect(existsSync(`${exe}.new`)).toBe(false);
  expect(r.reinstalls).toEqual([]);
});

test("missing checksum entry or asset: exit 1, binary untouched", async () => {
  const noSum = await run(release("v0.4.1", "anynotate-darwin-arm64", "new binary", `${sha("x")}  anynotate-linux-x64\n`));
  expect(noSum.code).toBe(1);
  const noAsset = await run(release("v0.4.1", "anynotate-linux-x64"));
  expect(noAsset.code).toBe(1);
  expect(noAsset.err.join("\n")).toContain("anynotate-darwin-arm64");
  expect(readFileSync(exe, "utf8")).toBe("old binary");
});

test("download failure: exit 1, binary untouched", async () => {
  const routes = release("v0.4.1");
  routes[`${DL}/v0.4.1/anynotate-darwin-arm64`] = { status: 500, body: "boom" };
  const r = await run(routes);
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toContain("500");
  expect(readFileSync(exe, "utf8")).toBe("old binary");
});

test("a fetch that throws (timeout, offline) is reported, not thrown", async () => {
  const r = await run({}, { fetch: (async () => { throw new Error("The operation timed out."); }) as unknown as typeof fetch });
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toContain("timed out");
});

test("downgrade refused: an older latest release changes nothing", async () => {
  const r = await run(release("v0.3.9"));
  expect(r.code).toBe(0);
  expect(r.out.join("\n")).toContain("not downgrading");
  expect(r.calls).toHaveLength(1);
  expect(readFileSync(exe, "utf8")).toBe("old binary");
});

test("a prerelease tag is ignored", async () => {
  const r = await run(release("v0.5.0-rc.1"));
  expect(r.code).toBe(0);
  expect(r.calls).toHaveLength(1);
  expect(readFileSync(exe, "utf8")).toBe("old binary");
});

test("dry run downloads nothing and reports the plan", async () => {
  const r = await run(release("v0.4.1"), { dryRun: true });
  expect(r.code).toBe(0);
  expect(r.calls.map((c) => c.url)).toEqual([RELEASES_API]);
  expect(r.out.join("\n")).toContain("would download");
  expect(r.out.join("\n")).toContain("0.4.0 → 0.4.1");
  expect(readFileSync(exe, "utf8")).toBe("old binary");
  expect(r.reinstalls).toEqual([]);
});

test("win32: stops the bridge, moves the running exe to .old and the new one into place", async () => {
  exe = join(dir, "anynotate.exe");
  writeFileSync(exe, "old binary", { mode: 0o755 });
  writeFileSync(`${exe}.old`, "stale");
  const r = await run(release("v0.4.1", "anynotate-windows-x64.exe"), { platform: "win32", arch: "x64" });
  expect(r.err).toEqual([]);
  expect(r.code).toBe(0);
  expect(r.stops).toBe(1);
  expect(readFileSync(exe, "utf8")).toBe("new binary");
  expect(readFileSync(`${exe}.old`, "utf8")).toBe("old binary");
  expect(r.reinstalls).toEqual([exe]);
});

test("win32: a failed bridge stop aborts before the swap", async () => {
  exe = join(dir, "anynotate.exe");
  writeFileSync(exe, "old binary");
  const r = await run(release("v0.4.1", "anynotate-windows-x64.exe"), { platform: "win32", arch: "x64", stop: () => false });
  expect(r.code).toBe(1);
  expect(readFileSync(exe, "utf8")).toBe("old binary");
  expect(existsSync(`${exe}.new`)).toBe(false);
  expect(r.reinstalls).toEqual([]);
});

test("a failed reinstall is an error, reported after the swap", async () => {
  const r = await run(release("v0.4.1"), { reinstall: () => 3 });
  expect(r.code).toBe(1);
  expect(readFileSync(exe, "utf8")).toBe("new binary");
  expect(r.err.join("\n")).toContain("install");
});
