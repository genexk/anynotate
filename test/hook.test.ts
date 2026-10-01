import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverBundle, runHook } from "../src/agent/hook";
import { listSeen } from "../src/inbox/seen";
import { readStatus, updateStatus, writeBundle } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

const stdin = (o: object) => JSON.stringify({ hook_event_name: "x", prompt: "go", ...o });

test("claude: injects matching queued bundles and marks them delivered", () => {
  const b = writeBundle(sampleInput, {});
  const out = JSON.parse(runHook("claude", stdin({ session_id: "s-1", cwd: "/tmp/repo" })));
  expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  expect(out.hookSpecificOutput.additionalContext).toContain('Browser notes: "Tomato soup – Recipes"');
  expect(out.hookSpecificOutput.additionalContext).toContain(join(home, "inbox", b.id));
  expect(readStatus(b.id)).toMatchObject({ state: "delivered", via: "hook", session: "s-1" });
  expect(runHook("claude", stdin({ session_id: "s-1", cwd: "/tmp/repo" }))).toBe("");
});

test("gemini uses BeforeAgent", () => {
  writeBundle({ ...sampleInput, target: { agent: "gemini", cwd: "/g" } }, {});
  const out = JSON.parse(runHook("gemini", stdin({ session_id: "g", cwd: "/g" })));
  expect(out.hookSpecificOutput.hookEventName).toBe("BeforeAgent");
});

test("records the session as seen even with nothing queued", () => {
  expect(runHook("codex", stdin({ session_id: "c-9", cwd: "/c" }))).toBe("");
  expect(listSeen()[0]).toMatchObject({ agent: "codex", sessionId: "c-9", cwd: "/c" });
});

test("records the herdr pane the hook runs in, and none outside herdr", () => {
  const prev = process.env.HERDR_PANE_ID;
  try {
    process.env.HERDR_PANE_ID = "w3:p1";
    runHook("claude", stdin({ session_id: "in-pane", cwd: "/c" }));
    delete process.env.HERDR_PANE_ID;
    runHook("claude", stdin({ session_id: "no-pane", cwd: "/c" }));
  } finally {
    if (prev === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = prev;
  }
  const byId = Object.fromEntries(listSeen().map((s) => [s.sessionId, s]));
  expect(byId["in-pane"]!.pane).toBe("w3:p1");
  expect(byId["no-pane"]!.pane).toBeUndefined();
});

test("garbage stdin yields empty output, never throws", () => {
  expect(runHook("claude", "not json")).toBe("");
  expect(runHook("claude", "")).toBe("");
});

test("a bundle whose claimed status is no longer queued is skipped and left unchanged", () => {
  const b = writeBundle(sampleInput, {});
  updateStatus(b.id, "router", (s) => ({ ...s, state: "acked", via: "push", summary: "done" }));
  expect(deliverBundle(b.id, "hook-test", "s-1")).toBeNull();
  expect(readStatus(b.id)).toMatchObject({ state: "acked", via: "push", summary: "done" });
});

test("one unreadable bundle doesn't lose the others", () => {
  const first = writeBundle(sampleInput, {}, new Date(2026, 0, 1));
  const second = writeBundle(sampleInput, {}, new Date(2026, 5, 1));
  rmSync(join(home, "inbox", second.id, "README.md"));
  const out = JSON.parse(runHook("claude", stdin({ session_id: "s-1", cwd: "/tmp/repo" })));
  expect(out.hookSpecificOutput.additionalContext).toContain(join(home, "inbox", first.id));
  expect(out.hookSpecificOutput.additionalContext).not.toContain(second.id);
  expect(readStatus(first.id)).toMatchObject({ state: "delivered", via: "hook" });
  expect(readStatus(second.id)!.state).toBe("queued");
});

test("an agent without a known event gets UserPromptSubmit and its queued bundles", () => {
  const b = writeBundle({ ...sampleInput, target: { agent: "agy", cwd: "/a" } }, {});
  const out = JSON.parse(runHook("agy", stdin({ session_id: "a-1", cwd: "/a" })));
  expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  expect(out.hookSpecificOutput.additionalContext).toContain(b.id);
  expect(listSeen()[0]).toMatchObject({ agent: "agy", sessionId: "a-1" });
});
