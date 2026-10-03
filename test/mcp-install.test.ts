import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/platform/exec";
import type { Platform } from "../src/platform/os";
import { mcpChecks, type McpOptions, mcpTarget, removeTomlServer, runMcpSetup, setJsonServer, setTomlServer } from "../src/mcp/install";

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
  return { platform: "darwin", home, env: {}, entry: ENTRY, which: () => null, exec, now: NOW, log: (l) => out.push(l), ran, out, ...over };
}

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
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { anynotate: { command: "/old", args: ["mcp"] } } }));
  const checks = mcpChecks(opts({ which: (c) => (c === "claude" ? "/bin/claude" : null) }));
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  expect(by["mcp (claude-desktop)"]).toMatchObject({ ok: true, mcp: "configured" });
  expect(by["mcp (cursor)"]).toMatchObject({ ok: true, detail: expect.stringContaining("--cursor") });
  expect(by["mcp (codex)"]).toMatchObject({ ok: "warn", detail: expect.stringContaining("not valid TOML") });
  expect(by["mcp (claude-code)"]).toMatchObject({ ok: "warn", detail: expect.stringContaining("/old") });
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
