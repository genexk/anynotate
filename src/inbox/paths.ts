import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const anynotateHome = () => process.env.ANYNOTATE_HOME ?? join(homedir(), ".anynotate");
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
