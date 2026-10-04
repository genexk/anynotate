import { expect, test } from "bun:test";
import { colorDepth, formatAge, initialState, type InboxRow, lightBackground, renderInbox, statusLabel, textWidth, truncate } from "../src/agent/inbox-view";
import type { Pane } from "../src/bridge/herdr";

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
  const s = { ...initialState([row({ id: "a" }), row({ state: "acked" })]), width: 80, height: 8 };
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

const rows3 = [row({ id: "a", title: "First" }), row({ id: "b", title: "Second" }), row({ id: "c", title: "Third" })];
const TRUE = { now: NOW, color: true, depth: "truecolor" as const };
const lineOf = (lines: string[], text: string) => lines.find((l) => l.includes(text))!;

test("the selected row is reverse video across the full width and keeps its marker", () => {
  const lines = renderInbox({ ...initialState(rows3), sel: 1, width: 70, height: 10 }, TRUE);
  const sel = lineOf(lines, "Second");
  expect(sel.startsWith("\x1b[1;7m›")).toBe(true);
  expect(sel.endsWith("\x1b[0m")).toBe(true);
  expect(textWidth(plain([sel])[0]!)).toBe(70);
  expect(sel.slice(0, -4)).not.toContain("\x1b[0m");
});

test("non-selected rows alternate with a background stripe that survives the coloured status", () => {
  const lines = renderInbox({ ...initialState(rows3), sel: 0, width: 70, height: 10 }, TRUE);
  const second = lineOf(lines, "Second");
  expect(second.startsWith("\x1b[48;2;")).toBe(true);
  expect(second).toContain("\x1b[33m");
  expect(second.slice(0, -4)).not.toContain("\x1b[0m");
  expect(textWidth(plain([second])[0]!)).toBe(70);
  expect(lineOf(lines, "Third")).not.toContain("\x1b[48");
  const c256 = renderInbox({ ...initialState(rows3), width: 70, height: 10 }, { now: NOW, color: true, depth: "256" });
  expect(lineOf(c256, "Second")).toContain("\x1b[48;5;235m");
  const light = renderInbox({ ...initialState(rows3), width: 70, height: 10 }, { now: NOW, color: true, depth: "256", light: true });
  expect(lineOf(light, "Second")).toContain("\x1b[48;5;254m");
  const basic = renderInbox({ ...initialState(rows3), width: 70, height: 10 }, { now: NOW, color: true, depth: "16" });
  expect(basic.join("\n")).not.toContain("\x1b[48");
});

test("with colour off the rows are plain text: no stripes, no reverse video", () => {
  const lines = renderInbox({ ...initialState(rows3), sel: 1, width: 70, height: 10 }, { now: NOW, color: false, depth: "truecolor" });
  expect(lines.join("\n")).not.toContain("\x1b");
  expect(lineOf(lines, "Second").startsWith("›")).toBe(true);
});

test("colorDepth respects NO_COLOR and dumb terminals and detects 256 and truecolor", () => {
  expect(colorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }, "darwin")).toBe("none");
  expect(colorDepth({ TERM: "dumb" }, "linux")).toBe("none");
  expect(colorDepth({ COLORTERM: "truecolor" }, "linux")).toBe("truecolor");
  expect(colorDepth({ WT_SESSION: "x" }, "win32")).toBe("truecolor");
  expect(colorDepth({}, "win32")).toBe("256");
  expect(colorDepth({ TERM: "xterm-256color" }, "linux")).toBe("256");
  expect(colorDepth({ TERM: "xterm" }, "linux")).toBe("16");
  expect(colorDepth({ NO_COLOR: "" , TERM: "xterm" }, "linux")).toBe("16");
  expect(lightBackground({ COLORFGBG: "0;15" })).toBe(true);
  expect(lightBackground({ COLORFGBG: "15;0" })).toBe(false);
  expect(lightBackground({})).toBe(false);
});

const panes: Pane[] = [
  { pane: "w4:pV", agent: "claude", cwd: "/home/me/dash", title: "dashboard work", status: "idle", workspace: "research" },
  { pane: "w1:p2", agent: "codex", cwd: "/home/me/" + "deep/".repeat(30), title: "a very long terminal title ".repeat(4), status: "working" },
  { pane: "w2:p1", agent: "claude", cwd: "/home/me/docs", title: "docs", status: "idle", workspace: "docs" },
];
const picker = (sel: number, width: number) => ({ ...initialState([row()]), width, height: 12, mode: { kind: "picker" as const, id: row().id, panes, sel } });

test("the pane picker shows the workspace name before the pane id in an aligned column", () => {
  const lines = plain(renderInbox(picker(0, 100), { now: NOW, color: false }));
  const a = lineOf(lines, "research · w4:pV");
  const b = lineOf(lines, "w1:p2");
  const c = lineOf(lines, "docs · w2:p1");
  expect(a.indexOf("dashboard work")).toBe(b.indexOf("a very long"));
  expect(c.indexOf("docs —")).toBe(a.indexOf("dashboard work"));
  expect(lineOf(lines, "title — cwd")).toContain("pane");
});

test("pane picker rows are truncated to the width so they never wrap, and are striped and selected like the list", () => {
  for (const width of [40, 60, 100]) {
    for (const l of plain(renderInbox(picker(1, width), TRUE))) expect(textWidth(l)).toBeLessThanOrEqual(width);
  }
  const lines = renderInbox(picker(1, 60), TRUE);
  expect(lineOf(lines, "w1:p2").startsWith("\x1b[1;7m›")).toBe(true);
  expect(textWidth(plain([lineOf(lines, "w1:p2")])[0]!)).toBe(60);
  expect(lineOf(lines, "w4:pV")).not.toContain("\x1b[48");
  expect(lineOf(lines, "w2:p1")).not.toContain("\x1b[48");
  const sel0 = renderInbox(picker(0, 60), TRUE);
  expect(lineOf(sel0, "w1:p2").startsWith("\x1b[48;2;")).toBe(true);
});
