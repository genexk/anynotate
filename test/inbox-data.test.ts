import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteBundle, loadRows, readReadme, rowFor } from "../src/agent/inbox-data";
import { claim, latestBundleId, updateStatus, writeBundle } from "../src/inbox/store";
import { readLatest } from "../src/platform/latest";
import { sampleInput } from "./fixtures/sample";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

const at = (h: number) => new Date(`2026-09-24T${String(h).padStart(2, "0")}:00:00`);
const archive = (id: string) => {
  mkdirSync(join(home, "archive"), { recursive: true });
  renameSync(join(home, "inbox", id), join(home, "archive", id));
};

test("rows come newest first with status, note count and a target label", () => {
  const a = writeBundle({ ...sampleInput, title: "Older" }, {}, at(9));
  const b = writeBundle({ ...sampleInput, title: "Newer", target: { agent: "codex", pane: "w1:p4" } }, {}, at(10));
  updateStatus(a.id, "t", (s) => ({ ...s, state: "acked" }));
  const rows = loadRows(false);
  expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
  expect(rows[0]).toMatchObject({ title: "Newer", state: "queued", notes: 1, target: "codex · w1:p4", archived: false });
  expect(rows[1]).toMatchObject({ state: "acked", target: "claude · s-1" });
});

test("the target label prefers the herdr pane a bundle was delivered to", () => {
  const b = writeBundle(sampleInput, {}, at(9));
  updateStatus(b.id, "t", (s) => ({ ...s, state: "delivered", via: "herdr", session: "w2:p1" }));
  expect(loadRows(false)[0]!.target).toBe("claude · w2:p1");
});

test("the target label names the agent of the pane a bundle was re-sent to", () => {
  const b = writeBundle(sampleInput, {}, at(9));
  updateStatus(b.id, "t", (s) => ({ ...s, state: "delivered", via: "herdr", session: "w3:p2", agent: "codex" }));
  expect(loadRows(false)[0]!.target).toBe("codex · w3:p2");
});

test("a bundle whose status is claimed shows as busy", () => {
  const b = writeBundle(sampleInput, {}, at(9));
  rmSync(join(home, "inbox", b.id, "status.json"));
  expect(rowFor(b, null).state).toBe("busy");
});

test("archived bundles appear only when asked for, marked as archived", () => {
  const a = writeBundle({ ...sampleInput, title: "Old" }, {}, at(8));
  const b = writeBundle({ ...sampleInput, title: "New" }, {}, at(9));
  archive(a.id);
  expect(loadRows(false).map((r) => r.id)).toEqual([b.id]);
  const all = loadRows(true);
  expect(all.map((r) => [r.id, r.archived])).toEqual([[b.id, false], [a.id, true]]);
});

test("readReadme reads from the inbox or the archive", () => {
  const a = writeBundle(sampleInput, {}, at(8));
  expect(readReadme(a.id, false)).toContain("Tomato soup");
  archive(a.id);
  expect(readReadme(a.id, true)).toContain("Tomato soup");
});

test("deleting the latest bundle removes its folder and points latest at the next newest", () => {
  const a = writeBundle({ ...sampleInput, title: "Old" }, {}, at(8));
  const b = writeBundle({ ...sampleInput, title: "New" }, {}, at(9));
  expect(deleteBundle(b.id, false)).toEqual({ ok: true });
  expect(existsSync(join(home, "inbox", b.id))).toBe(false);
  expect(readLatest(join(home, "inbox"))).toBe(a.id);
  expect(latestBundleId()).toBe(a.id);
});

test("an archived bundle is deleted from the archive", () => {
  const a = writeBundle(sampleInput, {}, at(8));
  archive(a.id);
  expect(deleteBundle(a.id, true)).toEqual({ ok: true });
  expect(existsSync(join(home, "archive", a.id))).toBe(false);
});

test("delete refuses anything that is not a bundle folder in the inbox", () => {
  const outside = join(home, "precious");
  mkdirSync(outside);
  writeFileSync(join(outside, "annotations.json"), "{}");
  for (const id of ["../precious", "..", "", "/etc", "not-a-bundle"]) {
    expect(deleteBundle(id, false)).toHaveProperty("error");
  }
  mkdirSync(join(home, "inbox"), { recursive: true });
  symlinkSync(outside, join(home, "inbox", "2026-09-24T100000-link"));
  expect(deleteBundle("2026-09-24T100000-link", false)).toHaveProperty("error");
  mkdirSync(join(home, "inbox", "2026-09-24T100000-empty"));
  expect(deleteBundle("2026-09-24T100000-empty", false)).toHaveProperty("error");
  expect(deleteBundle("2026-09-24T100000-missing", false)).toHaveProperty("error");
  expect(existsSync(join(outside, "annotations.json"))).toBe(true);
  expect(readFileSync(join(outside, "annotations.json"), "utf8")).toBe("{}");
});

test("delete refuses a bundle another process is updating", () => {
  const b = writeBundle(sampleInput, {}, at(8));
  expect(claim(b.id, "someone")).not.toBeNull();
  expect(deleteBundle(b.id, false)).toEqual({ error: expect.stringContaining("being updated") });
  expect(existsSync(join(home, "inbox", b.id))).toBe(true);
});
