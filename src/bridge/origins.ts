import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { anynotateHome } from "../inbox/paths";
import { makePrivateDir, writePrivateFile } from "../platform/files";

export const ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
export const originsPath = () => join(anynotateHome(), "origins");

export function readOrigins(path = originsPath()): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").map((s) => s.trim()).filter((s) => ORIGIN_RE.test(s));
}

function write(list: string[], path: string) {
  makePrivateDir(dirname(path));
  writePrivateFile(path, list.map((o) => `${o}\n`).join(""));
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
