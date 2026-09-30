import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHook, applyInstall, extensionOrigins, planInstall } from "../src/agent/install";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-home-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

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

const ALL = () => true;

test("planInstall targets Claude and Codex when installed, the Gemini cleanup, launchd and the bin symlink", () => {
  const steps = planInstall({ home, anynotateBin: "/repo/bin/anynotate", repo: "/repo", installed: ALL });
  const paths = steps.map((s) => s.path.replace(home, "~"));
  expect(paths).toEqual([
    "~/.local/bin/anynotate",
    "~/.claude/settings.json",
    "~/.claude/skills/annotations/SKILL.md",
    "~/.codex/hooks.json",
    "~/.codex/skills/annotations/SKILL.md",
    "~/.gemini/settings.json",
    "~/.gemini/commands/annotations.toml",
    "~/.anynotate",
    "origin",
    "~/.anynotate/native-host",
    "~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.anynotate.host.json",
    "~/Library/LaunchAgents/dev.anynotate.bridge.plist",
  ]);
  const plist = steps.at(-1)!.content;
  expect(plist).toContain("<string>/repo/bin/anynotate</string>");
  expect(plist).toContain("<string>bridge</string>");
});

test("dry-run writes nothing; apply merges and backs up", () => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ theme: "dark" }));
  const steps = planInstall({ home, anynotateBin: "/repo/bin/anynotate", repo: process.cwd(), installed: ALL });
  const log = applyInstall(steps, true);
  expect(log.some((l) => l.includes("would merge"))).toBe(true);
  expect(existsSync(join(home, ".codex/hooks.json"))).toBe(false);
  expect(existsSync(join(home, ".anynotate"))).toBe(false);

  applyInstall(steps, false);
  expect(statSync(join(home, ".anynotate")).mode & 0o777).toBe(0o700);
  const claude = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  expect(claude.theme).toBe("dark");
  expect(claude.hooks.UserPromptSubmit[0].hooks[0].command).toBe("anynotate hook --agent claude");
  expect(existsSync(join(home, ".claude/settings.json.bak-anynotate"))).toBe(true);
  expect(existsSync(join(home, ".gemini"))).toBe(false);
  applyInstall(steps, false);
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
});

const plan = (installed: (cli: string) => boolean = ALL) => planInstall({ home, anynotateBin: "/repo/bin/anynotate", repo: process.cwd(), installed });
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

test("a JSONC settings file is skipped untouched while the others still merge", () => {
  const jsonc = '{\n  // user comment\n  "theme": "dark"\n}\n';
  put(".codex/hooks.json", jsonc);
  for (const dry of [true, false]) {
    const log = applyInstall(plan(), dry);
    expect(log).toContain(
      `skip    ${join(home, ".codex/hooks.json")} (not valid JSON — add the hook by hand: anynotate hook --agent codex)`,
    );
  }
  expect(readFileSync(join(home, ".codex/hooks.json"), "utf8")).toBe(jsonc);
  expect(existsSync(join(home, ".codex/hooks.json.bak-anynotate"))).toBe(false);
  expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
  expect(existsSync(join(home, "Library/LaunchAgents/dev.anynotate.bridge.plist"))).toBe(true);
});

test("a non-array hooks entry is skipped and the file left unchanged", () => {
  const body = JSON.stringify({ hooks: { UserPromptSubmit: {} } });
  put(".claude/settings.json", body);
  const log = applyInstall(plan(), false);
  expect(log.some((l) => l.startsWith(`skip    ${join(home, ".claude/settings.json")} (`) && l.includes("anynotate hook --agent claude"))).toBe(true);
  expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe(body);
  expect(JSON.parse(readFileSync(join(home, ".codex/hooks.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
});

const binLink = () => join(home, ".local/bin/anynotate");
const linkLine = (log: string[]) => log.find((l) => l.includes(binLink()));

test("bin symlink already pointing at anynotateBin is ok", () => {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync("/repo/bin/anynotate", binLink());
  for (const dry of [true, false]) expect(linkLine(applyInstall(plan(), dry))).toBe(`ok      ${binLink()}`);
  expect(readlinkSync(binLink())).toBe("/repo/bin/anynotate");
});

test("bin symlink pointing elsewhere is replaced", () => {
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync("/old/anynotate", binLink());
  expect(linkLine(applyInstall(plan(), true))).toBe(`would link ${binLink()} → /repo/bin/anynotate`);
  expect(readlinkSync(binLink())).toBe("/old/anynotate");
  expect(linkLine(applyInstall(plan(), false))).toBe(`linked  ${binLink()} → /repo/bin/anynotate`);
  expect(readlinkSync(binLink())).toBe("/repo/bin/anynotate");
});

test("a regular file or dir at the bin path is never removed", () => {
  put(".local/bin/anynotate", "mine");
  for (const dry of [true, false]) {
    expect(linkLine(applyInstall(plan(), dry))).toBe(`skip    ${binLink()} (exists and is not a symlink)`);
  }
  expect(readFileSync(binLink(), "utf8")).toBe("mine");
  rmSync(binLink());
  mkdirSync(binLink());
  expect(linkLine(applyInstall(plan(), false))).toBe(`skip    ${binLink()} (exists and is not a symlink)`);
  expect(lstatSync(binLink()).isDirectory()).toBe(true);
});

test("a differing file is backed up before it is overwritten", () => {
  put(".claude/skills/annotations/SKILL.md", "old skill");
  const skill = join(home, ".claude/skills/annotations/SKILL.md");
  applyInstall(plan(), true);
  expect(existsSync(`${skill}.bak-anynotate`)).toBe(false);
  applyInstall(plan(), false);
  expect(readFileSync(`${skill}.bak-anynotate`, "utf8")).toBe("old skill");
  expect(readFileSync(skill, "utf8")).toBe(readFileSync(join(process.cwd(), "assets/skill/SKILL.md"), "utf8"));
  expect(existsSync(join(home, ".codex/skills/annotations/SKILL.md.bak-anynotate"))).toBe(false);
});

test("the plist's log dir is created private, and an open one is tightened", () => {
  mkdirSync(join(home, ".anynotate"), { mode: 0o755 });
  chmodSync(join(home, ".anynotate"), 0o755);
  expect(applyInstall(plan(), true)).toContain(`would chmod 700 ${join(home, ".anynotate")}`);
  expect(statSync(join(home, ".anynotate")).mode & 0o777).toBe(0o755);
  applyInstall(plan(), false);
  expect(statSync(join(home, ".anynotate")).mode & 0o777).toBe(0o700);
  expect(applyInstall(plan(), false)).toContain(`ok      ${join(home, ".anynotate")}`);
});

const whichOnly = (...clis: string[]) => (cli: string) => clis.includes(cli);

test("a CLI that is not installed is skipped and none of its files are created", () => {
  for (const dry of [true, false]) {
    const log = applyInstall(plan(whichOnly("claude")), dry);
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
    planInstall({ home, anynotateBin: "/b", repo: "/r", which: w }).filter((s) => s.action !== "skip").map((s) => s.path.replace(home, "~"));
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

test("the installer no longer adds anything for Gemini", () => {
  mkdirSync(join(home, ".gemini"));
  applyInstall(plan(), false);
  expect(existsSync(geminiSettings())).toBe(false);
  expect(existsSync(geminiToml())).toBe(false);
});

test("an old anynotate Gemini hook is removed with a backup, leaving the user's other hooks", () => {
  const before = { theme: "dark", hooks: { BeforeAgent: [
    { hooks: [{ type: "command", command: "mine" }] },
    { hooks: [{ type: "command", command: GEMINI_HOOK }] },
  ], AfterAgent: [{ hooks: [{ type: "command", command: "other" }] }] } };
  put(".gemini/settings.json", JSON.stringify(before));
  expect(applyInstall(plan(), true)).toContain(`would remove ${GEMINI_HOOK} from ${geminiSettings()}`);
  expect(JSON.parse(readFileSync(geminiSettings(), "utf8"))).toEqual(before);
  expect(applyInstall(plan(), false)).toContain(`removed ${GEMINI_HOOK} from ${geminiSettings()}`);
  expect(JSON.parse(readFileSync(geminiSettings(), "utf8"))).toEqual({ theme: "dark", hooks: {
    BeforeAgent: [{ hooks: [{ type: "command", command: "mine" }] }],
    AfterAgent: [{ hooks: [{ type: "command", command: "other" }] }],
  } });
  expect(JSON.parse(readFileSync(`${geminiSettings()}.bak-anynotate`, "utf8"))).toEqual(before);
  expect(applyInstall(plan(), false).some((l) => l.includes(".gemini"))).toBe(false);
});

test("an emptied BeforeAgent list is dropped, and Gemini settings without our hook are left alone", () => {
  put(".gemini/settings.json", JSON.stringify({ hooks: { BeforeAgent: [{ hooks: [{ type: "command", command: GEMINI_HOOK }] }] } }));
  applyInstall(plan(), false);
  expect(JSON.parse(readFileSync(geminiSettings(), "utf8"))).toEqual({ hooks: {} });
  const theirs = JSON.stringify({ hooks: { BeforeAgent: [{ hooks: [{ type: "command", command: "anynotate hook --agent gemini --x" }] }] } });
  put(".gemini/settings.json", theirs);
  rmSync(`${geminiSettings()}.bak-anynotate`);
  expect(applyInstall(plan(), false).some((l) => l.includes(".gemini"))).toBe(false);
  expect(readFileSync(geminiSettings(), "utf8")).toBe(theirs);
  expect(existsSync(`${geminiSettings()}.bak-anynotate`)).toBe(false);
});

test("an unparseable Gemini settings file holding our hook is reported, not rewritten", () => {
  const jsonc = `{\n  // mine\n  "hooks": { "BeforeAgent": [{ "hooks": [{ "command": "${GEMINI_HOOK}" }] }] }\n}\n`;
  put(".gemini/settings.json", jsonc);
  expect(applyInstall(plan(), false)).toContain(`skip    ${geminiSettings()} (not valid JSON — remove "${GEMINI_HOOK}" by hand)`);
  expect(readFileSync(geminiSettings(), "utf8")).toBe(jsonc);
});

test("our Gemini command file is removed; one the user changed is kept", () => {
  put(".gemini/commands/annotations.toml", tomlAsset());
  expect(applyInstall(plan(), true)).toContain(`would remove ${geminiToml()}`);
  expect(existsSync(geminiToml())).toBe(true);
  expect(applyInstall(plan(), false)).toContain(`removed ${geminiToml()}`);
  expect(existsSync(geminiToml())).toBe(false);
  put(".gemini/commands/annotations.toml", `${tomlAsset()}# mine\n`);
  expect(applyInstall(plan(), false)).toContain(`skip    ${geminiToml()} (changed since install — left alone)`);
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

test("install pre-allows every pinned extension origin, once", () => {
  expect(EXT_ORIGIN).toMatch(/^chrome-extension:\/\/[a-p]{32}$/);
  expect(applyInstall(plan(), true)).toContain(`would add origin ${EXT_ORIGIN}`);
  expect(existsSync(originsFile())).toBe(false);
  expect(applyInstall(plan(), false)).toContain(`added   origin ${EXT_ORIGIN} → ${originsFile()}`);
  expect(readFileSync(originsFile(), "utf8")).toBe(`${EXT_ORIGIN}\n`);
  expect(statSync(originsFile()).mode & 0o777).toBe(0o600);
  for (const dry of [true, false]) expect(applyInstall(plan(), dry)).toContain(`ok      origin ${EXT_ORIGIN}`);
  expect(readFileSync(originsFile(), "utf8")).toBe(`${EXT_ORIGIN}\n`);
});

test("origins already allowed are kept when the extension's is added", () => {
  const other = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  mkdirSync(join(home, ".anynotate"), { mode: 0o700 });
  writeFileSync(originsFile(), `${other}\n`, { mode: 0o600 });
  applyInstall(plan(), false);
  expect(readFileSync(originsFile(), "utf8")).toBe(`${other}\n${EXT_ORIGIN}\n`);
});

test("without a readable extension-ids.json the origin step is skipped", () => {
  const log = applyInstall(planInstall({ home, anynotateBin: "/b", repo: "/nonexistent-repo", installed: ALL }), false);
  expect(log).toContain("skip    origin (no extension id in /nonexistent-repo/assets/extension-ids.json)");
  expect(existsSync(originsFile())).toBe(false);
});

const BUN = "/opt/bun/bin/bun";
const wrapperPath = () => join(home, ".anynotate/native-host");
const manifestPath = () => join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.anynotate.host.json");
const hostPlan = () => planInstall({ home, anynotateBin: "/repo/bin/anynotate", repo: process.cwd(), installed: ALL, bunPath: BUN });

test("install writes the native-host wrapper owner-only with the absolute bun path", () => {
  applyInstall(hostPlan(), false);
  expect(readFileSync(wrapperPath(), "utf8")).toBe(`#!/bin/sh\nexec "${BUN}" "${process.cwd()}/src/cli.ts" native-host "$@"\n`);
  expect(statSync(wrapperPath()).mode & 0o777).toBe(0o700);
});

test("the host manifest names the wrapper and allows pinned plus added extension ids", () => {
  const dev = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  mkdirSync(join(home, ".anynotate"), { mode: 0o700 });
  writeFileSync(originsFile(), `${dev}\nhttps://recipes.example.com\n`, { mode: 0o600 });
  applyInstall(hostPlan(), false);
  const raw = readFileSync(manifestPath(), "utf8");
  expect(raw.endsWith("}\n")).toBe(true);
  expect(raw).toContain('\n  "name": "dev.anynotate.host"');
  expect(JSON.parse(raw)).toEqual({
    name: "dev.anynotate.host",
    description: "Anynotate bridge helper",
    path: wrapperPath(),
    type: "stdio",
    allowed_origins: [`${EXT_ORIGIN}/`, `${dev}/`],
  });
});

test("the host manifest lists a pinned id once even when the origins file has it", () => {
  mkdirSync(join(home, ".anynotate"), { mode: 0o700 });
  writeFileSync(originsFile(), `${EXT_ORIGIN}\n`, { mode: 0o600 });
  applyInstall(hostPlan(), false);
  expect(JSON.parse(readFileSync(manifestPath(), "utf8")).allowed_origins).toEqual([`${EXT_ORIGIN}/`]);
});

test("dry-run writes no helper files, and a re-run reports them ok", () => {
  const dry = applyInstall(hostPlan(), true);
  expect(dry).toContain(`would write ${wrapperPath()}`);
  expect(dry).toContain(`would write ${manifestPath()}`);
  expect(existsSync(wrapperPath())).toBe(false);
  expect(existsSync(join(home, "Library/Application Support"))).toBe(false);
  applyInstall(hostPlan(), false);
  for (const dryRun of [true, false]) {
    const log = applyInstall(hostPlan(), dryRun);
    expect(log).toContain(`ok      ${wrapperPath()}`);
    expect(log).toContain(`ok      ${manifestPath()}`);
  }
});

test("a wrapper with the right content but loose permissions is tightened", () => {
  applyInstall(hostPlan(), false);
  chmodSync(wrapperPath(), 0o755);
  expect(applyInstall(hostPlan(), true)).toContain(`would chmod 700 ${wrapperPath()}`);
  expect(statSync(wrapperPath()).mode & 0o777).toBe(0o755);
  expect(applyInstall(hostPlan(), false)).toContain(`chmod   700 ${wrapperPath()}`);
  expect(statSync(wrapperPath()).mode & 0o777).toBe(0o700);
});

test("without any extension id the host manifest is skipped", () => {
  const log = applyInstall(planInstall({ home, anynotateBin: "/b", repo: "/nonexistent-repo", installed: ALL, bunPath: BUN }), false);
  expect(log).toContain(`skip    ${manifestPath()} (no extension id to allow)`);
  expect(existsSync(manifestPath())).toBe(false);
});
