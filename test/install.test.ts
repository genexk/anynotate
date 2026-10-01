import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const ALL = () => true;
import { posix, win32 } from "node:path";
import { addHook, applyInstall, extensionOrigins, isAnynotateHook, type InstallOptions, type InstallStep, planInstall } from "../src/agent/install";
import type { InstallKind } from "../src/agent/installkind";
import type { Exec } from "../src/platform/exec";

// Plans for macOS and Linux build paths with posix.join whatever the host, so the expectations do too.
const { join } = posix;
const isWindows = process.platform === "win32";
// Applying a macOS or Linux plan creates symlinks and sets modes, which only a POSIX host can do.
const posixOnly = test.skipIf(isWindows);
const windowsOnly = test.skipIf(!isWindows);

let home: string;
let calls: string[][];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anynotate-home-"));
  calls = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const BUN = "/opt/bun/bin/bun";
const REPO = process.cwd().replaceAll("\\", "/");
const LAUNCHER = join(REPO, "bin/anynotate");
const src = (repo = REPO): InstallKind => ({ kind: "source", repo, bun: BUN });
const CMD = (agent: string, repo = REPO) => `${BUN} ${repo}/src/cli.ts hook --agent ${agent}`;
const fakeExec: Exec = (argv) => {
  calls.push(argv);
  return { code: 0, stdout: "", stderr: "" };
};
const planFor = (o: Partial<InstallOptions> = {}) =>
  planInstall({
    platform: "darwin",
    home,
    env: {},
    kind: src(),
    version: "0.4.0",
    uid: 501,
    hasUserSystemd: false,
    installed: ALL,
    now: new Date("2026-10-01T12:00:00Z"),
    ...o,
  });
const apply = (steps: InstallStep[], dry: boolean) => applyInstall(steps, dry, { exec: fakeExec, platform: "darwin" });

test("addHook appends once and preserves existing hooks", () => {
  const existing = { model: "x", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other" }] }] } };
  const r1 = addHook(existing, "UserPromptSubmit", "anynotate hook --agent claude");
  expect(r1.changed).toBe(true);
  expect(r1.config.model).toBe("x");
  expect(r1.config.hooks.UserPromptSubmit).toHaveLength(2);
  const r2 = addHook(r1.config, "UserPromptSubmit", "anynotate hook --agent claude");
  expect(r2.changed).toBe(false);
  expect(addHook({}, "BeforeAgent", "c").config).toEqual({ hooks: { BeforeAgent: [{ hooks: [{ type: "command", command: "c" }] }] } });
});


test("planInstall targets Claude and Codex when installed, the Gemini cleanup, launchd and the bin symlink", () => {
  const steps = planFor({ kind: src("/repo") });
  const paths = steps.map((s) => s.path.replace(home, "~"));
  expect(paths).toEqual([
    "~/.anynotate",
    "~/.local/bin/anynotate",
    "~/.claude/settings.json",
    "~/.claude/skills/annotations/SKILL.md",
    "~/.codex/hooks.json",
    "~/.codex/skills/annotations/SKILL.md",
    "~/.gemini/settings.json",
    "~/.gemini/commands/annotations.toml",
    "origin",
    "~/.anynotate/native-host",
    "~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.anynotate.host.json",
    "~/Library/LaunchAgents/dev.anynotate.bridge.plist",
    "~/.anynotate/install.json",
    "service",
  ]);
  const plist = steps.at(-3)!.content;
  expect(plist).toContain(`<string>${BUN}</string>\n    <string>/repo/src/cli.ts</string>\n    <string>bridge</string>`);
  expect(steps[1]!.content).toBe("/repo/bin/anynotate");
});

posixOnly("dry-run writes nothing; apply merges and backs up", () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ theme: "dark" }));
  const steps = planFor();
  const log = apply(steps, true);
  expect(log.some((l) => l.includes("would merge"))).toBe(true);
  expect(existsSync(join(home, ".codex/hooks.json"))).toBe(false);
  expect(existsSync(join(home, ".anynotate"))).toBe(false);

  apply(steps, false);
  expect(statSync(join(home, ".anynotate")).mode & 0o777).toBe(0o700);
  const claude = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  expect(claude.theme).toBe("dark");
  expect(claude.hooks.UserPromptSubmit[0].hooks[0].command).toBe(CMD("claude"));
  expect(existsSync(join(home, ".claude/settings.json.bak-anynotate"))).toBe(true);
  expect(existsSync(join(home, ".gemini"))).toBe(false);
  apply(steps, false);
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
});

const plan = (installed: (cli: string) => boolean = ALL) => planFor({ installed });
const put = (rel: string, body: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), body);
};

test("addHook refuses a non-array hooks[event] instead of throwing", () => {
  const r = addHook({ hooks: { UserPromptSubmit: {} } }, "UserPromptSubmit", "c");
  expect(r.changed).toBe(false);
  expect(r.unmergeable).toBe(true);
  expect(addHook({ hooks: [] }, "UserPromptSubmit", "c").unmergeable).toBe(true);
  expect(addHook([], "UserPromptSubmit", "c").unmergeable).toBe(true);
});

posixOnly("a JSONC settings file is skipped untouched while the others still merge", () => {
  const jsonc = '{\n  // user comment\n  "theme": "dark"\n}\n';
  put(".codex/hooks.json", jsonc);
  for (const dry of [true, false]) {
    const log = apply(plan(), dry);
    expect(log).toContain(
      `skip    ${join(home, ".codex/hooks.json")} (not valid JSON — add the hook by hand: ${CMD("codex")})`,
    );
  }
  expect(readFileSync(join(home, ".codex/hooks.json"), "utf8")).toBe(jsonc);
  expect(existsSync(join(home, ".codex/hooks.json.bak-anynotate"))).toBe(false);
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
  expect(existsSync(join(home, "Library/LaunchAgents/dev.anynotate.bridge.plist"))).toBe(true);
});

posixOnly("a non-array hooks entry is skipped and the file left unchanged", () => {
  const body = JSON.stringify({ hooks: { UserPromptSubmit: {} } });
  put(".claude/settings.json", body);
  const log = apply(plan(), false);
  expect(log.some((l) => l.startsWith(`skip    ${join(home, ".claude/settings.json")} (`) && l.includes(CMD("claude")))).toBe(true);
  expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe(body);
  expect(JSON.parse(readFileSync(join(home, ".codex/hooks.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
});

const binLink = () => join(home, ".local/bin/anynotate");
const linkLine = (log: string[]) => log.find((l) => l.includes(binLink()));

posixOnly("bin symlink already pointing at anynotateBin is ok", () => {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(LAUNCHER, binLink());
  for (const dry of [true, false]) expect(linkLine(apply(plan(), dry))).toBe(`ok      ${binLink()}`);
  expect(readlinkSync(binLink())).toBe(LAUNCHER);
});

posixOnly("bin symlink pointing elsewhere is replaced", () => {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync("/old/anynotate", binLink());
  expect(linkLine(apply(plan(), true))).toBe(`would link ${binLink()} → ${LAUNCHER}`);
  expect(readlinkSync(binLink())).toBe("/old/anynotate");
  expect(linkLine(apply(plan(), false))).toBe(`linked  ${binLink()} → ${LAUNCHER}`);
  expect(readlinkSync(binLink())).toBe(LAUNCHER);
});

posixOnly("a regular file or dir at the bin path is never removed", () => {
  put(".local/bin/anynotate", "mine");
  for (const dry of [true, false]) {
    expect(linkLine(apply(plan(), dry))).toBe(`skip    ${binLink()} (exists and is not a symlink)`);
  }
  expect(readFileSync(binLink(), "utf8")).toBe("mine");
  rmSync(binLink());
  mkdirSync(binLink());
  expect(linkLine(apply(plan(), false))).toBe(`skip    ${binLink()} (exists and is not a symlink)`);
  expect(lstatSync(binLink()).isDirectory()).toBe(true);
});

posixOnly("a differing file is backed up before it is overwritten", () => {
  put(".claude/skills/annotations/SKILL.md", "old skill");
  const skill = join(home, ".claude/skills/annotations/SKILL.md");
  apply(plan(), true);
  expect(existsSync(`${skill}.bak-anynotate`)).toBe(false);
  apply(plan(), false);
  expect(readFileSync(`${skill}.bak-anynotate`, "utf8")).toBe("old skill");
  expect(readFileSync(skill, "utf8")).toBe(readFileSync(join(process.cwd(), "assets/skill/SKILL.md"), "utf8"));
  expect(existsSync(join(home, ".codex/skills/annotations/SKILL.md.bak-anynotate"))).toBe(false);
});

posixOnly("the plist's log dir is created private, and an open one is tightened", () => {
  mkdirSync(join(home, ".anynotate"), { mode: 0o755 });
  chmodSync(join(home, ".anynotate"), 0o755);
  expect(apply(plan(), true)).toContain(`would chmod 700 ${join(home, ".anynotate")}`);
  expect(statSync(join(home, ".anynotate")).mode & 0o777).toBe(0o755);
  apply(plan(), false);
  expect(statSync(join(home, ".anynotate")).mode & 0o777).toBe(0o700);
  expect(apply(plan(), false)).toContain(`ok      ${join(home, ".anynotate")}`);
});

const whichOnly = (...clis: string[]) => (cli: string) => clis.includes(cli);

posixOnly("a CLI that is not installed is skipped and none of its files are created", () => {
  for (const dry of [true, false]) {
    const log = apply(plan(whichOnly("claude")), dry);
    expect(log).toContain("skip    codex (not installed)");
    expect(log.some((l) => l.includes(".codex"))).toBe(false);
  }
  expect(existsSync(join(home, ".codex"))).toBe(false);
  expect(existsSync(join(home, ".claude/settings.json"))).toBe(true);
  expect(existsSync(join(home, ".claude/skills/annotations/SKILL.md"))).toBe(true);
});

test("by default a CLI counts as installed when it is on PATH or its config dir exists", () => {
  const which = (found: string[]) => (cli: string) => (found.includes(cli) ? `/bin/${cli}` : null);
  const paths = (w: (cli: string) => string | null) =>
    planFor({ kind: src("/r"), which: w, installed: undefined }).filter((s) => s.action !== "skip").map((s) => s.path.replace(home, "~"));
  expect(paths(which([]))).not.toContain("~/.claude/settings.json");
  expect(paths(which(["claude"]))).toContain("~/.claude/settings.json");
  expect(paths(which(["claude"]))).not.toContain("~/.codex/hooks.json");
  mkdirSync(join(home, ".codex"));
  expect(paths(which([]))).toContain("~/.codex/hooks.json");
});

const GEMINI_HOOK = "anynotate hook --agent gemini";
const geminiSettings = () => join(home, ".gemini/settings.json");
const geminiToml = () => join(home, ".gemini/commands/annotations.toml");
const tomlAsset = () => readFileSync(join(process.cwd(), "assets/gemini/annotations.toml"), "utf8");

posixOnly("the installer no longer adds anything for Gemini", () => {
  mkdirSync(join(home, ".gemini"));
  apply(plan(), false);
  expect(existsSync(geminiSettings())).toBe(false);
  expect(existsSync(geminiToml())).toBe(false);
});

posixOnly("an old anynotate Gemini hook is removed with a backup, leaving the user's other hooks", () => {
  const before = { theme: "dark", hooks: { BeforeAgent: [
    { hooks: [{ type: "command", command: "mine" }] },
    { hooks: [{ type: "command", command: GEMINI_HOOK }] },
  ], AfterAgent: [{ hooks: [{ type: "command", command: "other" }] }] } };
  put(".gemini/settings.json", JSON.stringify(before));
  expect(apply(plan(), true)).toContain(`would remove ${GEMINI_HOOK} from ${geminiSettings()}`);
  expect(JSON.parse(readFileSync(geminiSettings(), "utf8"))).toEqual(before);
  expect(apply(plan(), false)).toContain(`removed ${GEMINI_HOOK} from ${geminiSettings()}`);
  expect(JSON.parse(readFileSync(geminiSettings(), "utf8"))).toEqual({ theme: "dark", hooks: {
    BeforeAgent: [{ hooks: [{ type: "command", command: "mine" }] }],
    AfterAgent: [{ hooks: [{ type: "command", command: "other" }] }],
  } });
  expect(JSON.parse(readFileSync(`${geminiSettings()}.bak-anynotate`, "utf8"))).toEqual(before);
  expect(apply(plan(), false).some((l) => l.includes(".gemini"))).toBe(false);
});

posixOnly("an emptied BeforeAgent list is dropped, and Gemini settings without our hook are left alone", () => {
  put(".gemini/settings.json", JSON.stringify({ hooks: { BeforeAgent: [{ hooks: [{ type: "command", command: GEMINI_HOOK }] }] } }));
  apply(plan(), false);
  expect(JSON.parse(readFileSync(geminiSettings(), "utf8"))).toEqual({ hooks: {} });
  const theirs = JSON.stringify({ hooks: { BeforeAgent: [{ hooks: [{ type: "command", command: "anynotate hook --agent gemini --x" }] }] } });
  put(".gemini/settings.json", theirs);
  rmSync(`${geminiSettings()}.bak-anynotate`);
  expect(apply(plan(), false).some((l) => l.includes(".gemini"))).toBe(false);
  expect(readFileSync(geminiSettings(), "utf8")).toBe(theirs);
  expect(existsSync(`${geminiSettings()}.bak-anynotate`)).toBe(false);
});

posixOnly("an unparseable Gemini settings file holding our hook is reported, not rewritten", () => {
  const jsonc = `{\n  // mine\n  "hooks": { "BeforeAgent": [{ "hooks": [{ "command": "${GEMINI_HOOK}" }] }] }\n}\n`;
  put(".gemini/settings.json", jsonc);
  expect(apply(plan(), false)).toContain(`skip    ${geminiSettings()} (not valid JSON — remove "${GEMINI_HOOK}" by hand)`);
  expect(readFileSync(geminiSettings(), "utf8")).toBe(jsonc);
});

posixOnly("our Gemini command file is removed; one the user changed is kept", () => {
  put(".gemini/commands/annotations.toml", tomlAsset());
  expect(apply(plan(), true)).toContain(`would remove ${geminiToml()}`);
  expect(existsSync(geminiToml())).toBe(true);
  expect(apply(plan(), false)).toContain(`removed ${geminiToml()}`);
  expect(existsSync(geminiToml())).toBe(false);
  put(".gemini/commands/annotations.toml", `${tomlAsset()}# mine\n`);
  expect(apply(plan(), false)).toContain(`skip    ${geminiToml()} (changed since install — left alone)`);
  expect(existsSync(geminiToml())).toBe(true);
});

const EXT_IDS = JSON.parse(readFileSync(join(process.cwd(), "assets/extension-ids.json"), "utf8")) as string[];
const EXT_ORIGIN = `chrome-extension://${EXT_IDS[0]}`;
const originsFile = () => join(home, ".anynotate/origins");

test("assets/extension-ids.json pins the dev extension id", () => {
  expect(EXT_IDS).toEqual(["epdjidoapjkdefnpaibacfepphipdioh"]);
});

test("extensionOrigins keeps valid ids in file order and drops the rest", () => {
  const repo = mkdtempSync(join(tmpdir(), "anynotate-repo-"));
  try {
    mkdirSync(join(repo, "assets"));
    writeFileSync(join(repo, "assets/extension-ids.json"), JSON.stringify(["abcdefghijklmnopabcdefghijklmnop", "NOT-AN-ID", 7, "epdjidoapjkdefnpaibacfepphipdioh"]));
    expect(extensionOrigins(repo)).toEqual(["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "chrome-extension://epdjidoapjkdefnpaibacfepphipdioh"]);
    writeFileSync(join(repo, "assets/extension-ids.json"), `{"id":"x"}`);
    expect(extensionOrigins(repo)).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

posixOnly("install pre-allows every pinned extension origin, once", () => {
  expect(EXT_ORIGIN).toMatch(/^chrome-extension:\/\/[a-p]{32}$/);
  expect(apply(plan(), true)).toContain(`would add origin ${EXT_ORIGIN}`);
  expect(existsSync(originsFile())).toBe(false);
  expect(apply(plan(), false)).toContain(`added   origin ${EXT_ORIGIN} → ${originsFile()}`);
  expect(readFileSync(originsFile(), "utf8")).toBe(`${EXT_ORIGIN}\n`);
  expect(statSync(originsFile()).mode & 0o777).toBe(0o600);
  for (const dry of [true, false]) expect(apply(plan(), dry)).toContain(`ok      origin ${EXT_ORIGIN}`);
  expect(readFileSync(originsFile(), "utf8")).toBe(`${EXT_ORIGIN}\n`);
});

posixOnly("origins already allowed are kept when the extension's is added", () => {
  const other = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  mkdirSync(join(home, ".anynotate"), { mode: 0o700 });
  writeFileSync(originsFile(), `${other}\n`, { mode: 0o600 });
  apply(plan(), false);
  expect(readFileSync(originsFile(), "utf8")).toBe(`${other}\n${EXT_ORIGIN}\n`);
});

posixOnly("without a readable extension-ids.json the origin step is skipped", () => {
  const log = apply(planFor({ kind: src("/nonexistent-repo") }), false);
  expect(log).toContain("skip    origin (no extension id in /nonexistent-repo/assets/extension-ids.json)");
  expect(existsSync(originsFile())).toBe(false);
});

const wrapperPath = () => join(home, ".anynotate/native-host");
const manifestPath = () => join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.anynotate.host.json");
const hostPlan = () => planFor();

posixOnly("install writes the native-host wrapper owner-only with the absolute bun path", () => {
  apply(hostPlan(), false);
  expect(readFileSync(wrapperPath(), "utf8")).toBe(`#!/bin/sh\nexec "${BUN}" "${process.cwd()}/src/cli.ts" native-host "$@"\n`);
  expect(statSync(wrapperPath()).mode & 0o777).toBe(0o700);
});

posixOnly("the host manifest names the wrapper and allows pinned plus added extension ids", () => {
  const dev = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  mkdirSync(join(home, ".anynotate"), { mode: 0o700 });
  writeFileSync(originsFile(), `${dev}\nhttps://recipes.example.com\n`, { mode: 0o600 });
  apply(hostPlan(), false);
  const raw = readFileSync(manifestPath(), "utf8");
  expect(raw.endsWith("}\n")).toBe(true);
  expect(raw).toContain('\n  "name": "dev.anynotate.host"');
  expect(JSON.parse(raw)).toEqual({
    name: "dev.anynotate.host",
    description: "Anynotate helper",
    path: wrapperPath(),
    type: "stdio",
    allowed_origins: [`${EXT_ORIGIN}/`, `${dev}/`],
  });
});

posixOnly("the host manifest lists a pinned id once even when the origins file has it", () => {
  mkdirSync(join(home, ".anynotate"), { mode: 0o700 });
  writeFileSync(originsFile(), `${EXT_ORIGIN}\n`, { mode: 0o600 });
  apply(hostPlan(), false);
  expect(JSON.parse(readFileSync(manifestPath(), "utf8")).allowed_origins).toEqual([`${EXT_ORIGIN}/`]);
});

posixOnly("dry-run writes no helper files, and a re-run reports them ok", () => {
  const dry = apply(hostPlan(), true);
  expect(dry).toContain(`would write ${wrapperPath()}`);
  expect(dry).toContain(`would write ${manifestPath()}`);
  expect(existsSync(wrapperPath())).toBe(false);
  expect(existsSync(join(home, "Library/Application Support"))).toBe(false);
  apply(hostPlan(), false);
  for (const dryRun of [true, false]) {
    const log = apply(hostPlan(), dryRun);
    expect(log).toContain(`ok      ${wrapperPath()}`);
    expect(log).toContain(`ok      ${manifestPath()}`);
  }
});

posixOnly("a wrapper with the right content but loose permissions is tightened", () => {
  apply(hostPlan(), false);
  chmodSync(wrapperPath(), 0o755);
  expect(apply(hostPlan(), true)).toContain(`would chmod 700 ${wrapperPath()}`);
  expect(statSync(wrapperPath()).mode & 0o777).toBe(0o755);
  expect(apply(hostPlan(), false)).toContain(`chmod   700 ${wrapperPath()}`);
  expect(statSync(wrapperPath()).mode & 0o777).toBe(0o700);
});

posixOnly("without any extension id the host manifest is skipped", () => {
  const log = apply(planFor({ kind: src("/nonexistent-repo") }), false);
  expect(log).toContain(`skip    ${manifestPath()} (no extension id to allow)`);
  expect(existsSync(manifestPath())).toBe(false);
});

posixOnly("the host manifest is also written for Brave when its profile exists, never for absent browsers", () => {
  const brave = join(home, "Library/Application Support/BraveSoftware/Brave-Browser");
  mkdirSync(brave, { recursive: true });
  apply(hostPlan(), false);
  expect(JSON.parse(readFileSync(join(brave, "NativeMessagingHosts/dev.anynotate.host.json"), "utf8")).path).toBe(wrapperPath());
  expect(existsSync(manifestPath())).toBe(true);
  expect(existsSync(join(home, "Library/Application Support/Microsoft Edge"))).toBe(false);
  expect(existsSync(join(home, "Library/Application Support/Chromium"))).toBe(false);
});

const BARE = (agent: string) => `anynotate hook --agent ${agent}`;

posixOnly("a reinstall replaces the bare hook of older versions in place instead of adding a second one", () => {
  put(".claude/settings.json", JSON.stringify({ hooks: { UserPromptSubmit: [
    { hooks: [{ type: "command", command: "mine" }] },
    { hooks: [{ type: "command", command: BARE("claude"), timeout: 5 }] },
    { hooks: [{ type: "command", command: "myanynotate hook --agent claude" }] },
  ] } }));
  expect(apply(plan(), false)).toContain(`merged  UserPromptSubmit → ${join(home, ".claude/settings.json")}`);
  const groups = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks.UserPromptSubmit;
  expect(groups).toEqual([
    { hooks: [{ type: "command", command: "mine" }] },
    { hooks: [{ type: "command", command: CMD("claude"), timeout: 5 }] },
    { hooks: [{ type: "command", command: "myanynotate hook --agent claude" }] },
  ]);
  expect(apply(plan(), false)).toContain(`ok      ${join(home, ".claude/settings.json")} (hook present)`);
});

posixOnly("a hook left by a moved clone or binary is replaced, and duplicates collapse to one", () => {
  put(".codex/hooks.json", JSON.stringify({ hooks: { UserPromptSubmit: [
    { hooks: [{ type: "command", command: CMD("codex", "/old/clone") }] },
    { hooks: [{ type: "command", command: '"/home/me/old bin/anynotate" hook --agent codex' }, { type: "command", command: "other" }] },
    { hooks: [{ type: "command", command: BARE("codex") }] },
    { hooks: [{ type: "command", command: BARE("claude") }] },
  ] } }));
  apply(plan(), false);
  expect(JSON.parse(readFileSync(join(home, ".codex/hooks.json"), "utf8")).hooks.UserPromptSubmit).toEqual([
    { hooks: [{ type: "command", command: CMD("codex") }] },
    { hooks: [{ type: "command", command: "other" }] },
    { hooks: [{ type: "command", command: BARE("claude") }] },
  ]);
});

const hookOf = (steps: InstallStep[], agent: string) =>
  JSON.parse(steps.find((s) => s.action === "merge-json" && s.content.includes(`"agent":"${agent}"`))!.content).command;

test("hooks name the absolute executable on every OS, quoted only when the path has spaces", () => {
  const linux = planFor({ platform: "linux", home: "/home/me", kind: { kind: "binary", exe: "/home/me/.local/bin/anynotate" } });
  expect(hookOf(linux, "claude")).toBe("/home/me/.local/bin/anynotate hook --agent claude");
  const darwin = planFor({ home: "/Users/me", kind: { kind: "source", repo: "/Users/me/src/anynotate", bun: "/Users/me/.bun/bin/bun" } });
  expect(hookOf(darwin, "codex")).toBe("/Users/me/.bun/bin/bun /Users/me/src/anynotate/src/cli.ts hook --agent codex");
  const winExe = (home: string) => `${home}\\AppData\\Local\\anynotate\\bin\\anynotate.exe`;
  const win = (home: string) => planFor({ platform: "win32", home, kind: { kind: "binary", exe: winExe(home) } });
  expect(hookOf(win("C:\\Users\\me"), "claude")).toBe("C:/Users/me/AppData/Local/anynotate/bin/anynotate.exe hook --agent claude");
  expect(hookOf(win("C:\\Users\\Me Me"), "claude")).toBe('"C:/Users/Me Me/AppData/Local/anynotate/bin/anynotate.exe" hook --agent claude');
  const winSrc = planFor({ platform: "win32", home: "C:\\Users\\me", kind: { kind: "source", repo: "C:\\src\\anynotate", bun: "C:\\bun\\bun.exe" } });
  expect(hookOf(winSrc, "codex")).toBe("C:/bun/bun.exe C:/src/anynotate/src/cli.ts hook --agent codex");
  expect(win("C:\\Users\\me").find((s) => s.action === "merge-json")!.path).toBe("C:\\Users\\me\\.claude\\settings.json");
});

test("a binary install links nothing, writes no wrapper, and registers the binary itself as the host", () => {
  const exe = "/home/me/.local/bin/anynotate";
  const steps = planFor({ platform: "linux", home: "/home/me", kind: { kind: "binary", exe } });
  expect(steps.some((s) => s.action === "symlink")).toBe(false);
  expect(steps.some((s) => s.path.endsWith("native-host"))).toBe(false);
  const host = steps.find((s) => s.action === "native-host")!;
  expect(host.path).toBe("/home/me/.config/google-chrome/NativeMessagingHosts/dev.anynotate.host.json");
  expect(JSON.parse(host.host!.kind === "write-manifest" ? host.host!.json : "{}").path).toBe(exe);
  const unit = steps.find((s) => s.path.endsWith("anynotate-bridge.desktop"))!;
  expect(unit.content).toContain(`Exec=${exe} bridge --detach`);
  expect(steps.at(-1)!.argv).toEqual([
    [exe, "bridge", "--stop"],
    [exe, "bridge", "--detach"],
  ]);
});

test("a Windows plan registers the host per browser, writes the UTF-16 bridge.vbs and starts it from the Run key", () => {
  const exe = "C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe";
  const steps = planFor({ platform: "win32", home: "C:\\Users\\me", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, kind: { kind: "binary", exe } });
  expect(steps[0]).toEqual({ path: "C:\\Users\\me\\.anynotate", action: "private-dir", content: "" });
  expect(steps.filter((s) => s.host?.kind === "reg-add").map((s) => s.path)).toHaveLength(4);
  const vbs = steps.find((s) => s.path.endsWith("bridge.vbs"))!;
  expect(vbs.encoding).toBe("utf16le-bom");
  expect(steps.at(-2)!.path).toBe("C:\\Users\\me\\.anynotate\\install.json");
  expect(steps.at(-1)!.argv![0]!.slice(-2)).toEqual(["bridge", "--stop"]);
  expect(steps.at(-1)!.argv![1]!.slice(0, 2)).toEqual(["reg", "add"]);
});

test("a Windows source install puts an anynotate.cmd shim on its bin dir and a .cmd host wrapper", () => {
  const steps = planFor({ platform: "win32", home: "C:\\Users\\me", env: {}, kind: { kind: "source", repo: "C:\\src\\anynotate", bun: "C:\\bun\\bun.exe" } });
  const shim = steps.find((s) => s.path.endsWith("anynotate.cmd"))!;
  expect(shim.path).toBe("C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.cmd");
  expect(shim.content).toBe('@"C:\\bun\\bun.exe" "C:\\src\\anynotate\\src\\cli.ts" %*\r\n');
  expect(steps.find((s) => s.path.endsWith("native-host.cmd"))!.mode).toBeUndefined();
  const entry = steps.filter((s) => s.action === "path-entry");
  expect(entry).toEqual([{ path: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin", action: "path-entry", content: "" }]);
  expect(steps.indexOf(entry[0]!)).toBe(steps.indexOf(shim) + 1);
});

test("only a Windows source install adds a PATH entry", () => {
  expect(planFor().some((s) => s.action === "path-entry")).toBe(false);
  expect(planFor({ platform: "win32", home: "C:\\Users\\me", env: {}, kind: { kind: "binary", exe: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe" } }).some((s) => s.action === "path-entry")).toBe(false);
});

test("the PATH entry is added by PowerShell reading the dir from the environment, keeping %VAR% entries unexpanded", () => {
  const step: InstallStep = { path: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin", action: "path-entry", content: "" };
  const seen: { argv: string[]; env?: Record<string, string> }[] = [];
  const exec = (stdout: string, code = 0): Exec => (argv, _cwd, env) => {
    seen.push({ argv, env });
    return { code, stdout, stderr: code ? "denied" : "" };
  };
  expect(applyInstall([step], false, { exec: exec("added\r\n"), platform: "win32" })).toEqual([`added   ${step.path} to the user PATH (open a new terminal to use anynotate)`]);
  const { argv, env } = seen[0]!;
  expect(argv.slice(0, 4)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-Command"]);
  expect(argv[4]).toContain("GetValue('Path', '', 'DoNotExpandEnvironmentNames')");
  expect(argv[4]).toContain("-Type ExpandString");
  expect(argv[4]).not.toContain("C:\\Users");
  expect(argv[4]).not.toContain("[Environment]::SetEnvironmentVariable('Path'");
  expect(env).toEqual({ ANYNOTATE_BIN_DIR: step.path });
  expect(applyInstall([step], false, { exec: exec("present"), platform: "win32" })).toEqual([`ok      ${step.path} (on the user PATH)`]);
  expect(applyInstall([step], false, { exec: exec("", 1), platform: "win32" })).toEqual([`failed (exit 1): adding ${step.path} to the user PATH: denied`]);
  seen.length = 0;
  expect(applyInstall([step], true, { exec: exec("added"), platform: "win32" })).toEqual([`would add ${step.path} to the user PATH`]);
  expect(applyInstall([step], false, { exec: exec("added"), platform: "win32", externalDryRun: true })).toEqual([`would add ${step.path} to the user PATH`]);
  expect(seen).toEqual([]);
});

test("the data dir follows ANYNOTATE_HOME", () => {
  const steps = planFor({ env: { ANYNOTATE_HOME: "/srv/anynotate" } });
  expect(steps[0]!.path).toBe("/srv/anynotate");
  expect(steps.at(-2)!.path).toBe("/srv/anynotate/install.json");
});

test("a dry run lists the service start commands and runs nothing", () => {
  const log = apply(plan(), true);
  expect(log).toContain("would run: launchctl bootout gui/501/dev.anynotate.bridge");
  expect(log).toContain(`would run: launchctl bootstrap gui/501 ${join(home, "Library/LaunchAgents/dev.anynotate.bridge.plist")}`);
  expect(log).toContain("would run: launchctl kickstart -k gui/501/dev.anynotate.bridge");
  expect(log).toContain(`would write ${join(home, ".anynotate/install.json")}`);
  expect(calls).toEqual([]);
  expect(existsSync(join(home, ".anynotate"))).toBe(false);
});

posixOnly("apply writes install.json and starts the service", () => {
  apply(plan(), false);
  expect(JSON.parse(readFileSync(join(home, ".anynotate/install.json"), "utf8"))).toEqual({
    kind: "source", path: REPO, version: "0.4.0", installedAt: "2026-10-01T12:00:00.000Z", platform: "darwin",
  });
  expect(statSync(join(home, ".anynotate/install.json")).mode & 0o777).toBe(0o600);
  expect(calls).toEqual([
    ["launchctl", "bootout", "gui/501/dev.anynotate.bridge"],
    ["launchctl", "bootstrap", "gui/501", join(home, "Library/LaunchAgents/dev.anynotate.bridge.plist")],
    ["launchctl", "kickstart", "-k", "gui/501/dev.anynotate.bridge"],
  ]);
  const plist = readFileSync(join(home, "Library/LaunchAgents/dev.anynotate.bridge.plist"), "utf8");
  expect(plist).toContain(`<string>${BUN}</string>\n    <string>${REPO}/src/cli.ts</string>\n    <string>bridge</string>`);
  expect(plist).toContain(`<string>${join(home, ".anynotate/bridge.log")}</string>`);
});

posixOnly("a failed start is reported in the log", () => {
  const failing: Exec = (argv) => ({ code: argv[1] === "kickstart" ? 3 : 0, stdout: "", stderr: argv[1] === "kickstart" ? "boom" : "" });
  const log = applyInstall(plan(), false, { exec: failing, platform: "darwin" });
  expect(log.at(-1)).toBe("failed (exit 3): launchctl kickstart -k gui/501/dev.anynotate.bridge: boom");
});

posixOnly("a linux install with user systemd writes the unit and enables it", () => {
  const steps = planFor({ platform: "linux", hasUserSystemd: true });
  applyInstall(steps, false, { exec: fakeExec, platform: "linux" });
  expect(readFileSync(join(home, ".config/systemd/user/anynotate-bridge.service"), "utf8")).toContain(`ExecStart=${BUN} ${REPO}/src/cli.ts bridge`);
  expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["systemctl --user daemon-reload", "systemctl --user enable", "systemctl --user restart"]);
  expect(existsSync(join(home, ".config/google-chrome/NativeMessagingHosts/dev.anynotate.host.json"))).toBe(true);
});

posixOnly("externalDryRun writes the files but starts nothing", () => {
  const log = applyInstall(plan(), false, { exec: fakeExec, platform: "darwin", externalDryRun: true });
  expect(calls).toEqual([]);
  expect(log).toContain("would run: launchctl kickstart -k gui/501/dev.anynotate.bridge");
  expect(existsSync(join(home, ".anynotate/install.json"))).toBe(true);
});

test("a utf16le-bom file is written with a BOM and compared byte for byte", () => {
  const p = join(home, "bridge.vbs");
  const step: InstallStep = { path: p, action: "write", content: "x\r\n", encoding: "utf16le-bom" };
  expect(apply([step], false)).toEqual([`wrote   ${p}`]);
  expect([...readFileSync(p)]).toEqual([0xff, 0xfe, 0x78, 0, 0x0d, 0, 0x0a, 0]);
  expect(apply([step], false)).toEqual([`ok      ${p}`]);
});

posixOnly("without an exec, applying a plan refuses to run commands rather than touching the real service", () => {
  expect(() => applyInstall(plan(), false, { platform: "darwin" })).toThrow(/no exec/);
});

const regStep = (): InstallStep => ({ path: "HKCU\\Software\\X", action: "native-host", content: "", host: { kind: "reg-add", key: "HKCU\\Software\\X", manifestPath: "C:\\m.json" } });

test("a failing reg add is logged as failed instead of throwing", () => {
  const denied: Exec = () => ({ code: 1, stdout: "", stderr: "Access is denied." });
  const log = applyInstall([regStep()], false, { exec: denied, platform: "win32" });
  expect(log).toHaveLength(1);
  expect(log[0]).toStartWith("failed (reg add HKCU\\Software\\X");
  expect(log[0]).toContain("Access is denied.");
});

test("externalDryRun reports registry steps without running them", () => {
  expect(applyInstall([regStep()], false, { exec: fakeExec, platform: "win32", externalDryRun: true })).toEqual([
    "would register HKCU\\Software\\X → C:\\m.json",
  ]);
  expect(calls).toEqual([]);
});

test("isAnynotateHook matches only a command that is solely our executable", () => {
  for (const c of [
    "anynotate hook --agent claude",
    "/home/me/.local/bin/anynotate hook --agent claude",
    '"/home/me/my bin/anynotate" hook --agent claude',
    "C:/Users/me/AppData/Local/anynotate/bin/anynotate.exe hook --agent claude",
    '"C:\\Users\\Me Me\\anynotate.exe" hook --agent claude',
    "/opt/bun/bin/bun /home/me/src/anynotate/src/cli.ts hook --agent claude",
    '"C:/Program Files/bun/bun.exe" "C:/my src/cli.ts" hook --agent claude',
  ]) expect([c, isAnynotateHook(c, "claude")]).toEqual([c, true]);
  for (const c of [
    "foo && anynotate hook --agent claude",
    "cd /x; anynotate hook --agent claude",
    "myanynotate hook --agent claude",
    "anynotate hook --agent codex",
    "node /x/cli.ts hook --agent claude",
    "env X=1 anynotate hook --agent claude",
    "anynotate hook --agent claude --x",
    "true&&/usr/bin/anynotate hook --agent claude",
    '"$(touch x)/anynotate" hook --agent claude',
    "`touch x`/anynotate hook --agent claude",
    "/opt/bun/bin/bun /x/src/cli.ts;rm hook --agent claude",
  ]) expect([c, isAnynotateHook(c, "claude")]).toEqual([c, false]);
});

windowsOnly("on Windows a source install writes the hooks, the .cmd shim and host wrapper, the manifest and bridge.vbs", () => {
  const env = { LOCALAPPDATA: win32.join(home, "AppData", "Local") };
  const kind: InstallKind = { kind: "source", repo: process.cwd(), bun: process.execPath };
  const steps = planFor({ platform: "win32", env, kind });
  const log = applyInstall(steps, false, { exec: fakeExec, platform: "win32" });
  expect(log.filter((l) => l.startsWith("failed"))).toEqual([]);
  const data = win32.join(home, ".anynotate");
  const hook = JSON.parse(readFileSync(win32.join(home, ".claude", "settings.json"), "utf8")).hooks.UserPromptSubmit[0].hooks[0].command;
  expect(hook).toBe(`${[process.execPath, win32.join(process.cwd(), "src", "cli.ts")].map((a) => a.replaceAll("\\", "/")).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")} hook --agent claude`);
  expect(readFileSync(win32.join(env.LOCALAPPDATA, "anynotate", "bin", "anynotate.cmd"), "utf8")).toEndWith(" %*\r\n");
  expect(existsSync(win32.join(data, "native-host.cmd"))).toBe(true);
  expect(JSON.parse(readFileSync(win32.join(data, "dev.anynotate.host.json"), "utf8")).path).toBe(win32.join(data, "native-host.cmd"));
  expect([...readFileSync(win32.join(data, "bridge.vbs")).subarray(0, 2)]).toEqual([0xff, 0xfe]);
  expect(JSON.parse(readFileSync(win32.join(data, "install.json"), "utf8"))).toMatchObject({ kind: "source", platform: "win32" });
  expect(calls.filter((c) => c[0] === "reg" && c[1] === "add").length).toBeGreaterThanOrEqual(4);
  calls = [];
  const again = applyInstall(steps, false, { exec: fakeExec, platform: "win32" });
  expect(again.filter((l) => (l.startsWith("wrote") && !l.endsWith("install.json")) || l.startsWith("merged"))).toEqual([]);
});
