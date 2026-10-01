import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMessage, encodeMessage } from "../src/agent/native-host";
import type { Exec, ExecResult } from "../src/platform/exec";
import {
  applyHostSteps,
  HOST_NAME,
  hostManifest,
  isNativeHostInvocation,
  planNativeHost,
  planNativeHostRemoval,
  sourceHostWrapper,
  type HostStep,
} from "../src/platform/nativehost";
import { browserRegistryKey } from "../src/platform/os";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${ID}/`;

test("the host name is fixed", () => {
  expect(HOST_NAME).toBe("dev.anynotate.host");
});

test("isNativeHostInvocation spots Chrome's launch for the binary and for bun", () => {
  expect(isNativeHostInvocation(["/x/anynotate", "chrome-extension://abc/"])).toBe(true);
  expect(isNativeHostInvocation(["bun", "cli.ts", "chrome-extension://abc/"])).toBe(true);
  expect(isNativeHostInvocation(["C:\\x\\anynotate.exe", "chrome-extension://abc/", "--parent-window=0"])).toBe(true);
  expect(isNativeHostInvocation(["anynotate", "install"])).toBe(false);
  expect(isNativeHostInvocation(["bun", "cli.ts", "native-host", "chrome-extension://abc/"])).toBe(false);
  expect(isNativeHostInvocation(["anynotate"])).toBe(false);
});

test("hostManifest ends every allowed origin with a slash", () => {
  expect(hostManifest("/home/me/.local/bin/anynotate", [`chrome-extension://${ID}`, ORIGIN])).toEqual({
    name: HOST_NAME,
    description: "Anynotate helper",
    path: "/home/me/.local/bin/anynotate",
    type: "stdio",
    allowed_origins: [ORIGIN, ORIGIN],
  });
});

const manifestOf = (s: HostStep) => (s.kind === "write-manifest" ? JSON.parse(s.json) : null);

test("darwin writes a manifest for each browser that is present, Chrome always", () => {
  const home = "/home/me";
  const support = `${home}/Library/Application Support`;
  const present = new Set([`${support}/BraveSoftware/Brave-Browser`]);
  const steps = planNativeHost({
    platform: "darwin", home, env: {}, hostPath: "/home/me/.local/bin/anynotate", dataDir: `${home}/.anynotate`, origins: [ORIGIN], exists: (p) => present.has(p),
  });
  expect(steps.map((s) => s.kind)).toEqual(["write-manifest", "write-manifest"]);
  expect(steps.map((s) => (s as { path: string }).path)).toEqual([
    `${support}/Google/Chrome/NativeMessagingHosts/dev.anynotate.host.json`,
    `${support}/BraveSoftware/Brave-Browser/NativeMessagingHosts/dev.anynotate.host.json`,
  ]);
  for (const s of steps) {
    expect(manifestOf(s).path).toBe("/home/me/.local/bin/anynotate");
    expect(manifestOf(s).allowed_origins).toEqual([ORIGIN]);
  }
});

test("darwin with Chrome and Brave present writes exactly those two", () => {
  const support = "/home/me/Library/Application Support";
  const present = new Set([`${support}/Google/Chrome`, `${support}/BraveSoftware/Brave-Browser`]);
  const steps = planNativeHost({ platform: "darwin", home: "/home/me", env: {}, hostPath: "/h", dataDir: "/d", origins: [ORIGIN], exists: (p) => present.has(p) });
  expect(steps).toHaveLength(2);
});

test("linux with no browser config writes only Chrome's manifest", () => {
  const steps = planNativeHost({ platform: "linux", home: "/home/me", env: {}, hostPath: "/h", dataDir: "/d", origins: [ORIGIN], exists: () => false });
  expect(steps).toEqual([{ kind: "write-manifest", path: "/home/me/.config/google-chrome/NativeMessagingHosts/dev.anynotate.host.json", json: expect.any(String) }]);
  expect(steps[0]!.kind === "write-manifest" && steps[0]!.json.endsWith("}\n")).toBe(true);
});

test("linux honours XDG_CONFIG_HOME", () => {
  const steps = planNativeHost({ platform: "linux", home: "/home/me", env: { XDG_CONFIG_HOME: "/cfg" }, hostPath: "/h", dataDir: "/d", origins: [ORIGIN], exists: () => true });
  expect(steps.map((s) => (s as { path: string }).path)).toEqual([
    "/cfg/google-chrome/NativeMessagingHosts/dev.anynotate.host.json",
    "/cfg/microsoft-edge/NativeMessagingHosts/dev.anynotate.host.json",
    "/cfg/BraveSoftware/Brave-Browser/NativeMessagingHosts/dev.anynotate.host.json",
    "/cfg/chromium/NativeMessagingHosts/dev.anynotate.host.json",
  ]);
});

const WIN = { platform: "win32" as const, home: "C:\\Users\\me", env: {}, hostPath: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe", dataDir: "C:\\Users\\me\\.anynotate" };
const WIN_MANIFEST = "C:\\Users\\me\\.anynotate\\dev.anynotate.host.json";
const KEYS = [
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.anynotate.host",
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\dev.anynotate.host",
  "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\dev.anynotate.host",
  "HKCU\\Software\\Chromium\\NativeMessagingHosts\\dev.anynotate.host",
];

test("win32 writes one manifest in the data dir and registers it for all four browsers", () => {
  const steps = planNativeHost({ ...WIN, origins: [ORIGIN], exists: () => false });
  expect(steps[0]).toEqual({ kind: "write-manifest", path: WIN_MANIFEST, json: expect.any(String) });
  expect(manifestOf(steps[0]!).path).toBe(WIN.hostPath);
  expect(steps.slice(1)).toEqual(KEYS.map((key) => ({ kind: "reg-add", key, manifestPath: WIN_MANIFEST })));
});

test("removal on unix covers every browser's manifest whether or not it exists", () => {
  const steps = planNativeHostRemoval({ platform: "linux", home: "/home/me", env: {}, hostPath: "/h", dataDir: "/d", exists: () => false });
  expect(steps).toEqual(
    ["google-chrome", "microsoft-edge", "BraveSoftware/Brave-Browser", "chromium"].map((d) => ({
      kind: "remove-manifest",
      path: `/home/me/.config/${d}/NativeMessagingHosts/dev.anynotate.host.json`,
    })),
  );
  const mac = planNativeHostRemoval({ platform: "darwin", home: "/home/me", env: {}, hostPath: "/h", dataDir: "/d", exists: () => false });
  expect(mac).toHaveLength(4);
  expect(mac.every((s) => s.kind === "remove-manifest" && s.path.endsWith("/NativeMessagingHosts/dev.anynotate.host.json"))).toBe(true);
});

test("removal on win32 deletes the manifest and every registry key", () => {
  expect(planNativeHostRemoval({ ...WIN, exists: () => false })).toEqual([
    { kind: "remove-manifest", path: WIN_MANIFEST },
    ...KEYS.map((key) => ({ kind: "reg-delete" as const, key })),
  ]);
});

function fakeExec(result: (argv: string[]) => ExecResult = () => ({ code: 0, stdout: "", stderr: "" })) {
  const calls: string[][] = [];
  const exec: Exec = (argv) => { calls.push(argv); return result(argv); };
  return { exec, calls };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "anynotate-nh-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("applyHostSteps registers each key with reg add", () => {
  const { exec, calls } = fakeExec();
  const key = browserRegistryKey("edge");
  const log = applyHostSteps([{ kind: "reg-add", key, manifestPath: WIN_MANIFEST }], exec, false);
  expect(calls).toEqual([["reg", "add", key, "/ve", "/t", "REG_SZ", "/d", WIN_MANIFEST, "/f"]]);
  expect(log).toHaveLength(1);
});

test("applyHostSteps dry run runs nothing and writes nothing", () => {
  const { exec, calls } = fakeExec();
  const path = join(dir, "a/b/dev.anynotate.host.json");
  writeFileSync(join(dir, "x.json"), "{}");
  const log = applyHostSteps(
    [
      { kind: "write-manifest", path, json: "{}\n" },
      { kind: "reg-add", key: KEYS[0]!, manifestPath: WIN_MANIFEST },
      { kind: "reg-delete", key: KEYS[1]! },
      { kind: "remove-manifest", path: join(dir, "x.json") },
    ],
    exec,
    true,
  );
  expect(calls).toEqual([]);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(dir, "x.json"))).toBe(true);
  expect(log).toHaveLength(4);
  for (const line of log) expect(line.startsWith("would")).toBe(true);
});

test("applyHostSteps writes a manifest, then reports it ok, then removes it", () => {
  const { exec } = fakeExec();
  const path = join(dir, "a/b/dev.anynotate.host.json");
  expect(applyHostSteps([{ kind: "write-manifest", path, json: "{}\n" }], exec, false)).toEqual([`wrote   ${path}`]);
  expect(readFileSync(path, "utf8")).toBe("{}\n");
  expect(applyHostSteps([{ kind: "write-manifest", path, json: "{}\n" }], exec, false)).toEqual([`ok      ${path}`]);
  expect(applyHostSteps([{ kind: "remove-manifest", path }], exec, true)).toEqual([`would remove ${path}`]);
  expect(applyHostSteps([{ kind: "remove-manifest", path }], exec, false)).toEqual([`removed ${path}`]);
  expect(existsSync(path)).toBe(false);
  expect(applyHostSteps([{ kind: "remove-manifest", path }], exec, false)).toEqual([]);
});

test("reg delete queries the key first and skips a key that is already gone, whatever the message language", () => {
  const { exec, calls } = fakeExec((argv) => ({ code: argv[1] === "query" ? 1 : 0, stdout: "", stderr: "FEHLER: nicht gefunden" }));
  const log = applyHostSteps([{ kind: "reg-delete", key: KEYS[2]! }], exec, false);
  expect(calls).toEqual([["reg", "query", KEYS[2]!]]);
  expect(log).toEqual([`ok      ${KEYS[2]!} (already gone)`]);
});

test("reg delete of a present key deletes it, and any delete failure throws", () => {
  const ok = fakeExec(() => ({ code: 0, stdout: "", stderr: "" }));
  expect(applyHostSteps([{ kind: "reg-delete", key: KEYS[2]! }], ok.exec, false)).toEqual([`unregistered ${KEYS[2]!}`]);
  expect(ok.calls).toEqual([["reg", "query", KEYS[2]!], ["reg", "delete", KEYS[2]!, "/f"]]);
  const bad = fakeExec((argv) => ({ code: argv[1] === "query" ? 0 : 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." }));
  expect(() => applyHostSteps([{ kind: "reg-delete", key: KEYS[2]! }], bad.exec, false)).toThrow(/reg delete/);
});

test("other reg failures throw", () => {
  const { exec } = fakeExec((argv) => ({ code: argv[1] === "query" ? 0 : 1, stdout: "", stderr: "ERROR: Access is denied." }));
  expect(() => applyHostSteps([{ kind: "reg-delete", key: KEYS[0]! }], exec, false)).toThrow(/Access is denied/);
  expect(() => applyHostSteps([{ kind: "reg-add", key: KEYS[0]!, manifestPath: WIN_MANIFEST }], exec, false)).toThrow(/Access is denied/);
});

test("sourceHostWrapper is a sh script on unix and a cmd file on Windows", () => {
  expect(sourceHostWrapper("linux", "/opt/bun/bin/bun", "/home/me/anynotate", "/home/me/.anynotate")).toEqual({
    path: "/home/me/.anynotate/native-host",
    content: `#!/bin/sh\nexec "/opt/bun/bin/bun" "/home/me/anynotate/src/cli.ts" native-host "$@"\n`,
  });
  expect(sourceHostWrapper("win32", "C:\\bun\\bun.exe", "C:\\src\\anynotate", "C:\\Users\\me\\.anynotate")).toEqual({
    path: "C:\\Users\\me\\.anynotate\\native-host.cmd",
    content: `@"C:\\bun\\bun.exe" "C:\\src\\anynotate\\src\\cli.ts" native-host %*\r\n`,
  });
});

test("the Windows wrapper escapes % in paths so cmd does not expand them", () => {
  expect(sourceHostWrapper("win32", "C:\\100%\\bun.exe", "C:\\src\\%USERNAME%", "C:\\Users\\me\\.anynotate").content).toBe(
    `@"C:\\100%%\\bun.exe" "C:\\src\\%%USERNAME%%\\src\\cli.ts" native-host %*\r\n`,
  );
});

const bin = join(import.meta.dir, "../bin/anynotate");

test("the CLI answers as a native host when Chrome passes the origin first", async () => {
  const home = mkdtempSync(join(tmpdir(), "anynotate-"));
  try {
    writeFileSync(join(home, "origins"), `chrome-extension://${ID}\n`);
    const proc = Bun.spawn([bin, ORIGIN, "--parent-window=0"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ANYNOTATE_HOME: home },
    });
    proc.stdin.write(encodeMessage({ type: "token" }));
    await proc.stdin.flush();
    const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    expect(await proc.exited).toBe(0);
    expect(decodeMessage(out)!.value).toEqual({ ok: true, token: readFileSync(join(home, "token"), "utf8").trim() });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the CLI refuses a disallowed origin and creates no token", async () => {
  const home = mkdtempSync(join(tmpdir(), "anynotate-"));
  try {
    writeFileSync(join(home, "origins"), `chrome-extension://${ID}\n`);
    const other = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/";
    const proc = Bun.spawn([bin, other, "--parent-window=0"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ANYNOTATE_HOME: home },
    });
    proc.stdin.write(encodeMessage({ type: "token" }));
    await proc.stdin.flush();
    const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;
    expect(decodeMessage(out)!.value).toEqual({ ok: false, error: "origin not allowed" });
    expect(existsSync(join(home, "token"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
