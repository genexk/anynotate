import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { defaultTitleRoots, findClaudeTranscript, isPlainFile, MISS_RETRY_MS, OPEN_FLAGS, SAFE_ID, type TitleRoots } from "./titles";

export type Published = { id: string; at: string };

const PUBLISHED_MAX = 50;
const CACHE_MAX = 500;
const CHUNK_BYTES = 1024 * 1024;
const LINE_MAX = 1024 * 1024;
const NEWLINE = 0x0a;
const MARKER = "frame-link";
const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]{1,64})(?:[/?#]|$)/;

export function artifactIdOf(url: string): string | null {
  return ARTIFACT_URL.exec(url)?.[1] ?? null;
}

type PathState = { offset: number; firstAt: Map<string, { at: string; ms: number }> };

function collect(text: string, firstAt: PathState["firstAt"]): void {
  for (const line of text.split("\n")) {
    if (!line.includes(MARKER)) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.type !== "frame-link" || typeof r.frameUrl !== "string" || typeof r.timestamp !== "string") continue;
    const id = artifactIdOf(r.frameUrl);
    const ms = Date.parse(r.timestamp);
    if (!id || Number.isNaN(ms)) continue;
    const seen = firstAt.get(id);
    if (!seen || ms < seen.ms) firstAt.set(id, { at: r.timestamp, ms });
  }
}

// Reads complete lines in [state.offset, size) and advances the offset to just past the last newline,
// so a line still being written is picked up whole on the next call.
function readAppended(path: string, size: number, state: PathState): void {
  const fd = openSync(path, OPEN_FLAGS);
  try {
    if (!fstatSync(fd).isFile()) return;
    let pos = state.offset;
    let pending = Buffer.alloc(0);
    let skipping = false;
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - pos));
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      let data = pending.length ? Buffer.concat([pending, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      if (skipping) {
        const nl = data.indexOf(NEWLINE);
        if (nl < 0) {
          state.offset = pos;
          pending = Buffer.alloc(0);
          continue;
        }
        data = data.subarray(nl + 1);
        skipping = false;
      }
      const last = data.lastIndexOf(NEWLINE);
      if (last >= 0) collect(data.subarray(0, last).toString("utf8"), state.firstAt);
      pending = Buffer.from(data.subarray(last + 1));
      state.offset = pos - pending.length;
      if (pending.length > LINE_MAX) {
        state.offset = pos;
        pending = Buffer.alloc(0);
        skipping = true;
      }
    }
  } finally {
    closeSync(fd);
  }
}

export function createArtifactIndex(
  roots: () => TitleRoots = defaultTitleRoots,
  now: () => number = Date.now,
): (q: { sessionId: string; cwd: string }) => Published[] {
  const states = new Map<string, PathState>();
  const located = new Map<string, string>();
  const missedAt = new Map<string, number>();

  function locate(sessionId: string, cwd: string): string | undefined {
    const known = located.get(sessionId);
    if (known && isPlainFile(known)) return known;
    const missed = missedAt.get(sessionId);
    if (missed !== undefined && now() - missed < MISS_RETRY_MS) return undefined;
    const found = findClaudeTranscript(roots().claudeProjects, sessionId, cwd);
    if (located.size >= CACHE_MAX) located.clear();
    if (missedAt.size >= CACHE_MAX) missedAt.clear();
    if (found) {
      located.set(sessionId, found);
      missedAt.delete(sessionId);
    } else {
      missedAt.set(sessionId, now());
    }
    return found;
  }

  return ({ sessionId, cwd }) => {
    try {
      if (!SAFE_ID.test(sessionId)) return [];
      const path = locate(sessionId, cwd);
      if (!path || !isPlainFile(path)) return [];
      const { size } = lstatSync(path);
      let state = states.get(path);
      if (!state || size < state.offset) {
        if (!state && states.size >= CACHE_MAX) states.clear();
        state = { offset: 0, firstAt: new Map() };
        states.set(path, state);
      }
      if (size > state.offset) readAppended(path, size, state);
      return [...state.firstAt]
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, PUBLISHED_MAX)
        .map(([id, { at }]) => ({ id, at }));
    } catch {
      return [];
    }
  };
}
