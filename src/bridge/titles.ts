import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TITLE_MAX = 60;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
const INDEX_BYTES = 1024 * 1024;
const CODEX_DAYS_SCANNED = 60;
const CACHE_MAX = 500;
export const MISS_RETRY_MS = 60_000;
const BLOB_RUN = /\S{200,}/;
const LONG_TOKEN = 32;
const UNBROKEN_RUN = /[A-Za-z0-9+_=]*\d[A-Za-z0-9+_=]*/g;
const SEPARATED_RUN = /[A-Za-z0-9+/=_.-]{32,}/g;
const MAX_SEPARATOR_SHARE = 0.1;
const KNOWN_SECRETS = [
  /-----BEGIN/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bgh[oprsu]_[A-Za-z0-9]{36,}/,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./,
  /\bAIza[0-9A-Za-z_-]{35}/,
];

const isTokenLike = (run: string) =>
  /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run) && (run.match(/[/.-]/g)?.length ?? 0) / run.length < MAX_SEPARATOR_SHARE;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LEADING_TAG_BLOCK = /^\s*<([A-Za-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/;

export type TitleRoots = { claudeProjects: string; codexHome: string };
export type TitleQuery = { agent: string; sessionId: string; cwd: string };

export function defaultTitleRoots(): TitleRoots {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return { claudeProjects: join(claudeHome, "projects"), codexHome };
}

export function cleanTitle(text: string): string {
  let t = text;
  for (let m = LEADING_TAG_BLOCK.exec(t); m; m = LEADING_TAG_BLOCK.exec(t)) t = t.slice(m[0].length);
  t = t.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  const chars = Array.from(t);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…` : t;
}

const isPlainFile = (path: string) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

function looksLikeSecretOrBlob(text: string): boolean {
  if (BLOB_RUN.test(text) || KNOWN_SECRETS.some((re) => re.test(text))) return true;
  if ((text.match(UNBROKEN_RUN) ?? []).some((run) => run.length >= LONG_TOKEN)) return true;
  return (text.match(SEPARATED_RUN) ?? []).some(isTokenLike);
}

const promptTitle = (text: string) => (looksLikeSecretOrBlob(text) ? "" : cleanTitle(text));

function readSlice(path: string, start: number, length: number): string {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) return "";
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function headRows(path: string, size: number, max = HEAD_BYTES): unknown[] {
  const lines = readSlice(path, 0, Math.min(size, max)).split("\n");
  if (size > max) lines.pop();
  return parseRows(lines);
}

function tailRows(path: string, size: number, max = TAIL_BYTES): unknown[] {
  const start = Math.max(0, size - max);
  const lines = readSlice(path, start, size - start).split("\n");
  if (start > 0) lines.shift();
  return parseRows(lines);
}

function parseRows(lines: string[]): unknown[] {
  const rows: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return rows;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown) => (typeof v === "string" ? v : "");

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => {
    const r = record(b);
    return r && (r.type === "text" || r.type === "input_text") ? [str(r.text)] : [];
  });
}

function firstPrompt(texts: string[], skip?: (t: string) => boolean): string | undefined {
  for (const text of texts) {
    if (skip?.(text)) continue;
    if (cleanTitle(text)) return promptTitle(text);
  }
  return undefined;
}

function claudeTitle(path: string, size: number): string {
  const latest: Record<string, string> = {};
  for (const row of tailRows(path, size)) {
    const r = record(row);
    if (!r) continue;
    if (r.type === "custom-title" && str(r.customTitle)) latest.custom = str(r.customTitle);
    if (r.type === "ai-title" && str(r.aiTitle)) latest.ai = str(r.aiTitle);
    if (r.type === "summary" && str(r.summary)) latest.summary = str(r.summary);
    if (r.type === "last-prompt" && str(r.lastPrompt)) latest.last = str(r.lastPrompt);
  }
  for (const key of ["custom", "ai", "summary"]) {
    const t = latest[key] ? cleanTitle(latest[key]) : "";
    if (t) return t;
  }
  for (const row of headRows(path, size)) {
    const r = record(row);
    if (!r || r.type !== "user" || r.isMeta || r.isSidechain || r.isCompactSummary || r.toolUseResult !== undefined) continue;
    const t = firstPrompt(textsOf(record(r.message)?.content));
    if (t !== undefined) return t;
  }
  return latest.last ? promptTitle(latest.last) : "";
}

const isAgentsPreamble = (t: string) => t.trimStart().startsWith("# AGENTS.md instructions");

function codexRolloutTitle(path: string, size: number): string {
  const rows = headRows(path, size).map(record);
  for (const r of rows) {
    const p = record(r?.payload);
    if (r?.type === "event_msg" && p?.type === "user_message" && cleanTitle(str(p.message))) return promptTitle(str(p.message));
  }
  for (const r of rows) {
    const p = record(r?.payload);
    if (r?.type !== "response_item" || p?.type !== "message" || p.role !== "user") continue;
    const t = firstPrompt(textsOf(p.content), isAgentsPreamble);
    if (t !== undefined) return t;
  }
  return "";
}

function codexThreadNames(path: string, size: number): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of tailRows(path, size, INDEX_BYTES)) {
    const r = record(row);
    const id = str(r?.id);
    const name = cleanTitle(str(r?.thread_name));
    if (id && name) names.set(id, name);
  }
  return names;
}

const sortedDesc = (dir: string) => readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a));

function findCodexRollout(sessionsDir: string, sessionId: string): string | undefined {
  if (!existsSync(sessionsDir)) return undefined;
  const suffix = `-${sessionId}.jsonl`;
  let days = 0;
  for (const y of sortedDesc(sessionsDir)) {
    for (const m of sortedDesc(join(sessionsDir, y))) {
      for (const d of sortedDesc(join(sessionsDir, y, m))) {
        const dir = join(sessionsDir, y, m, d);
        const hit = readdirSync(dir).find((n) => n.startsWith("rollout-") && n.endsWith(suffix) && isPlainFile(join(dir, n)));
        if (hit) return join(dir, hit);
        if (++days >= CODEX_DAYS_SCANNED) return undefined;
      }
    }
  }
  return undefined;
}

function findClaudeTranscript(projects: string, sessionId: string, cwd: string): string | undefined {
  const file = `${sessionId}.jsonl`;
  const direct = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), file);
  if (isPlainFile(direct)) return direct;
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects)) {
    const p = join(projects, dir, file);
    if (isPlainFile(p)) return p;
  }
  return undefined;
}

export function createTitler(roots: () => TitleRoots = defaultTitleRoots, now: () => number = Date.now): (q: TitleQuery) => string {
  const parsed = new Map<string, { key: string; value: unknown }>();
  const located = new Map<string, string>();
  const missedAt = new Map<string, number>();

  function cached<T>(path: string, read: (size: number) => T): T | undefined {
    if (!isPlainFile(path)) return undefined;
    const st = lstatSync(path);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = parsed.get(path);
    if (hit?.key === key) return hit.value as T;
    const value = read(st.size);
    if (parsed.size >= CACHE_MAX) parsed.clear();
    parsed.set(path, { key, value });
    return value;
  }

  function locate(id: string, find: () => string | undefined): string | undefined {
    const known = located.get(id);
    if (known && isPlainFile(known)) return known;
    const missed = missedAt.get(id);
    if (missed !== undefined && now() - missed < MISS_RETRY_MS) return undefined;
    const found = find();
    if (located.size >= CACHE_MAX) located.clear();
    if (missedAt.size >= CACHE_MAX) missedAt.clear();
    if (found) {
      located.set(id, found);
      missedAt.delete(id);
    } else {
      missedAt.set(id, now());
    }
    return found;
  }

  return ({ agent, sessionId, cwd }) => {
    try {
      if (!SAFE_ID.test(sessionId)) return "";
      const { claudeProjects, codexHome } = roots();
      if (agent === "claude") {
        const path = locate(`claude:${sessionId}`, () => findClaudeTranscript(claudeProjects, sessionId, cwd));
        return (path && cached(path, (size) => claudeTitle(path, size))) || "";
      }
      if (agent === "codex") {
        const index = join(codexHome, "session_index.jsonl");
        const name = cached(index, (size) => codexThreadNames(index, size))?.get(sessionId);
        if (name) return name;
        const path = locate(`codex:${sessionId}`, () => findCodexRollout(join(codexHome, "sessions"), sessionId));
        return (path && cached(path, (size) => codexRolloutTitle(path, size))) || "";
      }
      return "";
    } catch {
      return "";
    }
  };
}
