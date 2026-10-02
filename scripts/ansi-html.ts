const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

const FG: Record<number, string> = { 30: "black", 31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan", 37: "white" };

type Style = { bold: boolean; dim: boolean; fg?: string };

function classes(s: Style): string[] {
  return [s.bold ? "b" : "", s.dim ? "d" : "", s.fg ? `fg-${s.fg}` : ""].filter(Boolean);
}

function apply(s: Style, params: string): Style {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  let next = { ...s };
  for (const c of codes) {
    if (c === 0) next = { bold: false, dim: false };
    else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 22) next = { ...next, bold: false, dim: false };
    else if (c === 39) next.fg = undefined;
    else if (FG[c]) next.fg = FG[c];
  }
  return next;
}

export function ansiToHtml(line: string): string {
  let style: Style = { bold: false, dim: false };
  let out = "";
  let at = 0;
  const emit = (text: string) => {
    if (!text) return;
    const cls = classes(style);
    out += cls.length ? `<span class="${cls.join(" ")}">${escapeHtml(text)}</span>` : escapeHtml(text);
  };
  for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    emit(line.slice(at, m.index));
    style = apply(style, m[1]!);
    at = m.index! + m[0].length;
  }
  emit(line.slice(at));
  return out;
}
