import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import type { Check } from "../src/agent/doctor";
import { notifyArgv, summarizeChecks } from "../src/agent/status";
import { cliArgv, writeHerdrShim } from "./fixtures/spawn";

const pass = (name: string): Check => ({ name, ok: true, detail: "fine" });
const warn = (name: string): Check => ({ name, ok: "warn", detail: "meh" });

test("summarizeChecks names the bridge and counts warnings in one line", () => {
  expect(summarizeChecks([pass("install"), pass("bridge"), pass("token")], "0.5.0")).toEqual({ line: "Anynotate 0.5.0 · bridge running · all checks passed", code: 0 });
  expect(summarizeChecks([pass("install"), warn("on PATH"), pass("bridge"), warn("retention")], "0.5.0")).toEqual({ line: "Anynotate 0.5.0 · bridge running · 2 warnings", code: 0 });
  expect(summarizeChecks([warn("bridge"), pass("token")], "0.5.0").line).toBe("Anynotate 0.5.0 · bridge running · 1 warning");
});

test("summarizeChecks names the first failing check and exits 1", () => {
  const checks: Check[] = [
    pass("install"),
    { name: "service", ok: false, detail: "no unit — run `anynotate install`" },
    { name: "bridge", ok: false, detail: "not answering" },
    warn("retention"),
  ];
  expect(summarizeChecks(checks, "0.5.0")).toEqual({ line: "Anynotate 0.5.0 · bridge not running · service: no unit — run `anynotate install` (+1 more failed)", code: 1 });
  expect(summarizeChecks([{ name: "token", ok: false, detail: "missing" }, pass("bridge")], "0.5.0").line).toBe("Anynotate 0.5.0 · bridge running · token: missing");
});

test("summarizeChecks counts skipped checks apart from warnings", () => {
  const skipped: Check = { name: "service", ok: "warn", detail: "skipped (dry run)", skipped: true };
  expect(summarizeChecks([pass("bridge"), skipped, warn("x")], "0.5.0").line).toBe("Anynotate 0.5.0 · bridge running · 1 warning, 1 skipped");
});

test("notifyArgv uses herdr's notification show", () => {
  expect(notifyArgv("/bin/herdr", "Anynotate 0.5.0 · bridge running · all checks passed")).toEqual([
    "/bin/herdr", "notification", "show", "Anynotate", "--body", "Anynotate 0.5.0 · bridge running · all checks passed",
  ]);
});

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-status-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const cli = async (args: string[], extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANYNOTATE_HOME: join(home, "data"),
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    ANYNOTATE_EXTERNAL_DRYRUN: "1",
    ANYNOTATE_PORT: "1",
    ANYNOTATE_HERDR: writeHerdrShim(home),
    HERDR_SHIM_LOG: join(home, "herdr.log"),
    ...extra,
  };
  delete env.HERDR_BIN_PATH;
  const proc = Bun.spawn(cliArgv(...args), { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
};
const shimLog = () => (existsSync(join(home, "herdr.log")) ? readFileSync(join(home, "herdr.log"), "utf8") : "");

test("CLI status prints one summary line, mirrors doctor's exit code and notifies nobody without --notify", async () => {
  expect((await cli(["install"])).code).toBe(0);
  const r = await cli(["status"]);
  expect(r.code).toBe(1);
  expect(r.out.trimEnd().split("\n")).toHaveLength(1);
  expect(r.out).toStartWith(`Anynotate ${pkg.version} · bridge not running · bridge: not answering on http://127.0.0.1:1/health — see ${join(home, "data", "bridge.log")}`);
  expect(shimLog()).toBe("");
});

test("CLI status --notify sends the same line through herdr", async () => {
  const r = await cli(["status", "--notify"]);
  expect(r.code).toBe(1);
  const line = r.out.trim();
  expect(line).toStartWith(`Anynotate ${pkg.version} · bridge not running · install: `);
  expect(shimLog()).toBe(`notification show Anynotate --body ${line}\n`);
});

test("CLI status --notify still exits with doctor's code when herdr fails, and says why", async () => {
  const r = await cli(["status", "--notify"], { ANYNOTATE_HERDR: join(home, "no-such-herdr") });
  expect(r.code).toBe(1);
  expect(r.out.trim().split("\n")).toHaveLength(1);
  expect(r.err).toContain("anynotate: could not send the herdr notification");
});

test("CLI status rejects unknown flags", async () => {
  const r = await cli(["status", "--loud"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: anynotate status [--notify]");
});

test("summarizeChecks tells how to connect a detected app that has no MCP entry", () => {
  const checks: Check[] = [
    pass("bridge"),
    { name: "mcp (cursor)", ok: true, detail: "configured", mcp: "configured" },
    { name: "mcp (claude-desktop)", ok: "warn", detail: "not connected", mcp: "missing" },
    { name: "mcp (codex)", ok: "warn", detail: "not connected", mcp: "missing" },
  ];
  expect(summarizeChecks(checks, "0.6.3")).toEqual({
    line: "Anynotate 0.6.3 · bridge running · 2 warnings · MCP: cursor · MCP not connected: claude-desktop, codex — run `anynotate mcp install --claude-desktop --codex`",
    code: 0,
  });
});

test("summarizeChecks says MCP: off when MCP was turned off and nothing is connected", () => {
  const checks: Check[] = [pass("bridge"), { name: "mcp (cursor)", ok: true, detail: "off", mcp: "off" }];
  expect(summarizeChecks(checks, "0.6.3").line).toBe("Anynotate 0.6.3 · bridge running · all checks passed · MCP: off");
});

test("summarizeChecks lists each extension version seen with ✓ or ⚠", () => {
  const ext = (ok: Check["ok"], extension: string): Check => ({ name: "extension", ok, detail: "", extension });
  expect(summarizeChecks([pass("bridge"), ext(true, "0.3.1")], "0.6.5").line).toBe("Anynotate 0.6.5 · bridge running · all checks passed · Extensions: 0.3.1 ✓");
  expect(summarizeChecks([pass("bridge"), ext(true, "0.3.1"), ext("warn", "0.2.0")], "0.6.5").line).toBe(
    "Anynotate 0.6.5 · bridge running · 1 warning · Extensions: 0.3.1 ✓, 0.2.0 ⚠",
  );
  expect(summarizeChecks([pass("bridge"), ext(true, "0.3.1"), ext(true, "0.3.1")], "0.6.5").line).toEndWith("Extensions: 0.3.1 ✓");
  expect(summarizeChecks([pass("bridge"), ext("warn", "unknown")], "0.6.5").line).toEndWith("Extensions: older than 0.3.1 ⚠");
  expect(summarizeChecks([pass("bridge"), { name: "extension", ok: true, detail: "no extension seen yet" }], "0.6.5").line).toBe("Anynotate 0.6.5 · bridge running · all checks passed");
});
