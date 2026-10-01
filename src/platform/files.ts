import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Exec, spawnExec } from "./exec";
import { currentPlatform, type Platform } from "./os";

// Windows has no mode bits, so access is cut down to the current user with an ACL instead. Best effort:
// a failing icacls leaves the default (per-user profile) ACL, which doctor reports rather than refusing.
function restrictToUser(path: string, grant: string, exec: Exec): void {
  const user = process.env.USERNAME;
  if (!user) return;
  const domain = process.env.USERDOMAIN;
  exec(["icacls", path, "/inheritance:r", "/grant:r", `${domain ? `${domain}\\${user}` : user}:${grant}`]);
}

// Dirs whose ACL this process has already rewritten.
const restricted = new Set<string>();

// Bundles hold private page content, so every anynotate dir is owner-only whichever writer runs first.
export function makePrivateDir(dir: string, p: Platform = currentPlatform(), exec: Exec = spawnExec): string {
  if (p === "win32") {
    // Once per dir per process: an ACL rewrite spawns a process, and this runs on every inbox access.
    mkdirSync(dir, { recursive: true });
    if (!restricted.has(dir)) {
      restricted.add(dir);
      restrictToUser(dir, "(OI)(CI)F", exec);
    }
    return dir;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return dir;
}

// Written to a temp file and renamed so a crash never leaves a half-written file; the temp file is
// restricted before the rename so the final path is never readable by others.
export function writePrivateFile(path: string, data: string, p: Platform = currentPlatform(), exec: Exec = spawnExec): void {
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    if (p === "win32") restrictToUser(tmp, "F", exec);
    else chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function isPrivate(path: string, p: Platform = currentPlatform()): boolean | "unknown" {
  if (p === "win32") return "unknown";
  return (statSync(path).mode & 0o077) === 0;
}
