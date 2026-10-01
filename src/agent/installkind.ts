import { readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { Exec } from "../platform/exec";
import { writePrivateFile } from "../platform/files";
import type { Platform } from "../platform/os";

export type InstallKind = { kind: "binary"; exe: string } | { kind: "source"; repo: string; bun: string };

const isWinPath = (p: string) => /^[A-Za-z]:\\/.test(p);
const pathOf = (p: string) => (isWinPath(p) ? win32 : posix);

// A compiled binary runs its entry point from Bun's embedded file system; anything else is cli.ts under bun.
export function detectInstallKind(o: { execPath?: string; mainPath?: string } = {}): InstallKind {
  const execPath = o.execPath ?? process.execPath;
  const mainPath = o.mainPath ?? join(import.meta.dir, "..", "cli.ts");
  if (mainPath.startsWith("/$bunfs/") || mainPath.startsWith("B:\\~BUN\\")) return { kind: "binary", exe: execPath };
  const path = pathOf(mainPath);
  return { kind: "source", repo: path.resolve(path.dirname(mainPath), ".."), bun: execPath };
}

export const commandArgv = (k: InstallKind): string[] =>
  k.kind === "binary" ? [k.exe] : [k.bun, pathOf(k.repo).join(k.repo, "src", "cli.ts")];

// A command line for an agent's hook. POSIX shells get anything beyond plain path characters single-quoted (where
// nothing expands); on Windows, where cmd and Git Bash both run it, a path with spaces or cmd metacharacters is
// double-quoted, since Windows paths can't hold a double quote.
const POSIX_PLAIN = /^[A-Za-z0-9_./:@%+=,-]+$/;
const WIN32_QUOTE = /[\s&|<>^%!'();,=]/;
export const quoteArgv = (argv: string[], platform: Platform) =>
  argv
    .map((a) =>
      platform === "win32"
        ? WIN32_QUOTE.test(a) || a === "" ? `"${a}"` : a
        : POSIX_PLAIN.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");

// path is the binary for a binary install and the clone for a source install.
export type InstallRecord = { kind: "binary" | "source"; path: string; version: string; installedAt: string; platform: Platform };

export const INSTALL_RECORD = "install.json";

export const formatInstallRecord = (r: InstallRecord) => `${JSON.stringify(r, null, 2)}\n`;

export function readInstallRecord(dataDir: string): InstallRecord | null {
  try {
    const r = JSON.parse(readFileSync(join(dataDir, INSTALL_RECORD), "utf8"));
    if ((r?.kind !== "binary" && r?.kind !== "source") || typeof r.path !== "string" || typeof r.version !== "string") return null;
    if (!posix.isAbsolute(r.path) && !isWinPath(r.path)) return null;
    return r as InstallRecord;
  } catch {
    return null;
  }
}

export function writeInstallRecord(dataDir: string, r: InstallRecord, exec?: Exec): void {
  writePrivateFile(join(dataDir, INSTALL_RECORD), formatInstallRecord(r), undefined, exec);
}
