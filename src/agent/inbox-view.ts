import type { Pane } from "../bridge/herdr";

export type RowState = "queued" | "delivered" | "acked" | "busy";

export type InboxRow = {
  id: string;
  title: string;
  target: string;
  state: RowState;
  notes: number;
  sentAt: string;
  archived: boolean;
};

export type Mode =
  | { kind: "list" }
  | { kind: "view"; id: string; title: string; lines: string[]; top: number }
  | { kind: "picker"; id: string; panes: Pane[] | null; error?: string; sel: number }
  | { kind: "confirm"; id: string }
  | { kind: "help" };

export type InboxState = {
  rows: InboxRow[];
  sel: number;
  top: number;
  archive: boolean;
  mode: Mode;
  message?: string;
  width: number;
  height: number;
};

export type ColorDepth = "none" | "16" | "256" | "truecolor";

export type RenderOptions = { now: number; color: boolean; depth?: ColorDepth; light?: boolean };

const TRUECOLOR_PROGRAMS = new Set(["iTerm.app", "WezTerm", "ghostty", "vscode"]);

export function colorDepth(env: Record<string, string | undefined>, platform: string = process.platform): ColorDepth {
  if (env.NO_COLOR) return "none";
  const term = env.TERM ?? "";
  if (term === "dumb") return "none";
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") || /-direct$|truecolor/.test(term)) return "truecolor";
  if (env.WT_SESSION || TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM ?? "")) return "truecolor";
  if (/256col/.test(term) || env.TERM_PROGRAM === "Apple_Terminal" || platform === "win32") return "256";
  return "16";
}

export function lightBackground(env: Record<string, string | undefined>): boolean {
  const bg = Number((env.COLORFGBG ?? "").split(";").at(-1));
  return bg === 7 || (bg >= 9 && bg <= 15);
}

const STRIPE: Partial<Record<ColorDepth, { dark: string; light: string }>> = {
  truecolor: { dark: "48;2;28;32;40", light: "48;2;238;240;244" },
  "256": { dark: "48;5;235", light: "48;5;254" },
};

const stripeCode = (o: RenderOptions) => (o.color && o.depth ? STRIPE[o.depth]?.[o.light ? "light" : "dark"] : undefined);

const SELECTED = "1;7";

function styleRow(line: string, index: number, selected: boolean, o: RenderOptions): string {
  if (!o.color) return line;
  if (selected) return `\x1b[${SELECTED}m${line}\x1b[0m`;
  const stripe = index % 2 === 1 ? stripeCode(o) : undefined;
  return stripe ? `\x1b[${stripe}m${line}\x1b[0m` : line;
}

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const padTo = (line: string, width: number) => line + " ".repeat(Math.max(0, width - textWidth(stripAnsi(line))));

export const initialState = (rows: InboxRow[], archive = false): InboxState => ({
  rows,
  sel: 0,
  top: 0,
  archive,
  mode: { kind: "list" },
  width: 80,
  height: 24,
});

const ZERO_WIDTH: [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xe0100, 0xe01ef],
];
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693],
  [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f5], [0x26fa, 0x26fd], [0x2705, 0x2705],
  [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x2753, 0x2755], [0x2757, 0x2757],
  [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

const inRanges = (cp: number, ranges: [number, number][]) => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
};

export function charWidth(cp: number): number {
  if (cp === 0x200d || inRanges(cp, ZERO_WIDTH)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0)!);
  return w;
}

// Page titles and README text come from web pages: control characters would reach the terminal as escape sequences.
// Bidi embeddings, overrides and isolates would reorder the rest of the line on screen.
export const sanitize = (text: string) =>
  text.replace(/\t/g, "  ").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

export const fit = (text: string, width: number) => {
  const t = truncate(text, width);
  return t + " ".repeat(Math.max(0, width - textWidth(t)));
};

export function formatAge(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export const statusLabel = (state: RowState) => (state === "acked" ? "read ✓" : state);

const STATUS_COLOR: Record<RowState, string> = { queued: "33", delivered: "36", acked: "32", busy: "2" };

type Paint = (code: string, text: string) => string;
function sgrOff(code: string): string {
  const first = Number(code.split(";")[0]);
  if (first === 1 || first === 2) return "22";
  if ((first >= 30 && first <= 37) || (first >= 90 && first <= 97)) return "39";
  return "0";
}
const painter = (color: boolean): Paint => (color ? (code, text) => `\x1b[${code}m${text}\x1b[${sgrOff(code)}m` : (_code, text) => text);

export const listCapacity = (s: InboxState) => Math.max(1, s.height - 4);

export function scrollTo(sel: number, top: number, capacity: number): number {
  if (sel < top) return sel;
  if (sel >= top + capacity) return sel - capacity + 1;
  return top;
}

function listLines(s: InboxState, o: RenderOptions, paint: Paint): string[] {
  const w = s.width;
  if (!s.rows.length) {
    return ["", fit(s.archive ? "No browser notes yet (inbox and archive are empty)." : "No browser notes yet. Send some from the Anynotate extension.", w)];
  }
  const targetW = Math.min(22, Math.max(8, Math.floor((w - 26) / 3)));
  const fixed = 2 + 9 + 2 + 4 + 2 + 3 + 2 + targetW + 2;
  const titleW = Math.max(0, w - fixed);
  const header = paint("2", fit(`  ${fit("status", 9)}  ${"age".padStart(4)}  ${"#".padStart(3)}  ${fit("target", targetW)}  title`, w));
  const cap = listCapacity(s) - 1;
  const top = scrollTo(s.sel, Math.min(s.top, Math.max(0, s.rows.length - cap)), cap);
  const out = [header];
  for (const [i, r] of s.rows.slice(top, top + cap).entries()) {
    const index = top + i;
    const selected = index === s.sel;
    const title = sanitize(r.archived ? `(archived) ${r.title}` : r.title) || r.id;
    const label = fit(statusLabel(r.state), 9);
    const status = selected ? label : paint(STATUS_COLOR[r.state], label);
    const line = `${selected ? "›" : " "} ${status}  ${formatAge(r.sentAt, o.now).padStart(4)}  ${String(r.notes).padStart(3)}  ${fit(sanitize(r.target), targetW)}  ${truncate(title, titleW)}`;
    out.push(styleRow(padTo(line, w), index, selected, o));
  }
  return out;
}

const LIST_KEYS = "↑↓ move  ⏎ view  s send  d delete  a archive  r refresh  ? help  q quit";
const VIEW_KEYS = "↑↓ scroll  space/b page  s send  q back";
const PICKER_KEYS = "↑↓ choose  ⏎ send  Esc cancel";
const CONFIRM_KEYS = "y delete  n keep";

export const HELP_LINES = [
  "",
  "  ↑ ↓  k j      move",
  "  PgUp PgDn     move a page",
  "  Home End      first / last",
  "  Enter         read the bundle's README",
  "  s             send the bundle to a herdr agent pane",
  "  d             delete the bundle (asks first)",
  "  a             show or hide archived bundles",
  "  r             refresh",
  "  q  Esc        back / quit",
  "",
  "In the reader: ↑ ↓ scroll, space / b page, s send, q back.",
];

export function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const out: string[] = [];
  let line = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width) {
      const space = line.lastIndexOf(" ");
      if (space > 0 && ch !== " ") {
        out.push(line.slice(0, space));
        line = line.slice(space + 1);
      } else {
        out.push(line);
        line = "";
      }
      w = textWidth(line);
      if (ch === " " && line === "") continue;
    }
    line += ch;
    w += cw;
  }
  out.push(line);
  return out;
}

const wrapAll = (lines: string[], width: number) => lines.flatMap((l) => wrapLine(l, width));
const pageSize = (s: InboxState) => Math.max(1, s.height - 2);

function frame(s: InboxState, paint: Paint, head: string, body: string[], keys: string, message = s.message): string[] {
  const w = s.width;
  const h = Math.max(3, s.height);
  const footer = message === undefined ? [paint("2", fit(keys, w))] : [fit(sanitize(message), w), paint("2", fit(keys, w))];
  const lines = [paint("1", head), ...body.slice(0, h - 1 - footer.length)];
  while (lines.length < h - footer.length) lines.push("");
  return [...lines, ...footer].slice(0, h);
}

function splitHead(left: string, right: string, w: number): string {
  const gap = w - textWidth(left) - textWidth(right);
  return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : fit(left, w);
}

const selectedRow = (s: InboxState): InboxRow | undefined => s.rows[s.sel];
const rowTitle = (s: InboxState, id: string) => sanitize(s.rows.find((r) => r.id === id)?.title || id);

export const paneLabel = (p: Pane) => sanitize(p.workspace ? `${p.workspace} · ${p.pane}` : p.pane);

function pickerBody(s: InboxState, m: Extract<Mode, { kind: "picker" }>, o: RenderOptions, paint: Paint): string[] {
  const w = s.width;
  if (m.panes === null) return ["", fit("Looking for herdr agent panes…", w)];
  if (m.error !== undefined) return ["", fit(m.error, w)];
  if (!m.panes.length) return ["", fit("No herdr agent panes are open.", w)];
  const labels = m.panes.map(paneLabel);
  const labelW = Math.min(Math.max(4, ...labels.map(textWidth)), Math.max(8, Math.floor((w - 22) / 2)));
  const cols = (mark: string, agent: string, status: string, label: string, where: string) =>
    fit(`${mark} ${fit(agent, 8)}  ${fit(status, 8)}  ${fit(label, labelW)}  ${where}`, w);
  return [
    "",
    paint("2", cols(" ", "agent", "status", "pane", "title — cwd")),
    ...m.panes.map((p, i) => {
      const where = sanitize([p.title, p.cwd].filter(Boolean).join(" — "));
      return styleRow(cols(i === m.sel ? "›" : " ", sanitize(p.agent), sanitize(p.status), labels[i]!, where), i, i === m.sel, o);
    }),
  ];
}

export function renderInbox(s: InboxState, o: RenderOptions): string[] {
  const paint = painter(o.color);
  const w = s.width;
  const m = s.mode;
  if (m.kind === "view") {
    const lines = wrapAll(m.lines, w);
    const page = pageSize(s);
    const top = Math.min(m.top, Math.max(0, lines.length - page));
    const where = `${Math.min(lines.length, top + 1)}–${Math.min(lines.length, top + page)} of ${lines.length}`;
    return frame(s, paint, splitHead(sanitize(m.title), where, w), lines.slice(top, top + page), VIEW_KEYS, undefined);
  }
  if (m.kind === "help") return frame(s, paint, fit("Anynotate inbox · Keys", w), HELP_LINES.map((l) => fit(l, w)), "any key to go back", undefined);
  if (m.kind === "picker") {
    return frame(s, paint, fit(`Send “${rowTitle(s, m.id)}” to which agent pane?`, w), pickerBody(s, m, o, paint), PICKER_KEYS);
  }
  const count = `${s.rows.length} bundle${s.rows.length === 1 ? "" : "s"}${s.archive ? " · with archive" : ""}`;
  const body = listLines(s, o, paint);
  if (m.kind === "confirm") {
    return frame(s, paint, splitHead("Anynotate inbox", count, w), body, CONFIRM_KEYS, `Delete “${rowTitle(s, m.id)}”? This removes its folder. y/n`);
  }
  return frame(s, paint, splitHead("Anynotate inbox", count, w), body, LIST_KEYS);
}

export type Key = string;

const SEQUENCES: [string, Key][] = [
  ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"],
  ["\x1bOA", "up"], ["\x1bOB", "down"], ["\x1bOC", "right"], ["\x1bOD", "left"],
  ["\x1b[5~", "pgup"], ["\x1b[6~", "pgdn"], ["\x1b[H", "home"], ["\x1b[F", "end"],
  ["\x1bOH", "home"], ["\x1bOF", "end"], ["\x1b[1~", "home"], ["\x1b[4~", "end"],
  ["\x1b[7~", "home"], ["\x1b[8~", "end"], ["\x1b[3~", "delete"],
];

export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const seq = SEQUENCES.find(([s]) => rest.startsWith(s));
    if (seq) {
      keys.push(seq[1]);
      i += seq[0].length;
      continue;
    }
    if (rest.startsWith("\x1b[") || rest.startsWith("\x1bO")) {
      const m = /^\x1b[[O][0-9;]*[A-Za-z~]/.exec(rest);
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(rest.codePointAt(0)!);
    i += ch.length;
    if (ch === "\x1b") keys.push("esc");
    else if (ch === "\r" || ch === "\n") keys.push("enter");
    else if (ch === "\x03") keys.push("ctrl-c");
    else if (ch === " ") keys.push("space");
    else if (ch === "\x7f" || ch === "\b") keys.push("backspace");
    else keys.push(ch);
  }
  return keys;
}

// An escape sequence can arrive split across reads, so a trailing ESC, or ESC [ / ESC O with no final byte yet, is
// handed back as rest for the caller to prepend to the next read, or to parse alone once no more bytes come.
export function splitKeys(data: string): { keys: Key[]; rest: string } {
  const tail = /\x1b(?:\[[0-9;]*|O)?$/.exec(data);
  if (!tail) return { keys: parseKeys(data), rest: "" };
  return { keys: parseKeys(data.slice(0, tail.index)), rest: tail[0] };
}

export type Effect =
  | { kind: "quit" }
  | { kind: "refresh" }
  | { kind: "open"; id: string }
  | { kind: "panes"; id: string }
  | { kind: "deliver"; id: string; pane: string }
  | { kind: "delete"; id: string; archived: boolean };

export type Step = { state: InboxState; effect?: Effect };

function moveTo(s: InboxState, sel: number): InboxState {
  const clamped = Math.max(0, Math.min(s.rows.length - 1, sel));
  const cap = listCapacity(s) - 1;
  return { ...s, sel: clamped, top: scrollTo(clamped, s.top, cap), message: undefined };
}

const toList = (s: InboxState, message?: string): InboxState => ({ ...s, mode: { kind: "list" }, message });

function startSend(s: InboxState, id: string): Step {
  const r = s.rows.find((x) => x.id === id);
  if (r?.archived) return { state: toList(s, "That bundle is archived; only inbox bundles can be sent.") };
  return { state: { ...s, mode: { kind: "picker", id, panes: null, sel: 0 }, message: undefined }, effect: { kind: "panes", id } };
}

function listKey(s: InboxState, key: Key): Step {
  const page = Math.max(1, listCapacity(s) - 1);
  const row = selectedRow(s);
  switch (key) {
    case "q":
    case "esc":
    case "ctrl-c":
      return { state: s, effect: { kind: "quit" } };
    case "up":
    case "k":
      return { state: moveTo(s, s.sel - 1) };
    case "down":
    case "j":
      return { state: moveTo(s, s.sel + 1) };
    case "pgup":
      return { state: moveTo(s, s.sel - page) };
    case "pgdn":
      return { state: moveTo(s, s.sel + page) };
    case "home":
    case "g":
      return { state: moveTo(s, 0) };
    case "end":
    case "G":
      return { state: moveTo(s, s.rows.length - 1) };
    case "r":
      return { state: { ...s, message: undefined }, effect: { kind: "refresh" } };
    case "a":
      return { state: { ...s, archive: !s.archive, message: undefined }, effect: { kind: "refresh" } };
    case "?":
      return { state: { ...s, mode: { kind: "help" } } };
  }
  if (!row) return { state: s };
  switch (key) {
    case "enter":
      return { state: s, effect: { kind: "open", id: row.id } };
    case "s":
      return startSend(s, row.id);
    case "d":
    case "delete":
      return { state: { ...s, mode: { kind: "confirm", id: row.id }, message: undefined } };
  }
  return { state: s };
}

function viewKey(s: InboxState, m: Extract<Mode, { kind: "view" }>, key: Key): Step {
  const page = pageSize(s);
  const max = Math.max(0, wrapAll(m.lines, s.width).length - page);
  const scroll = (top: number): Step => ({ state: { ...s, mode: { ...m, top: Math.max(0, Math.min(max, top)) } } });
  switch (key) {
    case "ctrl-c":
      return { state: s, effect: { kind: "quit" } };
    case "q":
    case "esc":
    case "left":
    case "backspace":
      return { state: toList(s) };
    case "up":
    case "k":
      return scroll(Math.min(m.top, max) - 1);
    case "down":
    case "j":
    case "enter":
      return scroll(m.top + 1);
    case "space":
    case "pgdn":
    case "f":
      return scroll(m.top + page);
    case "b":
    case "pgup":
      return scroll(Math.min(m.top, max) - page);
    case "home":
    case "g":
      return scroll(0);
    case "end":
    case "G":
      return scroll(max);
    case "s":
      return startSend(s, m.id);
  }
  return { state: s };
}

function pickerKey(s: InboxState, m: Extract<Mode, { kind: "picker" }>, key: Key): Step {
  const n = m.panes?.length ?? 0;
  switch (key) {
    case "ctrl-c":
      return { state: s, effect: { kind: "quit" } };
    case "q":
    case "esc":
      return { state: toList(s) };
    case "up":
    case "k":
      return { state: { ...s, mode: { ...m, sel: Math.max(0, m.sel - 1) } } };
    case "down":
    case "j":
      return { state: { ...s, mode: { ...m, sel: Math.max(0, Math.min(n - 1, m.sel + 1)) } } };
    case "enter": {
      const pane = m.error === undefined ? m.panes?.[m.sel] : undefined;
      if (!pane) return { state: s };
      return {
        state: toList(s, `Sending “${rowTitle(s, m.id)}” to pane ${pane.pane} (${pane.agent})…`),
        effect: { kind: "deliver", id: m.id, pane: pane.pane },
      };
    }
  }
  return { state: s };
}

export function handleKey(s: InboxState, key: Key): Step {
  const m = s.mode;
  switch (m.kind) {
    case "list":
      return listKey(s, key);
    case "view":
      return viewKey(s, m, key);
    case "picker":
      return pickerKey(s, m, key);
    case "help":
      return key === "ctrl-c" ? { state: s, effect: { kind: "quit" } } : { state: toList(s) };
    case "confirm": {
      if (key === "ctrl-c") return { state: s, effect: { kind: "quit" } };
      if (key !== "y" && key !== "Y") return { state: toList(s, "Kept.") };
      const archived = s.rows.find((r) => r.id === m.id)?.archived ?? false;
      return { state: toList(s), effect: { kind: "delete", id: m.id, archived } };
    }
  }
}

export function withRows(s: InboxState, rows: InboxRow[]): InboxState {
  const current = selectedRow(s)?.id;
  const kept = current === undefined ? -1 : rows.findIndex((r) => r.id === current);
  const sel = kept >= 0 ? kept : Math.max(0, Math.min(rows.length - 1, s.sel));
  return { ...s, rows, sel, top: scrollTo(sel, Math.min(s.top, sel), listCapacity(s) - 1) };
}

export function withReadme(s: InboxState, id: string, text: string): InboxState {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").map(sanitize);
  return { ...s, mode: { kind: "view", id, title: rowTitle(s, id), lines, top: 0 }, message: undefined };
}

export function withPanes(s: InboxState, list: { panes: Pane[] } | { error: string; missing?: true }): InboxState {
  const m = s.mode;
  if (m.kind !== "picker") return s;
  if ("panes" in list) return { ...s, mode: { ...m, panes: list.panes, sel: 0, error: undefined } };
  const error = list.missing ? "herdr is not available here — run the inbox inside herdr to send to an agent pane." : `herdr agent list failed: ${list.error}`;
  return { ...s, mode: { ...m, panes: [], error } };
}

export function withSize(s: InboxState, width: number, height: number): InboxState {
  const next = { ...s, width: Math.max(20, width), height: Math.max(5, height) };
  return { ...next, top: scrollTo(next.sel, next.top, listCapacity(next) - 1) };
}
