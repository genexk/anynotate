import { expect, test } from "bun:test";
import { formatAge, initialState, type InboxRow, renderInbox, statusLabel, textWidth, truncate } from "../src/agent/inbox-view";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const row = (over: Partial<InboxRow> = {}): InboxRow => ({
  id: "2026-09-24T110000-page",
  title: "A page",
  target: "claude · w1:p2",
  state: "queued",
  notes: 2,
  sentAt: "2026-09-24T11:00:00Z",
  archived: false,
  ...over,
});
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

test("textWidth counts wide characters as two columns and combining marks as none", () => {
  expect(textWidth("abc")).toBe(3);
  expect(textWidth("日本語")).toBe(6);
  expect(textWidth("🍅 soup")).toBe(7);
  expect(textWidth("é")).toBe(1);
});

test("truncate never exceeds the width, even when a wide character straddles the edge", () => {
  expect(truncate("hello world", 8)).toBe("hello w…");
  expect(truncate("short", 8)).toBe("short");
  const cut = truncate("日本語のページ", 6);
  expect(textWidth(cut)).toBeLessThanOrEqual(6);
  expect(cut.endsWith("…")).toBe(true);
  expect(truncate("abc", 0)).toBe("");
});

test("formatAge picks the largest whole unit", () => {
  expect(formatAge("2026-09-24T11:59:30Z", NOW)).toBe("30s");
  expect(formatAge("2026-09-24T11:15:00Z", NOW)).toBe("45m");
  expect(formatAge("2026-09-24T09:00:00Z", NOW)).toBe("3h");
  expect(formatAge("2026-09-20T12:00:00Z", NOW)).toBe("4d");
  expect(formatAge("garbage", NOW)).toBe("?");
});

test("statusLabel shows acked bundles as read", () => {
  expect(statusLabel("queued")).toBe("queued");
  expect(statusLabel("delivered")).toBe("delivered");
  expect(statusLabel("acked")).toBe("read ✓");
  expect(statusLabel("busy")).toBe("busy");
});

test("the list shows the header, one line per bundle and a key hint, all within the width", () => {
  const rows = [row({ title: "Newest", state: "acked" }), row({ id: "2026-09-24T100000-b", title: "Older", state: "delivered", notes: 1 })];
  const lines = plain(renderInbox({ ...initialState(rows), width: 80, height: 12 }, { now: NOW, color: false }));
  expect(lines).toHaveLength(12);
  expect(lines[0]).toContain("Anynotate inbox");
  const body = lines.join("\n");
  expect(body).toContain("read ✓");
  expect(body).toContain("delivered");
  expect(body).toContain("Newest");
  expect(body).toContain("claude · w1:p2");
  expect(body).toMatch(/1h/);
  expect(lines.find((l) => l.includes("Newest"))!.startsWith("›")).toBe(true);
  expect(lines.at(-1)).toContain("q quit");
  for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(80);
});

test("long and wide titles are truncated to the terminal width", () => {
  const lines = plain(renderInbox({ ...initialState([row({ title: "🍅".repeat(60) })]), width: 50, height: 8 }, { now: NOW, color: false }));
  for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(50);
  expect(lines.join("\n")).toContain("…");
});

test("statuses are coloured unless colour is off", () => {
  const s = { ...initialState([row({ state: "acked" })]), width: 80, height: 8 };
  expect(renderInbox(s, { now: NOW, color: true }).join("\n")).toContain("\x1b[32m");
  expect(renderInbox(s, { now: NOW, color: false }).join("\n")).not.toContain("\x1b[");
});

test("an empty inbox says so", () => {
  const lines = plain(renderInbox({ ...initialState([]), width: 60, height: 8 }, { now: NOW, color: false }));
  expect(lines.join("\n")).toContain("No browser notes yet");
});

test("the list scrolls so the selected row stays visible", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row({ id: `2026-09-24T1000${String(i).padStart(2, "0")}-p`, title: `Page ${i}` }));
  const lines = plain(renderInbox({ ...initialState(rows), sel: 25, width: 60, height: 10 }, { now: NOW, color: false }));
  expect(lines.find((l) => l.startsWith("›"))).toContain("Page 25");
});
