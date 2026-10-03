import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStatus, writeBundle } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";
import { cliArgv } from "./fixtures/spawn";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anynotate-mcp-e2e-"));
  process.env.ANYNOTATE_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.ANYNOTATE_HOME;
});

test("anynotate mcp answers initialize, tools/list and read_notes over stdio with JSON-RPC lines only", async () => {
  const crop = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const b = writeBundle(sampleInput, { "page.md": new TextEncoder().encode("⟦A1⟧ cream"), "screenshot.png": crop, "crops/A1.png": crop });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_notes", arguments: {} } },
  ];
  const proc = Bun.spawn(cliArgv("mcp"), {
    env: { ...process.env, ANYNOTATE_HOME: home, HOME: home, USERPROFILE: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
  await proc.stdin.end();
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);

  const lines = stdout.split("\n");
  expect(lines.pop()).toBe("");
  const replies = lines.map((l) => JSON.parse(l));
  for (const r of replies) expect(r.jsonrpc).toBe("2.0");
  expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
  expect(replies[0].result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "anynotate" } });
  expect(replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual(["list_notes", "read_notes", "mark_done", "get_screenshot"]);
  const content = replies[2].result.content as { type: string; text?: string }[];
  expect(content[0]!.text).toContain("is there a substitute for cream?");
  expect(content.filter((c) => c.type === "image")).toHaveLength(1);
  expect(readStatus(b.id)).toMatchObject({ state: "delivered", via: "pull" });
}, 30_000);
