import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..", "..");
export const CLI = join(REPO, "src", "cli.ts");

// Runs the CLI from source with the current bun, so tests never depend on the bin/anynotate shebang.
export const cliArgv = (...args: string[]) => [process.execPath, CLI, ...args];

// Writes an executable that runs herdr-shim.ts: a .cmd on Windows, a sh script elsewhere. Returns its path.
export function writeHerdrShim(dir: string, platform: NodeJS.Platform = process.platform): string {
  const shim = join(import.meta.dir, "herdr-shim.ts");
  if (platform === "win32") {
    const path = join(dir, "herdr.cmd");
    writeFileSync(path, `@"${process.execPath}" "${shim}" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
    return path;
  }
  const path = join(dir, "herdr");
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${shim}' "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}
