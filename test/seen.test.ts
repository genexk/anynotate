import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSeen, touchSeen } from "../src/inbox/seen";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

test("touchSeen upserts and listSeen filters by age", () => {
  const t0 = new Date("2026-09-24T10:00:00Z");
  touchSeen("claude", "s-1", "/a", t0);
  touchSeen("gemini", "g-1", "/b", new Date("2026-09-24T20:00:00Z"));
  touchSeen("claude", "s-1", "/a2", new Date("2026-09-24T21:00:00Z"));
  const seen = listSeen(12 * 3600_000, new Date("2026-09-24T22:00:00Z"));
  expect(seen.map((s) => `${s.agent}:${s.sessionId}:${s.cwd}`)).toEqual(["claude:s-1:/a2", "gemini:g-1:/b"]);
  expect(listSeen(3600_000, new Date("2026-09-24T22:00:00Z")).length).toBe(1);
});

test("unsafe session ids are sanitised into file names", () => {
  touchSeen("codex", "../../x", "/c");
  expect(listSeen()[0]!.sessionId).toBe("../../x");
});

test("a pane is stored when given, and files written before panes existed still read", () => {
  touchSeen("claude", "s-1", "/a", new Date(), "w1:p1");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", "claude-old.json"), JSON.stringify({ agent: "claude", sessionId: "old", cwd: "/o", lastSeen: new Date().toISOString() }));
  const byId = Object.fromEntries(listSeen().map((s) => [s.sessionId, s]));
  expect(byId["s-1"]!.pane).toBe("w1:p1");
  expect(byId.old).toMatchObject({ sessionId: "old", cwd: "/o" });
  expect(byId.old!.pane).toBeUndefined();
});
