import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BUNDLE_ID } from "@anynotate/protocol";
import { currentPlatform, type Platform } from "./os";

export const LATEST = "latest";
// Not "LATEST": macOS and Windows file systems are case-insensitive, so that name would collide with the link.
export const LATEST_ID_FILE = "latest-id";

export const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

// Bun's rmSync fails on a Windows junction with EFAULT; unlink, or rmdir where unlink refuses a directory link,
// removes only the link and never the directory it points at.
export function removeLink(path: string): void {
  if (!isLink(path)) return;
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    rmdirSync(path);
  }
}

const removeTmp = (tmp: string) => (isLink(tmp) ? removeLink(tmp) : rmSync(tmp, { force: true }));

function writeIdFile(inboxDir: string, id: string): void {
  const path = join(inboxDir, LATEST_ID_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${id}\n`);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// A relative symlink on macOS and Linux; a junction (which needs an absolute target and no privilege) on Windows.
function writeLink(inboxDir: string, id: string, p: Platform): void {
  const link = join(inboxDir, LATEST);
  const tmp = `${link}.tmp-${process.pid}`;
  try {
    removeTmp(tmp);
    if (p === "win32") symlinkSync(resolve(inboxDir, id), tmp, "junction");
    else symlinkSync(id, tmp);
    try {
      renameSync(tmp, link);
    } catch (err) {
      // Windows will not rename over an existing junction; drop the old one first.
      if (p !== "win32" || !isLink(link)) throw err;
      removeLink(link);
      renameSync(tmp, link);
    }
  } catch (err) {
    try {
      removeTmp(tmp);
    } catch {}
    // A link left pointing at an older bundle would win over the id file, so it goes.
    try {
      removeLink(link);
    } catch {}
    console.error(`anynotate: could not update ${link}:`, err);
  }
}

// The id file is always written so readers have one fallback that works everywhere; the link is a convenience for humans.
export function writeLatest(inboxDir: string, id: string, p: Platform = currentPlatform()): void {
  try {
    writeIdFile(inboxDir, id);
  } catch (err) {
    console.error(`anynotate: could not update ${join(inboxDir, LATEST_ID_FILE)}:`, err);
  }
  writeLink(inboxDir, id, p);
}

export function clearLatest(inboxDir: string): void {
  try {
    const link = join(inboxDir, LATEST);
    removeLink(link);
    rmSync(join(inboxDir, LATEST_ID_FILE), { force: true });
  } catch (err) {
    console.error(`anynotate: could not clear ${join(inboxDir, LATEST)}:`, err);
  }
}

export function readLatest(inboxDir: string): string | null {
  const link = join(inboxDir, LATEST);
  if (isLink(link)) {
    try {
      const id = basename(readlinkSync(link));
      if (BUNDLE_ID.test(id) && existsSync(join(inboxDir, id))) return id;
    } catch {}
  }
  try {
    const id = readFileSync(join(inboxDir, LATEST_ID_FILE), "utf8").trim();
    if (BUNDLE_ID.test(id)) return id;
  } catch {}
  return null;
}
