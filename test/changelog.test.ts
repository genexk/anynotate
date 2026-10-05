import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseNotes } from "../scripts/release-notes";

const root = join(import.meta.dir, "..");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

test("CHANGELOG.md has notes for the package.json version", () => {
  expect(changelog).toMatch(new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
  expect(releaseNotes(changelog, version)).toContain("- ");
});

test("the newest section is the package.json version", () => {
  expect(changelog.match(/^## \[([^\]]+)\]/m)?.[1]).toBe(version);
});

const sample = `# Changelog

## [1.1.0] - 2026-01-02

### Added

- second

## [1.0.10] - 2026-01-01

### Fixed

- first
`;

test("extracts one section without its heading or the next one", () => {
  expect(releaseNotes(sample, "1.1.0")).toBe("### Added\n\n- second");
});

test("extracts the last section to the end of the file", () => {
  expect(releaseNotes(sample, "1.0.10")).toBe("### Fixed\n\n- first");
});

test("matches the exact version, not a prefix", () => {
  expect(releaseNotes(sample, "1.0.1")).toBeUndefined();
  expect(releaseNotes(sample, "2.0.0")).toBeUndefined();
});

test("handles CRLF line endings", () => {
  expect(releaseNotes(sample.replaceAll("\n", "\r\n"), "1.1.0")).toBe("### Added\n\n- second");
});

test("the script exits non-zero for a missing version", () => {
  const script = join(root, "scripts", "release-notes.ts");
  const ok = Bun.spawnSync([process.execPath, script, `v${version}`]);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString().trim()).toBe(releaseNotes(changelog, version)!);
  const missing = Bun.spawnSync([process.execPath, script, "0.0.0"]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("no notes for 0.0.0");
});
