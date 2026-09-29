import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { anynotateHome, ensurePrivateDir } from "../inbox/paths";

export const ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
export const originsPath = () => join(anynotateHome(), "origins");

export function readOrigins(path = originsPath()): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").map((s) => s.trim()).filter((s) => ORIGIN_RE.test(s));
}

// Written to a temp file and renamed so a crash never leaves a half-written allow-list.
function write(list: string[], path: string) {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, list.map((o) => `${o}\n`).join(""), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function addOrigin(origin: string, path = originsPath()): { added: boolean } {
  if (!ORIGIN_RE.test(origin)) throw new Error(`expected chrome-extension://<32 chars a-p>, got ${origin}`);
  const list = readOrigins(path);
  if (list.includes(origin)) return { added: false };
  write([...list, origin], path);
  return { added: true };
}

export function removeOrigin(origin: string): { removed: boolean } {
  const list = readOrigins();
  if (!list.includes(origin)) return { removed: false };
  write(list.filter((o) => o !== origin), originsPath());
  return { removed: true };
}
