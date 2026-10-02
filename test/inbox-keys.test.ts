import { expect, test } from "bun:test";
import type { Pane } from "../src/bridge/herdr";
import { handleKey, initialState, type InboxRow, type InboxState, parseKeys, renderInbox, sanitize, splitKeys, textWidth, withPanes, withReadme, withRows } from "../src/agent/inbox-view";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const row = (n: number, over: Partial<InboxRow> = {}): InboxRow => ({
  id: `2026-09-24T1100${String(n).padStart(2, "0")}-page`,
  title: `Page ${n}`,
  target: "claude",
  state: "queued",
  notes: 1,
  sentAt: "2026-09-24T11:00:00Z",
  archived: false,
  ...over,
});
const state = (n = 5, over: Partial<InboxState> = {}): InboxState => ({ ...initialState(Array.from({ length: n }, (_, i) => row(i))), width: 60, height: 10, ...over });
const press = (s: InboxState, ...keys: string[]) => {
  let effect;
  for (const k of keys) ({ state: s, effect } = handleKey(s, k));
  return { state: s, effect };
};
const text = (s: InboxState) => renderInbox(s, { now: NOW, color: false }).join("\n");
const PANES: Pane[] = [
  { pane: "w1:p1", agent: "codex", cwd: "/home/me/a", title: "a", status: "idle" },
  { pane: "w1:p2", agent: "claude", cwd: "/home/me/b", title: "b", status: "working" },
];

test("parseKeys turns raw terminal input into key names", () => {
  expect(parseKeys("\x1b[A\x1b[B")).toEqual(["up", "down"]);
  expect(parseKeys("\x1bOA")).toEqual(["up"]);
  expect(parseKeys("\x1b[5~\x1b[6~")).toEqual(["pgup", "pgdn"]);
  expect(parseKeys("\r")).toEqual(["enter"]);
  expect(parseKeys("\x1b")).toEqual(["esc"]);
  expect(parseKeys("\x03")).toEqual(["ctrl-c"]);
  expect(parseKeys("jk ")).toEqual(["j", "k", "space"]);
  expect(parseKeys("\x1b[H\x1b[F")).toEqual(["home", "end"]);
});

test("arrows and j/k move the selection within bounds", () => {
  expect(press(state(), "down", "j").state.sel).toBe(2);
  expect(press(state(), "up").state.sel).toBe(0);
  expect(press(state(), "down", "down", "k").state.sel).toBe(1);
  expect(press(state(3), "down", "down", "down", "down").state.sel).toBe(2);
});

test("page keys move by a screenful and keep the selection visible", () => {
  const s = press(state(40), "pgdn").state;
  expect(s.sel).toBeGreaterThan(1);
  expect(text(s)).toContain(`› queued`);
  expect(press(s, "pgup").state.sel).toBe(0);
  expect(press(state(40), "end").state.sel).toBe(39);
});

test("q, Esc and Ctrl-C quit from the list", () => {
  for (const k of ["q", "esc", "ctrl-c"]) expect(press(state(), k).effect).toEqual({ kind: "quit" });
});

test("Enter asks to open the selected bundle, and the README shows in a scrollable pager", () => {
  const { state: s, effect } = press(state(), "down", "enter");
  expect(effect).toEqual({ kind: "open", id: row(1).id });
  const readme = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const v = withReadme(s, row(1).id, readme);
  expect(v.mode.kind).toBe("view");
  expect(text(v)).toContain("line 0");
  const paged = press(v, "space").state;
  expect(text(paged)).not.toContain("line 0\n");
  expect(text(paged)).toContain("line 8");
  expect(text(press(paged, "b").state)).toContain("line 0");
  const back = press(paged, "q").state;
  expect(back.mode.kind).toBe("list");
  expect(back.sel).toBe(1);
});

test("the pager wraps long README lines to the width", () => {
  const v = withReadme(state(), row(0).id, `${"word ".repeat(40)}\n日本語`.repeat(1));
  for (const l of renderInbox(v, { now: NOW, color: false })) expect(textWidth(l)).toBeLessThanOrEqual(60);
  expect(text(v)).toContain("日本語");
});

test("s opens the pane picker and Enter delivers to the chosen pane", () => {
  const { state: s, effect } = press(state(), "down", "s");
  expect(effect).toEqual({ kind: "panes", id: row(1).id });
  expect(s.mode.kind).toBe("picker");
  expect(text(s)).toContain("Looking for herdr agent panes");
  const p = withPanes(s, { panes: PANES });
  expect(text(p)).toContain("codex");
  expect(text(p)).toContain("/home/me/b");
  const chosen = press(p, "down", "enter");
  expect(chosen.effect).toEqual({ kind: "deliver", id: row(1).id, pane: "w1:p2" });
  expect(chosen.state.mode.kind).toBe("list");
});

test("the picker explains when herdr is missing or no agent panes are open, and Esc backs out", () => {
  const s = press(state(), "s").state;
  const missing = withPanes(s, { error: "herdr not found: herdr", missing: true });
  expect(text(missing)).toContain("herdr is not available");
  expect(press(missing, "enter").effect).toBeUndefined();
  expect(text(withPanes(s, { panes: [] }))).toContain("No herdr agent panes");
  expect(press(missing, "esc").state.mode.kind).toBe("list");
});

test("archived bundles cannot be sent", () => {
  const s = withRows(state(), [row(0, { archived: true })]);
  const r = press(s, "s");
  expect(r.effect).toBeUndefined();
  expect(r.state.message).toContain("archived");
});

test("d asks for confirmation; n keeps the bundle, y asks to delete it", () => {
  const ask = press(state(), "down", "d");
  expect(ask.effect).toBeUndefined();
  expect(text(ask.state)).toContain("Delete");
  expect(text(ask.state)).toContain("y/n");
  const kept = press(ask.state, "n");
  expect(kept.effect).toBeUndefined();
  expect(kept.state.mode.kind).toBe("list");
  expect(press(ask.state, "y").effect).toEqual({ kind: "delete", id: row(1).id, archived: false });
});

test("r refreshes, a toggles the archive, ? shows help", () => {
  expect(press(state(), "r").effect).toEqual({ kind: "refresh" });
  const a = press(state(), "a");
  expect(a.effect).toEqual({ kind: "refresh" });
  expect(a.state.archive).toBe(true);
  const h = press(state(), "?").state;
  expect(text(h)).toContain("Keys");
  expect(press(h, "x").state.mode.kind).toBe("list");
});

test("keys do nothing harmful on an empty inbox", () => {
  const s = state(0);
  for (const k of ["down", "enter", "s", "d", "pgdn", "end"]) expect(press(s, k).effect).toBeUndefined();
});

test("withRows keeps the selection on the same bundle and clamps when it is gone", () => {
  const s = press(state(), "down", "down").state;
  expect(withRows(s, [row(9), ...s.rows]).sel).toBe(3);
  expect(withRows(s, [row(0)]).sel).toBe(0);
});

test("splitKeys holds back an escape sequence that has not finished arriving", () => {
  expect(splitKeys("j\x1b")).toEqual({ keys: ["j"], rest: "\x1b" });
  expect(splitKeys("\x1b[")).toEqual({ keys: [], rest: "\x1b[" });
  expect(splitKeys("\x1b[6")).toEqual({ keys: [], rest: "\x1b[6" });
  expect(splitKeys("\x1bO")).toEqual({ keys: [], rest: "\x1bO" });
  expect(splitKeys("\x1b\x1b[")).toEqual({ keys: ["esc"], rest: "\x1b[" });
  expect(splitKeys("\x1b[B")).toEqual({ keys: ["down"], rest: "" });
  expect(splitKeys("q")).toEqual({ keys: ["q"], rest: "" });
});

test("sanitize blanks control characters and bidi overrides and isolates", () => {
  expect(sanitize("a\x1b[2Jb")).toBe("a [2Jb");
  for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    expect(sanitize(`x${String.fromCodePoint(cp)}y`)).toBe("x y");
  }
  expect(sanitize("caf\u00e9 \u05e9\u05dc\u05d5\u05dd")).toBe("caf\u00e9 \u05e9\u05dc\u05d5\u05dd");
});
