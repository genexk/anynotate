import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "../agent/selfupdate";
import { anynotateHome, ensureHome } from "../inbox/paths";

export const EXPECTED_EXTENSION = "0.3.1";
export const EXTENSION_HEADER = "X-Anynotate-Extension";
// Stands for an extension that sent no version: every release before EXPECTED_EXTENSION.
export const UNKNOWN_EXTENSION = "unknown";
export const EXTENSION_FILE = "extension-version";
export const EXTENSION_UPDATE_HINT = "update it in chrome://extensions, or wait for the Chrome Web Store auto-update";

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

export const extensionStatePath = (home = anynotateHome()) => join(home, EXTENSION_FILE);

export function readLastExtension(path = extensionStatePath()): string | null {
  try {
    return parseSender(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Remembers the last version seen in ~/.anynotate, writing only when it changes.
export function extensionRecorder(path = extensionStatePath) {
  let last: string | null | undefined;
  let lastFile: string | undefined;
  return (sender: string): void => {
    const file = path();
    if (file !== lastFile) {
      lastFile = file;
      last = readLastExtension(file);
    }
    if (last === sender) return;
    try {
      ensureHome();
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${sender}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      last = sender;
    } catch (err) {
      console.error("anynotate: could not record the extension version:", err);
    }
  };
}
