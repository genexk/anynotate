import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

let warnedRelativeHome = false;

// A blank ANYNOTATE_HOME means unset; a relative one would depend on the caller's cwd, so it is ignored with a warning.
export function anynotateHome(): string {
  const fallback = join(homedir(), ".anynotate");
  const value = process.env.ANYNOTATE_HOME?.trim();
  if (!value) return fallback;
  if (isAbsolute(value)) return value;
  if (!warnedRelativeHome) {
    warnedRelativeHome = true;
    console.error(`anynotate: ignoring relative ANYNOTATE_HOME=${JSON.stringify(value)}; using ${fallback}`);
  }
  return fallback;
}
export const inboxDir = () => join(anynotateHome(), "inbox");
export const archiveDir = () => join(anynotateHome(), "archive");
export const sessionsDir = () => join(anynotateHome(), "sessions");
export const tokenPath = () => join(anynotateHome(), "token");

// Bundles hold private page content, so every anynotate dir is owner-only whichever writer runs first.
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return dir;
}

export const ensureHome = () => ensurePrivateDir(anynotateHome());
