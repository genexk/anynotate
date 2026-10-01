import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { type Check, type DoctorOptions, formatChecks, runDoctor } from "../src/agent/doctor";
import type { Exec } from "../src/platform/exec";
import { browserConfigRoot, browserRegistryKey } from "../src/platform/os";

const HEALTH = { bridgeVersion: "0.4.0", protocol: { version: 2 } };
const TOKEN = `${"a".repeat(64)}\n`;
const EXE = "/home/me/.local/bin/anynotate";
const hook = (cmd: string) => JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd }] }] } });
const manifest = (path: string) => JSON.stringify({ name: "dev.anynotate.host", path, type: "stdio", allowed_origins: ["chrome-extension://abc/"] });
const record = (path: string, platform = "linux") =>
  JSON.stringify({ kind: "binary", path, version: "0.4.0", installedAt: "2026-10-01T00:00:00.000Z", platform });

type Fake = { files: Record<string, string>; dirs: string[]; ran: string[][]; exit: (argv: string[]) => number; health: typeof HEALTH | null };

function linuxFake(): Fake {
  const chrome = browserConfigRoot("linux", "chrome", "/home/me", {});
  return {
    files: {
      "/home/me/.anynotate/install.json": record(EXE),
      "/home/me/.anynotate/token": `${"a".repeat(64)}\n`,
      [EXE]: "",
      "/home/me/.config/systemd/user/anynotate-bridge.service": "[Unit]\n",
      [posix.join(chrome, "NativeMessagingHosts", "dev.anynotate.host.json")]: manifest(EXE),
      "/home/me/.claude/settings.json": hook(`${EXE} hook --agent claude`),
    },
    dirs: [chrome, "/home/me/.claude"],
    ran: [],
    exit: () => 0,
    health: HEALTH,
  };
}

const options = (f: Fake, platform: DoctorOptions["platform"] = "linux", home = "/home/me"): DoctorOptions => ({
  platform,
  home,
  env: {},
  uid: 501,
  version: "0.4.0",
  exec: ((argv) => {
    f.ran.push(argv);
    const code = f.exit(argv);
    return { code, stdout: "", stderr: "" };
  }) as Exec,
  fetchHealth: async () => f.health,
  exists: (p) => p in f.files || f.dirs.includes(p),
  readFile: (p) => {
    if (!(p in f.files)) throw new Error(`ENOENT ${p}`);
    return f.files[p]!;
  },
  isExecutable: (p) => p in f.files,
  isPrivate: () => true,
  which: (cmd) => (cmd === "anynotate" ? EXE : null),
  retention: () => ({ days: 30, source: "default" }),
});

const byName = (checks: Check[], name: string) => checks.find((c) => c.name === name);

test("a healthy Linux install passes every check and exits 0", async () => {
  const f = linuxFake();
  const checks = await runDoctor(options(f));
  expect(checks.filter((c) => c.ok !== true)).toEqual([]);
  expect(checks.map((c) => c.name)).toEqual(["install", "on PATH", "service", "bridge", "token", "native host (chrome)", "hooks (claude)", "hooks (codex)", "retention"]);
  expect(byName(checks, "service")!.detail).toContain("enabled");
  expect(f.ran).toContainEqual(["systemctl", "--user", "is-enabled", "anynotate-bridge.service"]);
  const { text, code } = formatChecks(checks);
  expect(code).toBe(0);
  expect(text.split("\n")[0]).toBe(`✓ install  binary 0.4.0 at ${EXE}`);
  expect(text.trimEnd().split("\n").at(-1)).toBe("All checks passed.");
});

test("bridge down fails the bridge check and exits 1", async () => {
  const f = linuxFake();
  f.health = null;
  const checks = await runDoctor(options(f));
  expect(byName(checks, "bridge")!.ok).toBe(false);
  const { text, code } = formatChecks(checks);
  expect(code).toBe(1);
  expect(text).toMatch(/^✗ bridge  not answering on http:\/\/127\.0\.0\.1:\d+\/health/m);
  expect(text.trimEnd().split("\n").at(-1)).toBe("1 failed — see above.");
});

test("a present browser without a registration is a warning only; an absent one is not checked", async () => {
  const f = linuxFake();
  f.dirs.push(browserConfigRoot("linux", "edge", "/home/me", {}));
  const checks = await runDoctor(options(f));
  expect(byName(checks, "native host (edge)")).toMatchObject({ ok: "warn" });
  expect(byName(checks, "native host (brave)")).toBeUndefined();
  const { text, code } = formatChecks(checks);
  expect(code).toBe(0);
  expect(text).toMatch(/^! native host \(edge\)  /m);
  expect(text.trimEnd().split("\n").at(-1)).toBe("1 warning(s) — see above.");
});

test("a missing Chrome manifest or a host path that isn't executable fails", async () => {
  const f = linuxFake();
  const chromeManifest = posix.join(browserConfigRoot("linux", "chrome", "/home/me", {}), "NativeMessagingHosts", "dev.anynotate.host.json");
  f.files[chromeManifest] = manifest("/home/me/gone");
  expect(byName(await runDoctor(options(f)), "native host (chrome)")).toMatchObject({ ok: false });
  delete f.files[chromeManifest];
  expect(byName(await runDoctor(options(f)), "native host (chrome)")).toMatchObject({ ok: false, detail: expect.stringContaining("no manifest") });
});

test("missing install record, service and token are required failures", async () => {
  const f = linuxFake();
  delete f.files["/home/me/.anynotate/install.json"];
  delete f.files["/home/me/.anynotate/token"];
  delete f.files["/home/me/.config/systemd/user/anynotate-bridge.service"];
  const checks = await runDoctor(options(f));
  for (const name of ["install", "service", "token"]) expect(byName(checks, name)!.ok).toBe(false);
});

test("a systemd unit that is not enabled fails; an autostart entry counts as installed", async () => {
  const f = linuxFake();
  f.exit = (argv) => (argv[2] === "is-enabled" ? 1 : 0);
  expect(byName(await runDoctor(options(f)), "service")!.ok).toBe(false);
  delete f.files["/home/me/.config/systemd/user/anynotate-bridge.service"];
  f.files["/home/me/.config/autostart/anynotate-bridge.desktop"] = "[Desktop Entry]\n";
  expect(byName(await runDoctor(options(f)), "service")).toMatchObject({ ok: true, detail: expect.stringContaining("autostart") });
});

test("hooks: a missing hook or a hook whose executable is gone warns; an absent agent is skipped", async () => {
  const f = linuxFake();
  f.files["/home/me/.claude/settings.json"] = hook("/opt/old/anynotate hook --agent claude");
  let checks = await runDoctor(options(f));
  expect(byName(checks, "hooks (claude)")).toMatchObject({ ok: "warn", detail: expect.stringContaining("/opt/old/anynotate") });
  expect(byName(checks, "hooks (codex)")).toMatchObject({ ok: true, detail: "codex not installed (skipped)" });
  f.files["/home/me/.claude/settings.json"] = hook("echo hi");
  checks = await runDoctor(options(f));
  expect(byName(checks, "hooks (claude)")).toMatchObject({ ok: "warn", detail: expect.stringContaining("no anynotate hook") });
});

test("token readable by others warns; unknown privacy is informational", async () => {
  const f = linuxFake();
  expect(byName(await runDoctor({ ...options(f), isPrivate: () => false }), "token")!.ok).toBe("warn");
  expect(byName(await runDoctor({ ...options(f), isPrivate: () => "unknown" }), "token")!.ok).toBe(true);
});

test("an older bridge version warns and a different protocol fails", async () => {
  const f = linuxFake();
  f.health = { bridgeVersion: "0.3.0", protocol: { version: 2 } };
  expect(byName(await runDoctor(options(f)), "bridge")!.ok).toBe("warn");
  f.health = { bridgeVersion: "0.4.0", protocol: { version: 1 } };
  expect(byName(await runDoctor(options(f)), "bridge")!.ok).toBe(false);
});

test("macOS: the service needs the plist and a loaded launchd job", async () => {
  const home = "/Users/me";
  const exe = `${home}/.local/bin/anynotate`;
  const chrome = browserConfigRoot("darwin", "chrome", home, {});
  const f: Fake = {
    files: {
      [`${home}/.anynotate/install.json`]: record(exe, "darwin"),
      [`${home}/.anynotate/token`]: TOKEN,
      [exe]: "",
      [`${home}/Library/LaunchAgents/dev.anynotate.bridge.plist`]: "<plist/>",
      [posix.join(chrome, "NativeMessagingHosts", "dev.anynotate.host.json")]: manifest(exe),
    },
    dirs: [chrome],
    ran: [],
    exit: () => 0,
    health: HEALTH,
  };
  const o = { ...options(f, "darwin", home), which: () => exe };
  expect(byName(await runDoctor(o), "service")).toMatchObject({ ok: true, detail: expect.stringContaining("loaded") });
  expect(f.ran).toContainEqual(["launchctl", "print", "gui/501/dev.anynotate.bridge"]);
  f.exit = () => 113;
  expect(byName(await runDoctor(o), "service")!.ok).toBe(false);
});

test("Windows: Run value and registry keys that point at the manifest", async () => {
  const home = "C:\\Users\\me";
  const env = { LOCALAPPDATA: `${home}\\AppData\\Local` };
  const data = `${home}\\.anynotate`;
  const exe = `${env.LOCALAPPDATA}\\anynotate\\bin\\anynotate.exe`;
  const mf = win32.join(data, "dev.anynotate.host.json");
  const f: Fake = {
    files: {
      [`${data}\\install.json`]: record(exe, "win32"),
      [`${data}\\token`]: TOKEN,
      [`${data}\\bridge.vbs`]: "x",
      [exe]: "",
      [mf]: manifest(exe),
    },
    dirs: [browserConfigRoot("win32", "chrome", home, env), browserConfigRoot("win32", "edge", home, env)],
    ran: [],
    exit: () => 0,
    health: HEALTH,
  };
  const regOut = (key: string) => `\r\n${key}\r\n    (Default)    REG_SZ    ${mf}\r\n`;
  const edgeKey = browserRegistryKey("edge");
  const o: DoctorOptions = {
    ...options(f, "win32", home),
    env,
    isPrivate: () => "unknown",
    which: () => exe,
    exec: (argv) => {
      f.ran.push(argv);
      if (argv[1] === "query" && argv[2] === edgeKey) return { code: 1, stdout: "", stderr: "ERROR: unable to find" };
      if (argv[1] === "query" && argv.includes("/ve")) return { code: 0, stdout: regOut(argv[2]!), stderr: "" };
      if (argv[1] === "query") return { code: 0, stdout: `    Anynotate Bridge    REG_SZ    "C:\\Windows\\System32\\wscript.exe" "${data}\\bridge.vbs"\r\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const checks = await runDoctor(o);
  expect(byName(checks, "service")).toMatchObject({ ok: true, detail: `Run value "Anynotate Bridge" starts ${data}\\bridge.vbs` });
  expect(f.ran).toContainEqual(["reg", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Anynotate Bridge"]);
  expect(byName(checks, "native host (chrome)")).toMatchObject({ ok: true });
  expect(byName(checks, "native host (edge)")).toMatchObject({ ok: "warn", detail: expect.stringContaining("not registered (exit 1: ERROR: unable to find)") });
  expect(byName(checks, "token")).toMatchObject({ ok: true });
});

test("external dry run skips every external command", async () => {
  const f = linuxFake();
  const checks = await runDoctor({ ...options(f), externalDryRun: true });
  expect(f.ran).toEqual([]);
  expect(byName(checks, "service")).toMatchObject({ ok: "warn", detail: "skipped (dry run)" });
});

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-doctor-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const cli = async (args: string[]) => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: {
      ...process.env,
      ANYNOTATE_HOME: join(home, "data"),
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"),
      ANYNOTATE_EXTERNAL_DRYRUN: "1",
      ANYNOTATE_PORT: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
};

test("CLI doctor prints one line per check and a summary, skips the service under a dry run and fails with no bridge", async () => {
  expect((await cli(["install"])).code).toBe(0);
  const { code, out } = await cli(["doctor"]);
  expect(code).toBe(1);
  const lines = out.trimEnd().split("\n");
  for (const line of lines.slice(0, -1)) expect(line).toMatch(/^[✓✗!] \S.*?  \S/);
  expect(lines).toContain("! service  skipped (dry run)");
  expect(lines.some((l) => l.startsWith("✓ install  source "))).toBe(true);
  expect(lines.some((l) => l.startsWith("✗ bridge  not answering on http://127.0.0.1:1/health"))).toBe(true);
  expect(lines.at(-1)).toMatch(/^\d+ failed(, \d+ warning\(s\))?, \d+ skipped — see above\.$/);
});

test("Windows with a non-ASCII profile: a reg value that doesn't match as printed warns, never fails", async () => {
  const home = "C:\\Users\\Jürgen";
  const env = { LOCALAPPDATA: `${home}\\AppData\\Local` };
  const data = `${home}\\.anynotate`;
  const exe = `${env.LOCALAPPDATA}\\anynotate\\bin\\anynotate.exe`;
  const mf = win32.join(data, "dev.anynotate.host.json");
  const f: Fake = {
    files: { [`${data}\\install.json`]: record(exe, "win32"), [`${data}\\token`]: TOKEN, [`${data}\\bridge.vbs`]: "x", [exe]: "", [mf]: manifest(exe) },
    dirs: [],
    ran: [],
    exit: () => 0,
    health: HEALTH,
  };
  const garbled = (s: string) => s.replace("ü", "\u0081");
  const o: DoctorOptions = {
    ...options(f, "win32", home),
    env,
    isPrivate: () => "unknown",
    which: () => exe,
    exec: (argv) =>
      argv.includes("/ve")
        ? { code: 0, stdout: `\r\n${argv[2]}\r\n    (Default)    REG_SZ    ${garbled(mf)}\r\n`, stderr: "" }
        : { code: 0, stdout: `    Anynotate Bridge    REG_SZ    "wscript.exe" "${garbled(`${data}\\bridge.vbs`)}"\r\n`, stderr: "" },
  };
  const checks = await runDoctor(o);
  expect(byName(checks, "native host (chrome)")).toMatchObject({ ok: "warn", detail: expect.stringContaining(garbled(mf)) });
  expect(byName(checks, "service")).toMatchObject({ ok: true, detail: 'Run value "Anynotate Bridge" present' });
  expect(formatChecks(checks).code).toBe(0);
});

test("Windows with an ASCII path: a registry key pointing elsewhere fails for Chrome and the Run value warns", async () => {
  const home = "C:\\Users\\me";
  const data = `${home}\\.anynotate`;
  const exe = `${home}\\AppData\\Local\\anynotate\\bin\\anynotate.exe`;
  const mf = win32.join(data, "dev.anynotate.host.json");
  const f: Fake = {
    files: { [`${data}\\install.json`]: record(exe, "win32"), [`${data}\\token`]: TOKEN, [`${data}\\bridge.vbs`]: "x", [exe]: "", [mf]: manifest(exe) },
    dirs: [],
    ran: [],
    exit: () => 0,
    health: HEALTH,
  };
  const o: DoctorOptions = {
    ...options(f, "win32", home),
    isPrivate: () => "unknown",
    which: () => exe,
    exec: () => ({ code: 0, stdout: "    x    REG_SZ    C:\\elsewhere\\x.json\r\n", stderr: "" }),
  };
  const checks = await runDoctor(o);
  expect(byName(checks, "native host (chrome)")).toMatchObject({ ok: false, detail: expect.stringContaining("C:\\elsewhere\\x.json") });
  expect(byName(checks, "service")).toMatchObject({ ok: "warn" });
});

test("a failed external check carries its exit code and first stderr line", async () => {
  const f = linuxFake();
  const o = { ...options(f), exec: (() => ({ code: 3, stdout: "", stderr: "\nunit disabled\nmore\n" })) as Exec };
  expect(byName(await runDoctor(o), "service")!.detail).toContain("(exit 3: unit disabled)");
});

test("PATH finding a different anynotate than the installed binary warns", async () => {
  const f = linuxFake();
  const checks = await runDoctor({ ...options(f), which: (cmd) => (cmd === "anynotate" ? "/usr/local/bin/anynotate" : null) });
  expect(byName(checks, "on PATH")).toMatchObject({ ok: "warn", detail: `/usr/local/bin/anynotate runs, but the install is ${EXE}` });
});

test("the summary lists only the non-zero counts", () => {
  const c = (ok: Check["ok"], skipped?: true): Check => ({ name: "x", ok, detail: "d", ...(skipped ? { skipped } : {}) });
  const last = (checks: Check[]) => formatChecks(checks).text.trimEnd().split("\n").at(-1);
  expect(last([c(true)])).toBe("All checks passed.");
  expect(last([c(false), c(false), c("warn"), c("warn", true)])).toBe("2 failed, 1 warning(s), 1 skipped — see above.");
  expect(last([c(true), c("warn", true)])).toBe("1 skipped — see above.");
  expect(formatChecks([c("warn"), c("warn", true)]).code).toBe(0);
});
