import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import extensionIds from "../../assets/extension-ids.json";
import { compareVersions } from "../agent/selfupdate";
import { anynotateHome } from "../inbox/paths";
import { makePrivateDir } from "../platform/files";

export const EXPECTED_EXTENSION = "0.3.1";
export const EXTENSION_HEADER = "X-Anynotate-Extension";
// Stands for an extension that sent no version: every release before EXPECTED_EXTENSION.
export const UNKNOWN_EXTENSION = "unknown";
export const EXTENSIONS_FILE = "extensions.json";
export const LEGACY_EXTENSION_FILE = "extension-version";
export const EXTENSION_UPDATE_HINT = "update it in chrome://extensions or wait for the store update";

const MAX_LENGTH = 40;
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,20})?$/;

export const isVersion = (v: string) => v.length <= MAX_LENGTH && VERSION_RE.test(v);

// A missing or malformed header both read as an extension too old to say.
export const senderFromHeader = (value: string | null): string =>
  value !== null && isVersion(value.trim()) ? value.trim() : UNKNOWN_EXTENSION;

// What a stored sender file says, or null when it says nothing trustworthy.
export function parseSender(text: string | null): string | null {
  const v = text?.trim();
  if (!v) return null;
  return v === UNKNOWN_EXTENSION || isVersion(v) ? v : null;
}

// A prerelease of the expected version counts as that version, so dev builds don't flag themselves.
export function extensionIsOlder(sender: string, expected = EXPECTED_EXTENSION): boolean {
  if (sender === UNKNOWN_EXTENSION) return true;
  return compareVersions(sender.replace(/-.*$/, ""), expected.replace(/-.*$/, "")) < 0;
}

export function senderNote(sender: string | null, expected = EXPECTED_EXTENSION): string | null {
  if (!sender || !extensionIsOlder(sender, expected)) return null;
  const from = sender === UNKNOWN_EXTENSION ? "an older extension" : `extension ${sender}`;
  return `Note: sent from ${from}; ${expected} or later is expected, so some details may be missing.`;
}

export type SeenExtension = { origin: string; version: string; lastSeen: string };

const [DEV_ID, STORE_ID] = extensionIds as string[];
const ORIGIN_RE = /^[a-z][a-z0-9+.-]{0,30}:\/\/[A-Za-z0-9.-]{1,64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
export const EXTENSION_TTL_MS = 14 * DAY_MS;
export const MAX_EXTENSIONS = 20;
export const RECORD_INTERVAL_MS = 5 * 60 * 1000;

export function extensionLabel(origin: string): string {
  if (!origin) return "build not recorded";
  const id = origin.replace(/^[^:]+:\/\//, "");
  if (id === STORE_ID) return "Chrome Web Store";
  if (id === DEV_ID) return "dev build";
  return `unpacked build ${id.slice(0, 4)}…`;
}

const isSeenExtension = (e: any): e is SeenExtension =>
  typeof e?.origin === "string" && (e.origin === "" || ORIGIN_RE.test(e.origin))
  && typeof e.version === "string" && parseSender(e.version) === e.version
  && typeof e.lastSeen === "string" && !Number.isNaN(Date.parse(e.lastSeen));

// Newest first, one entry per origin and version, none older than the TTL, at most MAX_EXTENSIONS.
// A lastSeen more than a day ahead of the clock is dropped, so a skewed clock can't keep an entry forever.
function prune(list: SeenExtension[], now: Date): SeenExtension[] {
  const cutoff = now.getTime() - EXTENSION_TTL_MS;
  const latest = now.getTime() + DAY_MS;
  const keep = new Map<string, SeenExtension>();
  for (const e of list.filter((e) => Date.parse(e.lastSeen) <= latest).sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))) {
    const key = `${e.origin} ${e.version}`;
    if (Date.parse(e.lastSeen) >= cutoff && !keep.has(key)) keep.set(key, e);
  }
  return [...keep.values()].slice(0, MAX_EXTENSIONS);
}

export function parseExtensions(text: string | null, now: Date): SeenExtension[] {
  if (!text) return [];
  try {
    const list: unknown = JSON.parse(text)?.extensions;
    return Array.isArray(list) ? prune(list.filter(isSeenExtension), now) : [];
  } catch {
    return [];
  }
}

export const extensionsPath = (home = anynotateHome()) => join(home, EXTENSIONS_FILE);

export function readExtensions(path = extensionsPath(), now = new Date()): SeenExtension[] {
  try {
    return parseExtensions(readFileSync(path, "utf8"), now);
  } catch {
    return [];
  }
}

// The 0.6.4 file named only the last version, so it seeds one entry with no origin and is removed once the list is written.
function load(file: string, now: Date): { entries: SeenExtension[]; legacy: string | null } {
  try {
    return { entries: parseExtensions(readFileSync(file, "utf8"), now), legacy: null };
  } catch {}
  const legacy = join(dirname(file), LEGACY_EXTENSION_FILE);
  try {
    const version = parseSender(readFileSync(legacy, "utf8"));
    const seed = version ? [{ origin: "", version, lastSeen: statSync(legacy).mtime.toISOString() }] : [];
    return { entries: prune(seed, now), legacy };
  } catch {
    return { entries: [], legacy: null };
  }
}

// Remembers each extension origin and version seen in ~/.anynotate, rewriting a known one at most every RECORD_INTERVAL_MS.
export function extensionRecorder(opts: { path?: () => string; now?: () => Date } = {}) {
  const path = opts.path ?? (() => extensionsPath());
  const now = opts.now ?? (() => new Date());
  let file: string | undefined;
  let entries: SeenExtension[] = [];
  let legacy: string | null = null;
  return (sender: string, origin: string): void => {
    const f = path();
    const t = now();
    if (f !== file) {
      file = f;
      ({ entries, legacy } = load(f, t));
    }
    const known = entries.find((e) => e.origin === origin && e.version === sender);
    if (known && !legacy && t.getTime() - Date.parse(known.lastSeen) < RECORD_INTERVAL_MS) return;
    const next = prune([{ origin, version: sender, lastSeen: t.toISOString() }, ...entries.filter((e) => e !== known)], t);
    try {
      makePrivateDir(dirname(f));
      const tmp = `${f}.tmp-${process.pid}`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, `${JSON.stringify({ extensions: next }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(tmp, f);
      entries = next;
      if (legacy) rmSync(legacy, { force: true });
      legacy = null;
    } catch (err) {
      console.error("anynotate: could not record the extension version:", err);
    }
  };
}
