import { readFileSync } from "node:fs";
import { join } from "node:path";

export function releaseNotes(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body || undefined;
}

if (import.meta.main) {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version) {
    console.error("usage: bun scripts/release-notes.ts <version>");
    process.exit(2);
  }
  const changelog = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");
  const notes = releaseNotes(changelog, version);
  if (!notes) {
    console.error(`CHANGELOG.md has no notes for ${version}`);
    process.exit(1);
  }
  console.log(notes);
}
