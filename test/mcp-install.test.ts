import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/platform/exec";
import type { Platform } from "../src/platform/os";
import { autoMcpInstall, CLAUDE_TIMEOUT_MS, findCli, mcpChecks, type McpOptions, mcpOptedOut, mcpTarget, readDeclined, removeTomlServer, runMcpSetup, setJsonServer, setTomlServer } from "../src/mcp/install";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anynotate-mcpi-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ENTRY = ["/opt/anynotate/bin/anynotate"];
const NOW = new Date("2026-10-03T12:34:56Z");

function opts(over: Partial<McpOptions> = {}): McpOptions & { ran: string[][]; out: string[] } {
  const ran: string[][] = [];
  const out: string[] = [];
  const exec: Exec = (argv) => {
    ran.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { platform: "darwin", home, env: {}, entry: ENTRY, which: () => null, exec, now: NOW, applications: join(home, "SystemApplications"), log: (l) => out.push(l), ran, out, ...over };
}

const hostOpts = (over: Partial<McpOptions> = {}) => opts({ platform: process.platform === "win32" ? "win32" : "linux", ...over });

const desktopDir = () => join(home, "Library", "Application Support", "Claude");
const desktopFile = () => join(desktopDir(), "claude_desktop_config.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const backups = (dir: string) => readdirSync(dir).filter((n) => n.includes(".bak-anynotate-"));

test("config paths per app and platform", () => {
  expect(mcpTarget("claude-desktop", { platform: "darwin", home: "/Users/me", env: {} })).toEqual({ kind: "json", path: "/Users/me/Library/Application Support/Claude/claude_desktop_config.json" });
  expect(mcpTarget("claude-desktop", { platform: "win32", home: "C:\\Users\\me", env: { APPDATA: "D:\\Roaming" } })).toEqual({ kind: "json", path: "D:\\Roaming\\Claude\\claude_desktop_config.json" });
  expect(mcpTarget("claude-desktop", { platform: "win32", home: "C:\\Users\\me", env: {} })).toEqual({ kind: "json", path: "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json" });
  expect(mcpTarget("claude-desktop", { platform: "linux", home: "/home/me", env: {} })).toMatchObject({ kind: "unsupported" });
  const msix = "C:\\L\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude";
  const store = { platform: "win32" as Platform, home: "C:\\Users\\me", env: { LOCALAPPDATA: "C:\\L", APPDATA: "D:\\Roaming" } };
  const listDir = (p: string) => (p === "C:\\L\\Packages" ? ["Other_1", "Claude_pzs8sxrjxfjjc"] : []);
  expect(mcpTarget("claude-desktop", { ...store, listDir, exists: (p) => p === msix })).toEqual({ kind: "json", path: `${msix}\\claude_desktop_config.json` });
  expect(mcpTarget("claude-desktop", { ...store, listDir, exists: () => false })).toEqual({ kind: "json", path: "D:\\Roaming\\Claude\\claude_desktop_config.json" });
  expect(mcpTarget("cursor", { platform: "linux", home: "/home/me", env: {} })).toEqual({ kind: "json", path: "/home/me/.cursor/mcp.json" });
  expect(mcpTarget("codex", { platform: "win32", home: "C:\\Users\\me", env: {} })).toEqual({ kind: "toml", path: "C:\\Users\\me\\.codex\\config.toml" });
  expect(mcpTarget("claude-code", { platform: "darwin", home: "/Users/me", env: {} })).toEqual({ kind: "cli", path: "/Users/me/.claude.json" });
});

test("setJsonServer adds our server and keeps the others", () => {
  const r = setJsonServer('{"mcpServers":{"other":{"command":"x"}},"theme":"dark"}', ["C:\\Program Files\\anynotate.exe"]);
  expect("text" in r && JSON.parse(r.text)).toEqual({
    mcpServers: { other: { command: "x" }, anynotate: { command: "C:\\Program Files\\anynotate.exe", args: ["mcp"] } },
    theme: "dark",
  });
});

test("setJsonServer reports an existing identical entry as unchanged and refuses odd shapes", () => {
  expect(setJsonServer(JSON.stringify({ mcpServers: { anynotate: { command: "/a", args: ["mcp"], env: { X: "1" } } } }), ["/a"])).toEqual({ unchanged: true });
  expect(setJsonServer("{nope", ["/a"])).toMatchObject({ error: expect.stringContaining("not valid JSON") });
  expect(setJsonServer("[]", ["/a"])).toMatchObject({ error: expect.any(String) });
  expect(setJsonServer('{"mcpServers":[]}', ["/a"])).toMatchObject({ error: expect.any(String) });
});

test("setTomlServer appends our table and keeps the rest of the file byte for byte", () => {
  const before = '# my settings\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "x"\nargs = ["y"] # keep\n';
  const r = setTomlServer(before, ["/opt/a b/anynotate"]);
  if (!("text" in r)) throw new Error(JSON.stringify(r));
  expect(r.text.startsWith(before)).toBe(true);
  const parsed = Bun.TOML.parse(r.text) as any;
  expect(parsed.mcp_servers.anynotate).toEqual({ command: "/opt/a b/anynotate", args: ["mcp"] });
  expect(parsed.mcp_servers.other).toEqual({ command: "x", args: ["y"] });
});

test("setTomlServer updates command and args in place and keeps the user's other keys and subtables", () => {
  const before = '[mcp_servers.anynotate]\ncommand = "/old"\nargs = [\n  "x",\n  "mcp",\n]\nstartup_timeout_sec = 20 # mine\n\n[mcp_servers.anynotate.env]\nA = "1"\n\n# next\n[profiles.x]\nmodel = "y"\n';
  const r = setTomlServer(before, ["/new"]);
  if (!("text" in r)) throw new Error(JSON.stringify(r));
  const parsed = Bun.TOML.parse(r.text) as any;
  expect(parsed.mcp_servers.anynotate).toEqual({ command: "/new", args: ["mcp"], startup_timeout_sec: 20, env: { A: "1" } });
  expect(r.text).toContain("startup_timeout_sec = 20 # mine");
  expect(parsed.profiles).toEqual({ x: { model: "y" } });
  expect(r.text).toContain("# next\n[profiles.x]");
  expect(r.text.indexOf("/new")).toBeLessThan(r.text.indexOf("[profiles.x]"));
});

test("setTomlServer writes Windows paths as valid TOML strings", () => {
  const r = setTomlServer("", ["C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe"]);
  if (!("text" in r)) throw new Error(JSON.stringify(r));
  expect((Bun.TOML.parse(r.text) as any).mcp_servers.anynotate.command).toBe("C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe");
});

test("setTomlServer refuses an unparseable file and a form it cannot edit", () => {
  expect(setTomlServer("model = \n[[", ["/a"])).toMatchObject({ error: expect.stringContaining("not valid TOML") });
  expect(setTomlServer('mcp_servers.anynotate.command = "/x"\n', ["/a"])).toMatchObject({ error: expect.any(String) });
  expect(setTomlServer('[mcp_servers]\nanynotate = { command = "/x" }\n', ["/a"])).toMatchObject({ error: expect.any(String) });
});

test("setTomlServer leaves an identical entry alone", () => {
  expect(setTomlServer('[mcp_servers.anynotate]\ncommand = "/a"\nargs = ["mcp"]\n', ["/a"])).toEqual({ unchanged: true });
});

test("removeTomlServer drops only our tables", () => {
  const r = removeTomlServer('a = 1\n\n[mcp_servers.anynotate]\ncommand = "/a"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "x"\n');
  if (!("text" in r)) throw new Error(JSON.stringify(r));
  expect(Bun.TOML.parse(r.text)).toEqual({ a: 1, mcp_servers: { other: { command: "x" } } });
  expect(removeTomlServer("a = 1\n")).toEqual({ unchanged: true });
});

test("mcp install with no app flag lists the apps and what each flag would do, writing nothing", () => {
  mkdirSync(desktopDir(), { recursive: true });
  const o = opts();
  expect(runMcpSetup(["install"], o)).toBe(0);
  const text = o.out.join("\n");
  for (const flag of ["--claude-desktop", "--codex", "--cursor", "--claude-code"]) expect(text).toContain(flag);
  expect(text).toMatch(/Claude Desktop +not configured/);
  expect(text).toMatch(/Cursor +app not found/);
  expect(existsSync(desktopFile())).toBe(false);
});

test("mcp install --claude-desktop creates the config when there is none", () => {
  mkdirSync(desktopDir(), { recursive: true });
  const o = opts();
  expect(runMcpSetup(["install", "--claude-desktop"], o)).toBe(0);
  expect(readJson(desktopFile())).toEqual({ mcpServers: { anynotate: { command: ENTRY[0], args: ["mcp"] } } });
  expect(o.out.join("\n")).toContain("Restart Claude Desktop");
});

test("mcp install --cursor keeps unrelated servers and writes a timestamped backup", () => {
  const file = join(home, ".cursor", "mcp.json");
  mkdirSync(join(home, ".cursor"));
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x", args: ["y"] } } }));
  const o = opts();
  expect(runMcpSetup(["install", "--cursor"], o)).toBe(0);
  expect(readJson(file).mcpServers).toEqual({ other: { command: "x", args: ["y"] }, anynotate: { command: ENTRY[0], args: ["mcp"] } });
  const [bak] = backups(join(home, ".cursor"));
  expect(bak).toBe(`mcp.json.bak-anynotate-20261003T123456Z`);
  expect(readJson(join(home, ".cursor", bak!))).toEqual({ mcpServers: { other: { command: "x", args: ["y"] } } });
});

test("a second install changes nothing and writes no backup", () => {
  mkdirSync(join(home, ".cursor"));
  runMcpSetup(["install", "--cursor"], opts());
  const o = opts();
  expect(runMcpSetup(["install", "--cursor"], o)).toBe(0);
  expect(backups(join(home, ".cursor"))).toHaveLength(0);
  expect(o.out.join("\n")).toContain("already configured");
});

test("mcp install refuses an unparseable config, leaves it untouched and exits 1", () => {
  const file = join(home, ".cursor", "mcp.json");
  mkdirSync(join(home, ".cursor"));
  writeFileSync(file, "{ oops");
  const o = opts();
  expect(runMcpSetup(["install", "--cursor"], o)).toBe(1);
  expect(readFileSync(file, "utf8")).toBe("{ oops");
  expect(o.out.join("\n")).toContain("refused");
});

test("mcp install --codex merges into config.toml with a backup", () => {
  const file = join(home, ".codex", "config.toml");
  mkdirSync(join(home, ".codex"));
  writeFileSync(file, 'model = "o3"\n');
  expect(runMcpSetup(["install", "--codex"], opts())).toBe(0);
  expect((Bun.TOML.parse(readFileSync(file, "utf8")) as any).mcp_servers.anynotate).toEqual({ command: ENTRY[0], args: ["mcp"] });
  expect(backups(join(home, ".codex"))).toHaveLength(1);
});

test("an app that is not found is skipped", () => {
  const o = opts();
  expect(runMcpSetup(["install", "--codex"], o)).toBe(0);
  expect(o.out.join("\n")).toContain("app not found");
  expect(existsSync(join(home, ".codex"))).toBe(false);
});

test("--claude-desktop on Linux reports unsupported", () => {
  const o = opts({ platform: "linux" as Platform });
  expect(runMcpSetup(["install", "--claude-desktop"], o)).toBe(0);
  expect(o.out.join("\n")).toContain("Linux");
});

test("--dry-run reports and writes nothing", () => {
  mkdirSync(join(home, ".cursor"));
  const o = opts();
  expect(runMcpSetup(["install", "--cursor", "--dry-run"], o)).toBe(0);
  expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  expect(o.out.join("\n")).toContain("would add anynotate");
});

test("--claude-code runs claude mcp add at user scope when claude is on PATH", () => {
  const o = opts({ which: (c) => (c === "claude" ? "/usr/local/bin/claude" : null) });
  expect(runMcpSetup(["install", "--claude-code"], o)).toBe(0);
  expect(o.ran).toEqual([["/usr/local/bin/claude", "mcp", "add", "--scope", "user", "anynotate", "--", ENTRY[0]!, "mcp"]]);
});

test("--claude-code replaces a different existing entry and skips an identical one", () => {
  const claude = (c: string) => (c === "claude" ? "/bin/claude" : null);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { anynotate: { type: "stdio", command: "/old", args: ["mcp"] } } }));
  const o = opts({ which: claude });
  runMcpSetup(["install", "--claude-code"], o);
  expect(o.ran.map((a) => a.slice(1, 3).join(" "))).toEqual(["mcp remove", "mcp add"]);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { anynotate: { type: "stdio", command: ENTRY[0], args: ["mcp"] } } }));
  const again = opts({ which: claude });
  runMcpSetup(["install", "--claude-code"], again);
  expect(again.ran).toEqual([]);
});

test("--claude-code without claude on PATH prints the command instead", () => {
  mkdirSync(join(home, ".claude"));
  const o = opts();
  expect(runMcpSetup(["install", "--claude-code"], o)).toBe(0);
  expect(o.ran).toEqual([]);
  expect(o.out.join("\n")).toContain(`claude mcp add --scope user anynotate -- ${ENTRY[0]} mcp`);
});

test("a failing claude command exits 1", () => {
  const o = opts({ which: () => "/bin/claude", exec: () => ({ code: 2, stdout: "", stderr: "boom" }) });
  expect(runMcpSetup(["install", "--claude-code"], o)).toBe(1);
  expect(o.out.join("\n")).toContain("boom");
});

test("mcp uninstall removes only our entry, with a backup", () => {
  const file = join(home, ".cursor", "mcp.json");
  mkdirSync(join(home, ".cursor"));
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" }, anynotate: { command: "/a", args: ["mcp"] } } }));
  expect(runMcpSetup(["uninstall", "--cursor"], opts())).toBe(0);
  expect(readJson(file)).toEqual({ mcpServers: { other: { command: "x" } } });
  expect(backups(join(home, ".cursor"))).toHaveLength(1);
  const o = opts();
  expect(runMcpSetup(["uninstall", "--cursor"], o)).toBe(0);
  expect(o.out.join("\n")).toContain("not configured");
});

test("mcp uninstall --codex and --claude-code", () => {
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), 'x = 1\n[mcp_servers.anynotate]\ncommand = "/a"\nargs = ["mcp"]\n');
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { anynotate: { command: "/a", args: ["mcp"] } } }));
  const o = opts({ which: (c) => (c === "claude" ? "/bin/claude" : null) });
  expect(runMcpSetup(["uninstall", "--codex", "--claude-code"], o)).toBe(0);
  expect(Bun.TOML.parse(readFileSync(join(home, ".codex", "config.toml"), "utf8"))).toEqual({ x: 1 });
  expect(o.ran).toEqual([["/bin/claude", "mcp", "remove", "--scope", "user", "anynotate"]]);
});

test("bad arguments print usage and exit 1", () => {
  for (const args of [[], ["install", "--nope"], ["frob"]]) {
    const o = opts();
    expect(runMcpSetup(args, o)).toBe(1);
    expect(o.out.join("\n")).toContain("usage: anynotate mcp");
  }
});

test("doctor checks: configured, not configured, stale, unreadable, not found", () => {
  mkdirSync(desktopDir(), { recursive: true });
  writeFileSync(desktopFile(), JSON.stringify({ mcpServers: { anynotate: { command: ENTRY[0], args: ["mcp"] } } }));
  mkdirSync(join(home, ".cursor"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), "[[[");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { anynotate: { command: "/old/anynotate", args: ["mcp"] } } }));
  const checks = mcpChecks(opts({ which: (c) => (c === "claude" ? "/bin/claude" : null) }));
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  expect(by["mcp (claude-desktop)"]).toMatchObject({ ok: true, mcp: "configured" });
  expect(by["mcp (cursor)"]).toMatchObject({ ok: "warn", mcp: "missing", detail: "Cursor is installed but not connected — run `anynotate mcp install --cursor`" });
  expect(by["mcp (codex)"]).toMatchObject({ ok: "warn", detail: expect.stringContaining("not valid TOML") });
  expect(by["mcp (claude-code)"]).toMatchObject({ ok: "warn", detail: expect.stringContaining("/old/anynotate") });
  const empty = mkdtempSync(join(tmpdir(), "anynotate-mcpi-empty-"));
  const none = mcpChecks(opts({ home: empty }));
  rmSync(empty, { recursive: true, force: true });
  expect(none.find((c) => c.name === "mcp (cursor)")).toMatchObject({ ok: true, detail: "app not found (skipped)" });
});

test("doctor lists the MCP checks when given the server entry, reading through its injected file access", async () => {
  const { runDoctor } = await import("../src/agent/doctor");
  const files: Record<string, string> = { "/home/me/.cursor/mcp.json": JSON.stringify({ mcpServers: { anynotate: { command: ENTRY[0], args: ["mcp"] } } }) };
  const base = {
    platform: "linux" as Platform,
    home: "/home/me",
    env: {},
    uid: 1,
    version: "1",
    exec: (() => ({ code: 0, stdout: "", stderr: "" })) as Exec,
    fetchHealth: async () => null,
    exists: (p: string) => p in files || p === "/home/me/.cursor",
    readFile: (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    },
    which: () => null,
    retention: () => ({ days: 30, source: "default" as const }),
  };
  expect((await runDoctor(base)).some((c) => c.name.startsWith("mcp ("))).toBe(false);
  const checks = await runDoctor({ ...base, mcpEntry: ENTRY });
  expect(checks.find((c) => c.name === "mcp (cursor)")).toMatchObject({ ok: true, mcp: "configured" });
  expect(checks.find((c) => c.name === "mcp (claude-desktop)")?.detail).toContain("Linux");
});

test("status names the apps with the MCP server configured", async () => {
  const { summarizeChecks } = await import("../src/agent/status");
  const checks = [
    { name: "bridge", ok: true as const, detail: "" },
    { name: "mcp (cursor)", ok: true as const, detail: "configured in x", mcp: "configured" as const },
    { name: "mcp (codex)", ok: true as const, detail: "not configured" },
    { name: "mcp (claude-code)", ok: true as const, detail: "configured in y", mcp: "configured" as const },
  ];
  expect(summarizeChecks(checks, "1").line).toBe("Anynotate 1 · bridge running · all checks passed · MCP: cursor, claude-code");
  expect(summarizeChecks(checks.slice(0, 1), "1").line).toBe("Anynotate 1 · bridge running · all checks passed");
});

test.skipIf(process.platform === "win32")("config writes keep the file's mode, leave no temp file, and make backups private", () => {
  const { chmodSync, statSync } = require("node:fs") as typeof import("node:fs");
  const dir = join(home, ".cursor");
  const file = join(dir, "mcp.json");
  mkdirSync(dir);
  writeFileSync(file, "{}");
  chmodSync(file, 0o640);
  expect(runMcpSetup(["install", "--cursor"], opts())).toBe(0);
  expect(statSync(file).mode & 0o777).toBe(0o640);
  const [bak] = backups(dir);
  expect(statSync(join(dir, bak!)).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir).sort()).toEqual([bak!, "mcp.json"].sort());
});

test.skipIf(process.platform === "win32")("a symlinked config stays a symlink and its target is updated in place", () => {
  const { lstatSync, statSync, symlinkSync } = require("node:fs") as typeof import("node:fs");
  const dotfiles = join(home, "dotfiles");
  const real = join(dotfiles, "mcp.json");
  mkdirSync(dotfiles);
  writeFileSync(real, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  mkdirSync(join(home, ".cursor"));
  const link = join(home, ".cursor", "mcp.json");
  symlinkSync(real, link);
  expect(runMcpSetup(["install", "--cursor"], opts())).toBe(0);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readJson(real).mcpServers).toEqual({ other: { command: "x" }, anynotate: { command: ENTRY[0], args: ["mcp"] } });
  expect(readdirSync(join(home, ".cursor"))).toEqual(["mcp.json"]);
  const [bak] = backups(dotfiles);
  expect(readdirSync(dotfiles).sort()).toEqual([bak!, "mcp.json"].sort());
  expect(statSync(join(dotfiles, bak!)).mode & 0o777).toBe(0o600);
});

test("a second backup in the same second gets its own name", () => {
  mkdirSync(join(home, ".cursor"));
  writeFileSync(join(home, ".cursor", "mcp.json"), "{}");
  runMcpSetup(["install", "--cursor"], opts());
  runMcpSetup(["uninstall", "--cursor"], opts());
  expect(backups(join(home, ".cursor"))).toHaveLength(2);
});

const prefsFile = () => join(home, ".anynotate", "mcp.json");
const cursorFile = () => join(home, ".cursor", "mcp.json");
const codexFile = () => join(home, ".codex", "config.toml");

test("auto install adds anynotate to every detected app and says to restart them", () => {
  mkdirSync(desktopDir(), { recursive: true });
  mkdirSync(join(home, ".cursor"));
  const o = opts({ which: (c) => (c === "claude" ? "/usr/local/bin/claude" : null) });
  autoMcpInstall(o);
  expect(readJson(desktopFile()).mcpServers.anynotate).toEqual({ command: ENTRY[0], args: ["mcp"] });
  expect(readJson(cursorFile()).mcpServers.anynotate).toEqual({ command: ENTRY[0], args: ["mcp"] });
  expect(existsSync(codexFile())).toBe(false);
  expect(o.ran).toEqual([["/usr/local/bin/claude", "mcp", "add", "--scope", "user", "anynotate", "--", ...ENTRY, "mcp"]]);
  expect(o.out.at(-1)).toBe("MCP: added to Claude Desktop, Cursor, Claude Code — restart them to load Anynotate");
});

test("auto install is idempotent and keeps the user's other servers", () => {
  mkdirSync(join(home, ".codex"));
  writeFileSync(codexFile(), '[mcp_servers.other]\ncommand = "x"\n');
  autoMcpInstall(opts());
  const o = opts();
  autoMcpInstall(o);
  expect((Bun.TOML.parse(readFileSync(codexFile(), "utf8")) as any).mcp_servers).toEqual({ other: { command: "x" }, anynotate: { command: ENTRY[0], args: ["mcp"] } });
  expect(o.out).toEqual(["MCP: already in Codex"]);
  expect(backups(join(home, ".codex"))).toHaveLength(1);
});

test("auto install with nothing detected says so", () => {
  const o = opts({ which: () => null });
  autoMcpInstall(o);
  expect(o.out).toEqual(["MCP: no desktop apps found (run `anynotate mcp install` later)"]);
  expect(existsSync(prefsFile())).toBe(false);
});

test("auto install finds Claude Desktop from the app bundle before its first launch", () => {
  mkdirSync(join(home, "Applications", "Claude.app"), { recursive: true });
  const o = opts();
  autoMcpInstall(o);
  expect(readJson(desktopFile()).mcpServers.anynotate.command).toBe(ENTRY[0]);
  expect(o.out.at(-1)).toBe("MCP: added to Claude Desktop — restart it to load Anynotate");
});

test("auto install leaves Claude Code alone when its CLI is not on PATH", () => {
  mkdirSync(join(home, ".claude"));
  const o = opts();
  autoMcpInstall(o);
  expect(o.ran).toEqual([]);
  expect(o.out).toEqual(["MCP: no desktop apps found (run `anynotate mcp install` later)"]);
});

test("auto install reports an app it cannot write and still adds the others", () => {
  mkdirSync(join(home, ".cursor"));
  writeFileSync(cursorFile(), "{broken");
  mkdirSync(join(home, ".codex"));
  const o = opts();
  autoMcpInstall(o);
  expect(readFileSync(cursorFile(), "utf8")).toBe("{broken");
  expect((Bun.TOML.parse(readFileSync(codexFile(), "utf8")) as any).mcp_servers.anynotate.command).toBe(ENTRY[0]);
  expect(o.out.at(-1)).toBe("MCP: added to Codex — restart it to load Anynotate; could not update Cursor (see above; fix it, then run `anynotate mcp install --cursor`)");
});

test("auto install survives a write error and a failing claude CLI", () => {
  mkdirSync(join(home, ".cursor"));
  writeFileSync(cursorFile(), "{}");
  const o = opts({
    which: (c) => (c === "claude" ? "/bin/claude" : null),
    exec: () => ({ code: 1, stdout: "", stderr: "boom" }),
    now: new Date("not a date"),
  });
  autoMcpInstall(o);
  expect(o.out.some((l) => l.startsWith("failed  cursor:"))).toBe(true);
  expect(o.out.at(-1)).toContain("could not update Cursor, Claude Code");
});

test("auto install --dry-run writes nothing", () => {
  mkdirSync(join(home, ".cursor"));
  const o = opts({ dryRun: true } as Partial<McpOptions>);
  autoMcpInstall({ ...o, dryRun: true });
  expect(existsSync(cursorFile())).toBe(false);
  expect(o.out.at(-1)).toBe("MCP: would add to Cursor");
});

test("opting out skips every app and tells how to connect later", () => {
  mkdirSync(join(home, ".cursor"));
  const o = opts();
  autoMcpInstall({ ...o, optOut: "--no-mcp" });
  expect(existsSync(cursorFile())).toBe(false);
  expect(o.out).toEqual(["MCP: skipped (--no-mcp); run `anynotate mcp install` to connect Claude Desktop, Cursor, Codex or Claude Code"]);
  expect(mcpOptedOut({ ANYNOTATE_NO_MCP: "1" })).toBe(true);
  expect(mcpOptedOut({ ANYNOTATE_NO_MCP: "true" })).toBe(true);
  expect(mcpOptedOut({ ANYNOTATE_NO_MCP: "0" })).toBe(false);
  expect(mcpOptedOut({})).toBe(false);
});

test("mcp uninstall --<app> is remembered so install and update leave that app out; mcp install clears it", () => {
  mkdirSync(join(home, ".cursor"));
  mkdirSync(join(home, ".codex"));
  autoMcpInstall(opts());
  expect(runMcpSetup(["uninstall", "--cursor"], opts())).toBe(0);
  expect(readDeclined(opts())).toEqual(["cursor"]);
  expect(readJson(prefsFile())).toEqual({ declined: ["cursor"] });
  const again = opts();
  autoMcpInstall(again);
  expect(readJson(cursorFile()).mcpServers.anynotate).toBeUndefined();
  expect(again.out.at(-1)).toBe("MCP: already in Codex; left out Cursor (turned off; `anynotate mcp install --cursor` adds it back)");
  const doctor = mcpChecks(opts()).find((c) => c.name === "mcp (cursor)");
  expect(doctor).toMatchObject({ ok: true, mcp: "off", detail: expect.stringContaining("you turned it off") });
  expect(runMcpSetup(["install", "--cursor"], opts())).toBe(0);
  expect(readDeclined(opts())).toEqual([]);
  expect(readJson(cursorFile()).mcpServers.anynotate.command).toBe(ENTRY[0]);
});

test("a dry-run uninstall records no choice, and ANYNOTATE_HOME moves the record", () => {
  mkdirSync(join(home, ".cursor"));
  runMcpSetup(["uninstall", "--cursor", "--dry-run"], hostOpts());
  expect(existsSync(prefsFile())).toBe(false);
  const data = join(home, "elsewhere");
  runMcpSetup(["uninstall", "--cursor"], hostOpts({ env: { ANYNOTATE_HOME: data } }));
  expect(readJson(join(data, "mcp.json"))).toEqual({ declined: ["cursor"] });
  expect(readDeclined(hostOpts())).toEqual([]);
});

test("detection on Linux: Cursor, Codex and Claude Code; never Claude Desktop", () => {
  mkdirSync(join(home, ".config", "Claude"), { recursive: true });
  const o = opts({ platform: "linux", which: (c) => ({ cursor: "/usr/bin/cursor", codex: "/usr/bin/codex", claude: "/usr/bin/claude" })[c] ?? null });
  autoMcpInstall(o);
  expect(existsSync(cursorFile())).toBe(true);
  expect(existsSync(codexFile())).toBe(true);
  expect(o.out.at(-1)).toBe("MCP: added to Codex, Cursor, Claude Code — restart them to load Anynotate");
});

test("detection on Windows: the MSIX package, the regular install dir and claude.cmd", () => {
  const W = "C:\\Users\\me";
  const local = `${W}\\AppData\\Local`;
  const msix = `${local}\\Packages\\Claude_pzs8sxrjxfjjc`;
  const base = { platform: "win32" as Platform, home: W, env: { LOCALAPPDATA: local, APPDATA: `${W}\\AppData\\Roaming` } };
  const state = (over: Partial<McpOptions>) => mcpChecks(opts({ ...base, ...over })).find((c) => c.name === "mcp (claude-desktop)")?.detail;
  expect(state({ exists: () => false, listDir: () => [] })).toBe("app not found (skipped)");
  expect(state({ exists: () => false, listDir: (p) => (p === `${local}\\Packages` ? ["Claude_pzs8sxrjxfjjc"] : []) })).toContain("not connected");
  expect(state({ exists: (p) => p === `${local}\\AnthropicClaude`, listDir: () => [] })).toContain("not connected");
  expect(state({ exists: (p) => p === `${msix}\\LocalCache\\Roaming\\Claude`, listDir: (p) => (p === `${local}\\Packages` ? ["Claude_pzs8sxrjxfjjc"] : []) })).toContain("not connected");
  const which = (c: string) => (c === "claude.cmd" ? `${W}\\AppData\\Roaming\\npm\\claude.cmd` : null);
  expect(findCli("claude", { platform: "win32", which })).toBe(`${W}\\AppData\\Roaming\\npm\\claude.cmd`);
  expect(findCli("claude", { platform: "win32", which: (c) => (c === "claude.exe" ? "C:\\bin\\claude.exe" : null) })).toBe("C:\\bin\\claude.exe");
  expect(findCli("claude", { platform: "darwin", which })).toBeNull();
  const o = opts({ ...base, which, exists: () => false, listDir: () => [] });
  autoMcpInstall(o);
  expect(o.ran).toEqual([[`${W}\\AppData\\Roaming\\npm\\claude.cmd`, "mcp", "add", "--scope", "user", "anynotate", "--", ...ENTRY, "mcp"]]);
});

test("doctor tells how to connect a detected app that is not connected", () => {
  mkdirSync(desktopDir(), { recursive: true });
  const c = mcpChecks(opts()).find((x) => x.name === "mcp (claude-desktop)");
  expect(c).toEqual({ name: "mcp (claude-desktop)", ok: "warn", mcp: "missing", detail: "Claude Desktop is installed but not connected — run `anynotate mcp install --claude-desktop`" });
});

test("--no-mcp records every detected app as declined so doctor stays quiet; ANYNOTATE_NO_MCP counts as declined", () => {
  mkdirSync(desktopDir(), { recursive: true });
  mkdirSync(join(home, ".cursor"));
  const o = opts();
  autoMcpInstall({ ...o, optOut: "--no-mcp", recordOptOut: true });
  expect(readDeclined(opts())).toEqual(["claude-desktop", "cursor"]);
  const checks = mcpChecks(opts());
  expect(checks.filter((c) => c.ok !== true)).toEqual([]);
  expect(checks.find((c) => c.name === "mcp (cursor)")?.mcp).toBe("off");
  const viaEnv = mkdtempSync(join(tmpdir(), "anynotate-mcpi-env-"));
  mkdirSync(join(viaEnv, ".cursor"));
  autoMcpInstall({ ...opts({ home: viaEnv }), optOut: "ANYNOTATE_NO_MCP=1" });
  const envChecks = mcpChecks(opts({ home: viaEnv, env: { ANYNOTATE_NO_MCP: "1" } }));
  rmSync(viaEnv, { recursive: true, force: true });
  expect(envChecks.filter((c) => c.ok !== true)).toEqual([]);
  expect(envChecks.find((c) => c.name === "mcp (cursor)")).toMatchObject({ mcp: "off", detail: expect.stringContaining("ANYNOTATE_NO_MCP") });
});

test("doctor does not ask to connect Claude Code when claude is not on PATH", () => {
  mkdirSync(join(home, ".claude"));
  const c = mcpChecks(opts()).find((x) => x.name === "mcp (claude-code)");
  expect(c).toMatchObject({ ok: true });
  expect(c?.mcp).toBeUndefined();
});

test("a malformed mcp.json stops auto-add for the run, says which file, and doctor reports it", () => {
  mkdirSync(join(home, ".cursor"));
  mkdirSync(join(home, ".anynotate"));
  writeFileSync(prefsFile(), "{oops");
  const o = hostOpts();
  autoMcpInstall(o);
  expect(existsSync(cursorFile())).toBe(false);
  expect(o.out).toEqual([`MCP: skipped — ${prefsFile()} is not valid JSON; fix or delete it, then run \`anynotate install\``]);
  const checks = mcpChecks(hostOpts());
  expect(checks.find((c) => c.name === "mcp settings")).toMatchObject({ ok: "warn", detail: expect.stringContaining(prefsFile()) });
  expect(checks.find((c) => c.name === "mcp (cursor)")?.ok).toBe(true);
  writeFileSync(prefsFile(), '{"declined":"cursor"}');
  const shape = hostOpts();
  autoMcpInstall(shape);
  expect(shape.out[0]).toContain("is not valid");
  expect(readFileSync(prefsFile(), "utf8")).toBe('{"declined":"cursor"}');
});

test("auto install leaves a custom entry alone and rewrites one that runs an older anynotate", () => {
  mkdirSync(join(home, ".cursor"));
  writeFileSync(cursorFile(), JSON.stringify({ mcpServers: { anynotate: { command: "/usr/bin/node", args: ["my-wrapper.js"] } } }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(codexFile(), '[mcp_servers.anynotate]\ncommand = "/old/place/anynotate"\nargs = ["mcp"]\n');
  mkdirSync(desktopDir(), { recursive: true });
  writeFileSync(desktopFile(), JSON.stringify({ mcpServers: { anynotate: { command: "/home/me/.bun/bin/bun", args: ["/src/anynotate/src/cli.ts", "mcp"] } } }));
  const o = opts();
  autoMcpInstall(o);
  expect(readJson(cursorFile()).mcpServers.anynotate.command).toBe("/usr/bin/node");
  expect((Bun.TOML.parse(readFileSync(codexFile(), "utf8")) as any).mcp_servers.anynotate.command).toBe(ENTRY[0]);
  expect(readJson(desktopFile()).mcpServers.anynotate.command).toBe(ENTRY[0]);
  expect(o.out.at(-1)).toBe("MCP: added to Claude Desktop, Codex — restart them to load Anynotate; left your custom entry in Cursor");
  const doctor = mcpChecks(opts()).find((c) => c.name === "mcp (cursor)");
  expect(doctor).toMatchObject({ ok: true, detail: expect.stringContaining("custom") });
});

test("a claude mcp add that hangs is given a timeout, reported, and the rest goes on", () => {
  mkdirSync(join(home, ".cursor"));
  const seen: unknown[] = [];
  const o = opts({
    which: (c) => (c === "claude" ? "/bin/claude" : null),
    exec: (_argv, _cwd, _env, x) => {
      seen.push(x);
      return { code: 124, stdout: "", stderr: "timed out after 30 s" };
    },
  });
  autoMcpInstall(o);
  expect(seen).toEqual([{ timeoutMs: CLAUDE_TIMEOUT_MS }]);
  expect(CLAUDE_TIMEOUT_MS).toBe(30_000);
  expect(o.out.some((l) => l.includes("timed out after 30 s"))).toBe(true);
  expect(existsSync(cursorFile())).toBe(true);
  expect(o.out.at(-1)).toContain("could not update Claude Code");
});

test("on Windows a claude.cmd is not given an anynotate path that cmd would mangle; the command is printed instead", () => {
  const which = (c: string) => (c === "claude.cmd" ? "C:\\npm\\claude.cmd" : null);
  const base = { platform: "win32" as Platform, home: "C:\\Users\\me", env: {}, exists: () => false, listDir: () => [] as string[], which };
  const o = opts({ ...base, entry: ["C:\\Users\\R&D 100%\\anynotate.exe"] });
  autoMcpInstall(o);
  expect(o.ran).toEqual([]);
  expect(o.out.some((l) => l.startsWith("manual ") && l.includes("claude.cmd"))).toBe(true);
  expect(o.out.at(-1)).toBe("MCP: add Claude Code by hand with the command above");
  const exe = opts({ ...base, which: (c: string) => (c === "claude.exe" ? "C:\\bin\\claude.exe" : null), entry: ["C:\\Users\\R&D 100%\\anynotate.exe"] });
  autoMcpInstall(exe);
  expect(exe.ran).toHaveLength(1);
});
