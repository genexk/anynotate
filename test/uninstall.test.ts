import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { EMBEDDED_ASSETS } from "../src/agent/assets";
import { applyInstall, type InstallOptions, planInstall } from "../src/agent/install";
import type { InstallKind, InstallRecord } from "../src/agent/installkind";
import { applyUninstall, planUninstall, type UninstallOptions, type UninstallStep } from "../src/agent/uninstall";
import type { Exec } from "../src/platform/exec";

// Plans for macOS and Linux build paths with posix.join whatever the host, so the expectations do too.
const { join } = posix;
const isWindows = process.platform === "win32";
// Applying a macOS or Linux install creates symlinks and sets modes, which only a POSIX host can do.
const posixOnly = test.skipIf(isWindows);
const windowsOnly = test.skipIf(!isWindows);
const dirLink = (target: string, path: string) => symlinkSync(target, path, isWindows ? "junction" : undefined);

let home: string;
let calls: { argv: string[]; env?: Record<string, string> }[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anynotate-uninstall-"));
  calls = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const BUN = "/opt/bun/bin/bun";
const REPO = process.cwd();
const src: InstallKind = { kind: "source", repo: REPO, bun: BUN };
const fakeExec: Exec = (argv, _cwd, env) => {
  calls.push(env ? { argv, env } : { argv });
  return { code: 0, stdout: "", stderr: "" };
};
const argvs = () => calls.map((c) => c.argv);

const install = (o: Partial<InstallOptions> = {}) => {
  const platform = o.platform ?? "darwin";
  const steps = planInstall({
    platform,
    home,
    env: {},
    kind: src,
    version: "0.4.0",
    uid: 501,
    hasUserSystemd: false,
    installed: () => true,
    now: new Date("2026-10-01T12:00:00Z"),
    ...o,
  });
  applyInstall(steps, false, { exec: fakeExec, platform });
  calls = [];
};

const record = (kind: InstallKind, platform: InstallRecord["platform"] = "darwin"): InstallRecord => ({
  kind: kind.kind,
  path: kind.kind === "binary" ? kind.exe : kind.repo,
  version: "0.4.0",
  installedAt: "2026-10-01T12:00:00.000Z",
  platform,
});

const plan = (o: Partial<UninstallOptions> = {}) =>
  planUninstall({ platform: "darwin", home, env: {}, record: record(src), kind: src, purge: false, uid: 501, hasUserSystemd: false, ...o });

// ANYNOTATE_HOME only counts when it is absolute for the plan's platform, so plans that set it to a temp dir target
// the host.
const hostPlatform = isWindows ? "win32" : "darwin";
const hostPlan = (o: Partial<UninstallOptions> = {}) => plan({ platform: hostPlatform, record: record(src, hostPlatform), ...o });

const otherHook = { type: "command", command: "say hello" };
const seedSettings = () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ theme: "dark", hooks: { UserPromptSubmit: [{ hooks: [otherHook] }], Stop: [{ hooks: [otherHook] }] } }));
};

posixOnly("uninstall reverses a source install on macOS and keeps the data dir", () => {
  seedSettings();
  install();
  const data = join(home, ".anynotate");
  writeFileSync(join(data, "token"), "secret\n");
  expect(existsSync(join(home, "Library/LaunchAgents/dev.anynotate.bridge.plist"))).toBe(true);

  const log = applyUninstall(plan(), fakeExec, false);

  const claude = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  expect(claude).toEqual({ theme: "dark", hooks: { UserPromptSubmit: [{ hooks: [otherHook] }], Stop: [{ hooks: [otherHook] }] } });
  expect(JSON.parse(readFileSync(join(home, ".codex/hooks.json"), "utf8")).hooks).toEqual({});
  expect(existsSync(join(home, ".claude/skills/annotations"))).toBe(false);
  expect(existsSync(join(home, ".codex/skills/annotations"))).toBe(false);
  expect(existsSync(join(home, ".claude/skills"))).toBe(true);
  expect(existsSync(join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.anynotate.host.json"))).toBe(false);
  expect(existsSync(join(home, "Library/LaunchAgents/dev.anynotate.bridge.plist"))).toBe(false);
  expect(existsSync(join(data, "install.json"))).toBe(false);
  expect(existsSync(join(data, "native-host"))).toBe(false);
  expect(existsSync(join(home, ".local/bin/anynotate"))).toBe(false);
  expect(existsSync(join(data, "token"))).toBe(true);
  expect(existsSync(join(data, "origins"))).toBe(true);
  expect(argvs()).toEqual([["launchctl", "bootout", "gui/501/dev.anynotate.bridge"]]);
  expect(log.at(-1)).toBe(`Anynotate removed. Your notes are still in ${data} (use --purge to delete them).`);
  expect(REPO && existsSync(join(REPO, "bin/anynotate"))).toBe(true);
});

const skillSteps = () => plan().filter((s): s is Extract<UninstallStep, { action: "remove-skill" }> => s.action === "remove-skill");

test("skills are removed only while unchanged, and their dirs only once empty", () => {
  const [claude, codex] = skillSteps();
  expect(claude!.path).toBe(join(home, ".claude/skills/annotations/SKILL.md"));
  expect(codex!.path).toBe(join(home, ".codex/skills/annotations/SKILL.md"));
  expect(claude!.content).toBe(EMBEDDED_ASSETS["assets/skill/SKILL.md"]!);
  expect(claude!.content.length).toBeGreaterThan(0);
  const claudeDir = join(home, ".claude/skills/annotations");
  const codexDir = join(home, ".codex/skills/annotations");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(claude!.path, claude!.content);
  writeFileSync(join(claudeDir, "notes.md"), "mine\n");
  writeFileSync(codex!.path, `${codex!.content}\nmy edit\n`);

  const dry = applyUninstall([claude!, codex!], fakeExec, true);
  expect(dry).toContain(`would remove ${claude!.path}`);
  expect(dry).toContain(`kept ${claudeDir} (not empty)`);
  expect(dry).toContain(`kept ${codex!.path} (modified)`);
  expect(existsSync(claude!.path)).toBe(true);

  const log = applyUninstall([claude!, codex!], fakeExec, false);
  expect(log).toContain(`removed ${claude!.path}`);
  expect(log).toContain(`kept ${claudeDir} (not empty)`);
  expect(log).toContain(`kept ${codex!.path} (modified)`);
  expect(existsSync(claude!.path)).toBe(false);
  expect(readFileSync(join(claudeDir, "notes.md"), "utf8")).toBe("mine\n");
  expect(readFileSync(codex!.path, "utf8")).toBe(`${codex!.content}\nmy edit\n`);

  rmSync(join(claudeDir, "notes.md"));
  writeFileSync(codex!.path, codex!.content);
  expect(applyUninstall([claude!, codex!], fakeExec, true)).toEqual([`would remove ${claudeDir}`, `would remove ${codex!.path}`, `would remove ${codexDir}`, "Dry run: nothing was changed."]);
  expect(applyUninstall([claude!, codex!], fakeExec, false)).toEqual([`removed ${claudeDir}`, `removed ${codex!.path}`, `removed ${codexDir}`]);
  expect(existsSync(claudeDir)).toBe(false);
  expect(existsSync(codexDir)).toBe(false);
  expect(existsSync(join(home, ".codex/skills"))).toBe(true);
  expect(applyUninstall([claude!, codex!], fakeExec, false)).toEqual([]);
});

test("a skill path that is a directory is kept as modified", () => {
  const [claude] = skillSteps();
  mkdirSync(join(claude!.path, "inner"), { recursive: true });
  expect(applyUninstall([claude!], fakeExec, false)).toEqual([`kept ${claude!.path} (modified)`]);
  expect(existsSync(join(claude!.path, "inner"))).toBe(true);
});

test("uninstall removes the legacy bare hook and old absolute paths, nothing else", () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const hooks = [{ hooks: [{ type: "command", command: "anynotate hook --agent claude" }, otherHook] }, { hooks: [{ type: "command", command: "/old/place/anynotate hook --agent claude" }] }];
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: hooks } }));
  applyUninstall(plan(), fakeExec, false);
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks).toEqual({ UserPromptSubmit: [{ hooks: [otherHook] }] });
});

posixOnly("a dry run lists the removals and changes nothing", () => {
  seedSettings();
  install();
  const before = readFileSync(join(home, ".claude/settings.json"), "utf8");
  const log = applyUninstall(plan({ purge: true }), fakeExec, true);
  expect(calls).toEqual([]);
  expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe(before);
  expect(existsSync(join(home, ".claude/skills/annotations/SKILL.md"))).toBe(true);
  expect(existsSync(join(home, "Library/LaunchAgents/dev.anynotate.bridge.plist"))).toBe(true);
  expect(existsSync(join(home, ".anynotate/install.json"))).toBe(true);
  expect(existsSync(join(home, ".local/bin/anynotate"))).toBe(true);
  expect(log).toContain("would run: launchctl bootout gui/501/dev.anynotate.bridge");
  expect(log).toContain(`would remove ${join(home, ".anynotate/install.json")}`);
  expect(log.at(-1)).toBe("Dry run: nothing was changed.");
});

posixOnly("--purge deletes the data dir when it holds a token", () => {
  install();
  writeFileSync(join(home, ".anynotate/token"), "secret\n");
  const log = applyUninstall(plan({ purge: true }), fakeExec, false);
  expect(existsSync(join(home, ".anynotate"))).toBe(false);
  expect(log.at(-1)).toBe(`Anynotate removed, including ${join(home, ".anynotate")}.`);
});

posixOnly("--purge follows ANYNOTATE_HOME", () => {
  const data = join(home, "elsewhere");
  install({ env: { ANYNOTATE_HOME: data } });
  writeFileSync(join(data, "token"), "secret\n");
  applyUninstall(plan({ env: { ANYNOTATE_HOME: data }, purge: true }), fakeExec, false);
  expect(existsSync(data)).toBe(false);
  expect(existsSync(home)).toBe(true);
});

posixOnly("--purge refuses a data dir without a token", () => {
  install();
  const log = applyUninstall(plan({ purge: true }), fakeExec, false);
  expect(existsSync(join(home, ".anynotate/origins"))).toBe(true);
  expect(log.some((l) => l.startsWith(`refused to delete ${join(home, ".anynotate")}`) && l.includes("no token"))).toBe(true);
  expect(log.at(-1)).toBe(`Anynotate removed. ${join(home, ".anynotate")} was left in place (see above).`);
});

test("--purge refuses a data dir that is a symlink and leaves its target alone", () => {
  const real = join(home, "real");
  mkdirSync(real);
  writeFileSync(join(real, "token"), "secret\n");
  dirLink(real, join(home, ".anynotate"));
  const log = applyUninstall(plan({ purge: true }), fakeExec, false);
  expect(existsSync(join(real, "token"))).toBe(true);
  expect(lstatSync(join(home, ".anynotate")).isSymbolicLink()).toBe(true);
  expect(log.some((l) => l.startsWith("refused to delete") && l.includes("symlink"))).toBe(true);
});

test("--purge refuses the home directory itself", () => {
  writeFileSync(join(home, "token"), "x");
  const log = applyUninstall(hostPlan({ env: { ANYNOTATE_HOME: home }, purge: true }), fakeExec, false);
  expect(existsSync(join(home, "token"))).toBe(true);
  expect(log.some((l) => l.startsWith(`refused to delete ${home}: `) && l.includes("home"))).toBe(true);
});

posixOnly("uninstall is idempotent: a second run, or one with nothing installed, succeeds", () => {
  install();
  applyUninstall(plan(), fakeExec, false);
  const failing: Exec = (argv) => ({ code: 5, stdout: "", stderr: "Boot-out failed: 3: No such process" });
  const log = applyUninstall(plan(), failing, false);
  expect(log.some((l) => l.startsWith("failed"))).toBe(false);
  expect(log.at(-1)).toContain("Anynotate removed.");
  expect(existsSync(join(home, ".claude"))).toBe(true);
});

posixOnly("a bin symlink that points outside the clone, or a regular file, is left alone", () => {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync("/somewhere/else/anynotate", join(home, ".local/bin/anynotate"));
  const log = applyUninstall(plan(), fakeExec, false);
  expect(lstatSync(join(home, ".local/bin/anynotate")).isSymbolicLink()).toBe(true);
  expect(log.some((l) => l.startsWith(`skip    ${join(home, ".local/bin/anynotate")}`))).toBe(true);
  rmSync(join(home, ".local/bin/anynotate"));
  writeFileSync(join(home, ".local/bin/anynotate"), "#!/bin/sh\n");
  applyUninstall(plan(), fakeExec, false);
  expect(existsSync(join(home, ".local/bin/anynotate"))).toBe(true);
});

posixOnly("a Linux binary install with user systemd: unit disabled and removed, binary deleted", () => {
  const exe = join(home, ".local/bin/anynotate");
  const bin: InstallKind = { kind: "binary", exe };
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(exe, "ELF");
  install({ platform: "linux", kind: bin, hasUserSystemd: true });
  const unit = join(home, ".config/systemd/user/anynotate-bridge.service");
  expect(existsSync(unit)).toBe(true);
  applyUninstall(plan({ platform: "linux", kind: bin, record: record(bin, "linux"), hasUserSystemd: true }), fakeExec, false);
  expect(existsSync(unit)).toBe(false);
  expect(existsSync(exe)).toBe(false);
  expect(existsSync(join(home, ".config/google-chrome/NativeMessagingHosts/dev.anynotate.host.json"))).toBe(false);
  expect(argvs()).toEqual([
    ["systemctl", "--user", "disable", "--now", "anynotate-bridge.service"],
    [exe, "bridge", "--stop"],
    ["systemctl", "--user", "daemon-reload"],
  ]);
});

test("on Linux both the systemd unit and the autostart entry are removed whichever is in use", () => {
  const paths = plan({ platform: "linux", hasUserSystemd: false }).filter((s) => s.action === "remove-file").map((s) => s.path.replace(home, "~"));
  expect(paths).toContain("~/.config/systemd/user/anynotate-bridge.service");
  expect(paths).toContain("~/.config/autostart/anynotate-bridge.desktop");
});

test("the binary named by install.json is the one removed, and only if it is called anynotate", () => {
  const bin: InstallKind = { kind: "binary", exe: "/usr/bin/bun" };
  const steps = plan({ kind: bin, record: { ...record(bin), path: "/opt/tools/anynotate" } });
  expect(steps.find((s) => s.action === "remove-binary")!.path).toBe("/opt/tools/anynotate");
  const odd = plan({ kind: bin, record: { ...record(bin), path: "/usr/bin/bun" } });
  expect(odd.some((s) => s.action === "remove-binary")).toBe(false);
});

const WIN_HOME = "C:\\Users\\me";
const WIN_EXE = "C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe";
const winBin: InstallKind = { kind: "binary", exe: WIN_EXE };
const winPlan = (o: Partial<UninstallOptions> = {}) =>
  planUninstall({ platform: "win32", home: WIN_HOME, env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", SystemRoot: "C:\\Windows" }, record: record(winBin, "win32"), kind: winBin, purge: false, uid: 0, hasUserSystemd: false, ...o });

test("a Windows plan stops the bridge, deletes the Run value and every browser key, then renames the binary and drops the PATH entry", () => {
  const steps = winPlan();
  const run = steps.filter((s): s is Extract<UninstallStep, { action: "run" }> => s.action === "run").flatMap((s) => s.argv);
  expect(run).toEqual([
    [WIN_EXE, "bridge", "--stop"],
    ["reg", "delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Anynotate Bridge", "/f"],
  ]);
  expect(steps.filter((s) => s.action === "native-host").map((s) => s.path)).toEqual([
    "C:\\Users\\me\\.anynotate\\dev.anynotate.host.json",
    "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.anynotate.host",
    "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\dev.anynotate.host",
    "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\dev.anynotate.host",
    "HKCU\\Software\\Chromium\\NativeMessagingHosts\\dev.anynotate.host",
  ]);
  expect(steps.filter((s) => s.action === "remove-file").map((s) => s.path)).toEqual(["C:\\Users\\me\\.anynotate\\bridge.vbs", "C:\\Users\\me\\.anynotate\\install.json"]);
  const rename = steps.find((s) => s.action === "rename-binary")!;
  expect(rename).toEqual({ action: "rename-binary", path: WIN_EXE, to: `${WIN_EXE}.old` });
  const pathStep = steps.find((s) => s.action === "remove-path-entry")!;
  expect(pathStep).toMatchObject({ action: "remove-path-entry", path: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin" });
  expect(steps.findIndex((s) => s.action === "remove-path-entry")).toBeGreaterThan(steps.findIndex((s) => s.action === "rename-binary"));
});

test("the PATH entry is removed by PowerShell reading the directory from an environment variable", () => {
  const step = winPlan().find((s) => s.action === "remove-path-entry")!;
  const log = applyUninstall([step], fakeExec, false);
  expect(calls).toHaveLength(1);
  const { argv, env } = calls[0]!;
  expect(argv.slice(0, 4)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-Command"]);
  expect(argv[4]).toContain("$env:ANYNOTATE_BIN_DIR");
  expect(argv[4]).toContain("(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')");
  expect(argv[4]).toContain("Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value ($kept -join ';') -Type ExpandString");
  expect(argv[4]).toContain("[Environment]::SetEnvironmentVariable('ANYNOTATE_TMP', $null, 'User')");
  expect(argv[4]).not.toContain("[Environment]::SetEnvironmentVariable('Path'");
  expect(argv[4]).not.toContain("GetEnvironmentVariable");
  expect(argv[4]).not.toContain("C:\\Users");
  expect(env).toEqual({ ANYNOTATE_BIN_DIR: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin" });
  expect(log).toEqual(["removed C:\\Users\\me\\AppData\\Local\\anynotate\\bin from the user PATH"]);
});

test("a running Windows binary is renamed to .old, replacing an earlier .old", () => {
  const exe = join(home, "anynotate.exe");
  writeFileSync(exe, "new");
  writeFileSync(`${exe}.old`, "older");
  const log = applyUninstall([{ action: "rename-binary", path: exe, to: `${exe}.old` }], fakeExec, false);
  expect(existsSync(exe)).toBe(false);
  expect(readFileSync(`${exe}.old`, "utf8")).toBe("new");
  expect(log[0]).toContain(`renamed ${exe} → ${exe}.old`);
  expect(applyUninstall([{ action: "rename-binary", path: exe, to: `${exe}.old` }], fakeExec, false)).toEqual([]);
});

test("a Windows source install removes its .cmd shim, the bin dir's PATH entry and host wrapper, never the clone", () => {
  const kind: InstallKind = { kind: "source", repo: "C:\\src\\anynotate", bun: "C:\\bun\\bun.exe" };
  const steps = winPlan({ kind, record: record(kind, "win32") });
  expect(steps.some((s) => s.action === "rename-binary")).toBe(false);
  expect(steps.filter((s) => s.action === "remove-path-entry")).toEqual([{ action: "remove-path-entry", path: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin" }]);
  expect(steps.findIndex((s) => s.action === "remove-path-entry")).toBeGreaterThan(steps.findIndex((s) => s.action === "remove-shim"));
  const files = steps.filter((s) => s.action === "remove-file" || s.action === "remove-shim").map((s) => s.path);
  expect(files).toContain("C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.cmd");
  expect(files).toContain("C:\\Users\\me\\.anynotate\\native-host.cmd");
  expect(files.some((p) => p.startsWith("C:\\src"))).toBe(false);
});

test("a .cmd shim the user changed is left alone", () => {
  const shim = join(home, "anynotate.cmd");
  writeFileSync(shim, "@echo mine\r\n");
  const log = applyUninstall([{ action: "remove-shim", path: shim, content: "@expected\r\n" }], fakeExec, false);
  expect(existsSync(shim)).toBe(true);
  expect(log[0]).toContain("left alone");
});

test("a Windows binary outside the managed bin dir is renamed but the PATH is left alone", () => {
  const exe = "C:\\Tools\\anynotate.exe";
  const kind: InstallKind = { kind: "binary", exe };
  const steps = winPlan({ kind, record: record(kind, "win32") });
  expect(steps.some((s) => s.action === "rename-binary")).toBe(true);
  expect(steps.some((s) => s.action === "remove-path-entry")).toBe(false);
  const variant: InstallKind = { kind: "binary", exe: "c:\\users\\ME\\appdata\\local\\Anynotate\\BIN\\anynotate.exe" };
  expect(winPlan({ kind: variant, record: record(variant, "win32") }).some((s) => s.action === "remove-path-entry")).toBe(true);
});

test("--purge refuses a filesystem root", () => {
  const log = applyUninstall(plan({ env: { ANYNOTATE_HOME: "/" }, purge: true }), fakeExec, true);
  expect(log.some((l) => l.startsWith("refused to delete /:") && l.includes("home"))).toBe(true);
});

test("--purge refuses an ancestor of home even when it holds a token", () => {
  const user = join(home, "users", "me");
  mkdirSync(user, { recursive: true });
  writeFileSync(join(home, "users", "token"), "x");
  const log = applyUninstall(hostPlan({ home: user, env: { ANYNOTATE_HOME: join(home, "users") }, purge: true }), fakeExec, false);
  expect(existsSync(join(home, "users", "token"))).toBe(true);
  expect(log.some((l) => l.startsWith(`refused to delete ${join(home, "users")}: `) && l.includes("home"))).toBe(true);
});

test("--purge refuses home reached through another path", () => {
  const real = join(home, "real");
  mkdirSync(real);
  writeFileSync(join(real, "token"), "x");
  const link = join(home, "link");
  dirLink(real, link);
  const log = applyUninstall(hostPlan({ home: link, env: { ANYNOTATE_HOME: real }, purge: true }), fakeExec, false);
  expect(existsSync(join(real, "token"))).toBe(true);
  expect(log.some((l) => l.startsWith(`refused to delete ${real}: `) && l.includes("home"))).toBe(true);
});

posixOnly("--purge refuses a custom data dir holding anything anynotate didn't write", () => {
  const data = join(home, "elsewhere");
  install({ env: { ANYNOTATE_HOME: data } });
  writeFileSync(join(data, "token"), "secret\n");
  writeFileSync(join(data, "thesis.docx"), "mine");
  const log = applyUninstall(plan({ env: { ANYNOTATE_HOME: data }, purge: true }), fakeExec, false);
  expect(existsSync(join(data, "thesis.docx"))).toBe(true);
  expect(log.some((l) => l.startsWith(`refused to delete ${data}`) && l.includes("thesis.docx"))).toBe(true);
});

test("--purge accepts a custom data dir with only anynotate's files, including temp and backup leftovers", () => {
  const data = join(home, "elsewhere");
  mkdirSync(join(data, "inbox"), { recursive: true });
  for (const f of ["token", "settings.json", "bridge.log", "bridge.pid", "origins", "token.tmp-1-abc", "bridge.vbs.bak-anynotate"]) writeFileSync(join(data, f), "x");
  const log = applyUninstall(hostPlan({ env: { ANYNOTATE_HOME: data }, purge: true }), fakeExec, false);
  expect(log.filter((l) => l.startsWith("failed") || l.startsWith("refused"))).toEqual([]);
  expect(existsSync(data)).toBe(false);
});

posixOnly("uninstall backs settings up under its own suffix, leaving install's backup alone", () => {
  seedSettings();
  install();
  writeFileSync(join(home, ".claude/settings.json.bak-anynotate"), "install's backup");
  applyUninstall(plan(), fakeExec, false);
  expect(readFileSync(join(home, ".claude/settings.json.bak-anynotate"), "utf8")).toBe("install's backup");
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json.bak-anynotate-uninstall"), "utf8")).hooks.UserPromptSubmit).toHaveLength(2);
});

test("--purge deletes an ordinary data dir holding a token, on any host", () => {
  const data = join(home, ".anynotate");
  mkdirSync(join(data, "inbox"), { recursive: true });
  writeFileSync(join(data, "token"), "secret\n");
  const log = applyUninstall(plan({ purge: true }), fakeExec, false);
  expect(existsSync(data)).toBe(false);
  expect(log.at(-1)).toBe(`Anynotate removed, including ${data}.`);
});

test("--purge deletes a data dir whose inbox/latest links a bundle, on any host", () => {
  const data = join(home, ".anynotate");
  const bundle = join(data, "inbox", "2026-10-01T120000-abcd");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "README.md"), "notes\n");
  writeFileSync(join(data, "token"), "secret\n");
  dirLink(bundle, join(data, "inbox", "latest"));
  const log = applyUninstall(plan({ purge: true }), fakeExec, false);
  expect(log.filter((l) => l.startsWith("failed") || l.startsWith("refused"))).toEqual([]);
  expect(existsSync(data)).toBe(false);
});

windowsOnly("on Windows, uninstall reverses a source install and --purge deletes the data dir", () => {
  const env = { LOCALAPPDATA: win32.join(home, "AppData", "Local") };
  const kind: InstallKind = { kind: "source", repo: process.cwd(), bun: process.execPath };
  seedSettings();
  const seeded = JSON.parse(readFileSync(win32.join(home, ".claude", "settings.json"), "utf8"));
  install({ platform: "win32", env, kind });
  const data = win32.join(home, ".anynotate");
  const shim = win32.join(env.LOCALAPPDATA, "anynotate", "bin", "anynotate.cmd");
  writeFileSync(win32.join(data, "token"), "secret\n");
  expect(existsSync(shim)).toBe(true);
  expect(existsSync(win32.join(data, "install.json"))).toBe(true);

  const steps = planUninstall({ platform: "win32", home, env, record: record(kind, "win32"), kind, purge: true, uid: 0, hasUserSystemd: false });
  const log = applyUninstall(steps, fakeExec, false);
  expect(log.filter((l) => l.startsWith("failed") || l.startsWith("refused"))).toEqual([]);
  expect(existsSync(shim)).toBe(false);
  expect(existsSync(data)).toBe(false);
  expect(JSON.parse(readFileSync(win32.join(home, ".claude", "settings.json"), "utf8"))).toEqual(seeded);
  expect(argvs().some((a) => a[0] === "reg" && a[1] === "delete")).toBe(true);
  expect(log.at(-1)).toBe(`Anynotate removed, including ${data}.`);
});
