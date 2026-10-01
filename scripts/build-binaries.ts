// Builds the self-contained release binaries and their SHA256SUMS.
// usage: bun scripts/build-binaries.ts [--out dist/bin] [--targets darwin-arm64,linux-x64,...]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Platform } from "../src/platform/os";

export type Target = { os: "darwin" | "linux" | "windows"; arch: "arm64" | "x64"; platform: Platform; bun: string };

const target = (os: Target["os"], arch: Target["arch"]): Target => ({
  os,
  arch,
  platform: os === "windows" ? "win32" : os,
  bun: `bun-${os}-${arch}${arch === "x64" ? "-baseline" : ""}`,
});

export const TARGETS: Target[] = [
  target("darwin", "arm64"),
  target("darwin", "x64"),
  target("linux", "x64"),
  target("linux", "arm64"),
  target("windows", "x64"),
];

export const outfileFor = (t: Target) => `anynotate-${t.os}-${t.arch}${t.os === "windows" ? ".exe" : ""}`;

export const hostTarget = (platform: Platform, arch: string): Target | null =>
  TARGETS.find((t) => t.platform === platform && t.arch === arch) ?? null;

export const formatSums = (sums: { file: string; sha256: string }[]) =>
  [...sums]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((s) => `${s.sha256}  ${s.file}\n`)
    .join("");

export function parseArgs(argv: string[]): { out: string; targets: Target[] } {
  let out = "dist/bin";
  let targets = TARGETS;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--out" || flag === "--targets") {
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      i++;
      if (flag === "--out") out = value;
      else
        targets = value.split(",").map((name) => {
          const t = TARGETS.find((t) => `${t.os}-${t.arch}` === name.trim());
          if (!t) throw new Error(`unknown target ${name}`);
          return t;
        });
    } else {
      throw new Error("usage: bun scripts/build-binaries.ts [--out <dir>] [--targets <os-arch>,...]");
    }
  }
  return { out, targets };
}

const root = resolve(import.meta.dir, "..");

export function build(out: string, targets: Target[]): { file: string; sha256: string }[] {
  mkdirSync(out, { recursive: true });
  const sums = targets.map((t) => {
    const file = outfileFor(t);
    const outfile = join(out, file);
    const r = Bun.spawnSync(
      [process.execPath, "build", join(root, "src", "cli.ts"), "--compile", "--minify", `--target=${t.bun}`, "--outfile", outfile],
      { cwd: root, stdout: "inherit", stderr: "inherit" },
    );
    if (r.exitCode !== 0) throw new Error(`bun build failed for ${t.bun} (exit ${r.exitCode})`);
    return { file, sha256: createHash("sha256").update(readFileSync(outfile)).digest("hex") };
  });
  writeFileSync(join(out, "SHA256SUMS"), formatSums(sums));
  return sums;
}

if (import.meta.main) {
  try {
    const { out, targets } = parseArgs(process.argv.slice(2));
    for (const s of build(resolve(out), targets)) console.log(`${s.sha256}  ${s.file}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
