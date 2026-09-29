import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullTransition, runAnnotations } from "../src/agent/annotations";
import { readStatus, updateStatus, writeBundle } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

test("list shows id, status, target and title, newest first", () => {
  const a = writeBundle({ ...sampleInput, title: "older" }, {}, new Date(2026, 0, 1));
  const b = writeBundle({ ...sampleInput, title: "newer" }, {}, new Date(2026, 5, 1));
  updateStatus(a.id, "t", (s) => ({ ...s, state: "delivered", via: "herdr" }));
  const out = runAnnotations([]);
  expect(out.indexOf(b.id)).toBeLessThan(out.indexOf(a.id));
  expect(out).toContain(`${b.id}  queued  claude  "newer"`);
  expect(out).toContain(`${a.id}  delivered(herdr)  claude  "older"`);
});

test("latest prints README and marks pull", () => {
  const b = writeBundle(sampleInput, {});
  const out = runAnnotations(["latest"]);
  expect(out).toContain("# Browser notes:");
  expect(out).toContain(`Bundle folder: ${join(home, "inbox", b.id)}`);
  expect(readStatus(b.id)).toMatchObject({ state: "delivered", via: "pull" });
});

test("reading an already delivered bundle keeps its status", () => {
  const b = writeBundle(sampleInput, {});
  updateStatus(b.id, "t", (s) => ({ ...s, state: "acked", via: "push", summary: "ok" }));
  runAnnotations([b.id]);
  expect(readStatus(b.id)!.state).toBe("acked");
});

test("empty inbox and unknown id are friendly", () => {
  expect(runAnnotations([])).toBe("No browser notes yet.");
  expect(runAnnotations(["nope"])).toBe('No bundle "nope". Run `anynotate annotations` to list.');
});

test("invalid-looking ids get the same friendly message", () => {
  writeBundle(sampleInput, {});
  expect(runAnnotations(["../x"])).toBe('No bundle "../x". Run `anynotate annotations` to list.');
  expect(runAnnotations(["2026-01-01T000000-missing"])).toBe('No bundle "2026-01-01T000000-missing". Run `anynotate annotations` to list.');
});

test("the pull only rewrites a status that is still queued under the claim", () => {
  const b = writeBundle(sampleInput, {});
  const acked = { state: "acked" as const, via: "push" as const, summary: "ok", at: new Date().toISOString() };
  expect(pullTransition(acked)).toEqual(acked);
  expect(pullTransition({ state: "queued", at: acked.at })).toMatchObject({ state: "delivered", via: "pull" });
  runAnnotations([b.id]);
  expect(readStatus(b.id)).toMatchObject({ state: "delivered", via: "pull" });
});

test("`latest` prints the bundle inbox/latest points at", () => {
  writeBundle({ ...sampleInput, title: "zeta" }, {}, new Date(2026, 5, 1, 12, 0, 0));
  const b = writeBundle({ ...sampleInput, title: "alpha" }, {}, new Date(2026, 5, 1, 12, 0, 0));
  expect(runAnnotations(["latest"])).toContain(`Bundle folder: ${join(home, "inbox", b.id)}`);
});
