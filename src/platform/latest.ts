import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BUNDLE_ID } from "@anynotate/protocol";
import { currentPlatform, type Platform } from "./os";

export const LATEST = "latest";
// Not "LATEST": macOS and Windows file systems are case-insensitive, so that name would collide with the link.
export const LATEST_ID_FILE = "latest-id";

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

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
    rmSync(tmp, { force: true });
    if (p === "win32") symlinkSync(resolve(inboxDir, id), tmp, "junction");
    else symlinkSync(id, tmp);
    try {
      renameSync(tmp, link);
    } catch (err) {
      // Windows will not rename over an existing junction; drop the old one first.
      if (p !== "win32" || !isLink(link)) throw err;
      unlinkSync(link);
      renameSync(tmp, link);
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    // A link left pointing at an older bundle would win over the id file, so it goes.
    if (isLink(link)) rmSync(link, { force: true });
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
    if (isLink(link)) rmSync(link, { force: true });
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
