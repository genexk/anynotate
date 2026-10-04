import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { decodeMessage, encodeMessage } from "../src/agent/native-host";
import { assetName } from "../src/agent/selfupdate";
import { currentPlatform } from "../src/platform/os";
import { formatSums, hostTarget, outfileFor, parseArgs, TARGETS } from "../scripts/build-binaries";

const repo = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(repo, rel), "utf8");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("the release is 0.6.2", () => {
  expect(pkg.version).toBe("0.6.2");
});

test("every target's file is the asset name self-update downloads", () => {
  expect(TARGETS.map((t) => t.bun)).toEqual(["bun-darwin-arm64", "bun-darwin-x64-baseline", "bun-linux-x64-baseline", "bun-linux-arm64", "bun-windows-x64-baseline"]);
  for (const t of TARGETS) expect(outfileFor(t)).toBe(assetName(t.platform, t.arch));
});

test("the host target is the one this machine runs", () => {
  const host = hostTarget(currentPlatform(), process.arch);
  expect(host && outfileFor(host)).toBe(assetName(currentPlatform(), process.arch));
  expect(hostTarget("linux", "ia32")).toBeNull();
});

test("SHA256SUMS lines are sorted by file name, two spaces apart", () => {
  expect(formatSums([{ file: "b", sha256: "22" }, { file: "a", sha256: "11" }])).toBe("11  a\n22  b\n");
});

test("--out and --targets narrow the build", () => {
  expect(parseArgs([])).toEqual({ out: "dist/bin", targets: TARGETS });
  const p = parseArgs(["--out", "/tmp/x", "--targets", "linux-x64,windows-x64"]);
  expect(p.out).toBe("/tmp/x");
  expect(p.targets.map(outfileFor)).toEqual(["anynotate-linux-x64", "anynotate-windows-x64.exe"]);
  expect(() => parseArgs(["--targets", "linux-ia32"])).toThrow("unknown target linux-ia32");
  expect(() => parseArgs(["--bogus"])).toThrow();
  expect(() => parseArgs(["--out", "--targets"])).toThrow("--out needs a value");
  expect(() => parseArgs(["--targets", "--out", "x"])).toThrow("--targets needs a value");
});

const compileWorks = (() => {
  try {
    return Bun.spawnSync([process.execPath, "build", "--help"]).stdout.toString().includes("--compile");
  } catch {
    return false;
  }
})();
const host = hostTarget(currentPlatform(), process.arch);

// Not on Windows: Bun 1.3.11 there cannot unpack the downloaded bun-windows-x64-baseline runtime ("Failed to extract
// executable"). Release binaries are cross-built on Linux, and the Windows smoke job runs that real artifact.
describe.skipIf(!compileWorks || !host || process.platform === "win32")("the compiled host binary", () => {
  test(
    "carries its version and every runtime asset, with nothing to read from the checkout",
    () => {
      const work = realpathSync(mkdtempSync(join(tmpdir(), "anynotate-build-")));
      try {
        const out = join(work, "bin");
        const built = Bun.spawnSync([process.execPath, join(repo, "scripts/build-binaries.ts"), "--out", out, "--targets", `${host!.os}-${host!.arch}`], {
          cwd: repo,
          stderr: "pipe",
        });
        if (built.exitCode !== 0) throw new Error(`build failed: ${built.stderr.toString()}`);
        const exe = join(out, outfileFor(host!));
        expect(readFileSync(join(out, "SHA256SUMS"), "utf8")).toBe(`${sha256(exe)}  ${outfileFor(host!)}\n`);

        const home = join(work, "home");
        const env = {
          PATH: "",
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, "AppData", "Local"),
          APPDATA: join(home, "AppData", "Roaming"),
          XDG_CONFIG_HOME: join(home, ".config"),
          ANYNOTATE_HOME: join(home, ".anynotate"),
          ANYNOTATE_EXTERNAL_DRYRUN: "1",
          SYSTEMROOT: process.env.SYSTEMROOT ?? "",
        };
        const run = (...args: string[]) => {
          const r = Bun.spawnSync([exe, ...args], { cwd: work, env, stderr: "pipe" });
          return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
        };

        expect(run("--version").out.trim()).toBe("0.6.2");

        const pinned = `chrome-extension://${(JSON.parse(read("assets/extension-ids.json")) as string[])[0]}/`;
        const askToken = (...args: string[]) => {
          const hostHome = mkdtempSync(join(work, "host-"));
          const r = Bun.spawnSync([exe, ...args], { cwd: work, env: { ...env, ANYNOTATE_HOME: hostHome }, stdin: encodeMessage({ type: "token" }), stderr: "pipe" });
          const reply = decodeMessage(new Uint8Array(r.stdout));
          if (!reply) throw new Error(`no reply from ${args.join(" ")} (exit ${r.exitCode}): ${r.stderr.toString()}`);
          return reply.value as { ok: boolean; token?: string; error?: string };
        };
        for (const args of [[pinned], ["native-host", pinned]]) {
          expect(askToken(...args)).toMatchObject({ ok: true, token: expect.any(String) });
        }
        for (const args of [["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], ["native-host", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]]) {
          expect(askToken(...args)).toEqual({ ok: false, error: "origin not allowed" });
        }

        mkdirSync(join(home, ".claude"), { recursive: true });
        const toml = join(home, ".gemini", "commands", "annotations.toml");
        mkdirSync(join(home, ".gemini", "commands"), { recursive: true });
        writeFileSync(toml, read("assets/gemini/annotations.toml"));
        const origins = (JSON.parse(read("assets/extension-ids.json")) as string[]).map((id) => `chrome-extension://${id}`);
        const origin = origins[0]!;

        const dry = run("install", "--dry-run");
        expect(dry.out).toContain(join(home, ".claude", "skills", "annotations", "SKILL.md"));
        expect(dry.out).toContain("dev.anynotate.host");
        expect(dry.out).toContain(`would add origin ${origin}`);
        expect(dry.out).toContain(`would remove ${toml}`);

        const real = run("install");
        if (real.code !== 0) throw new Error(`install exited ${real.code}: ${real.err}`);
        expect(readFileSync(join(home, ".claude", "skills", "annotations", "SKILL.md"), "utf8")).toBe(read("assets/skill/SKILL.md"));
        expect(readFileSync(join(home, ".anynotate", "origins"), "utf8")).toBe(origins.map((o) => `${o}\n`).join(""));
        expect(existsSync(toml)).toBe(false);
        const record = JSON.parse(readFileSync(join(home, ".anynotate", "install.json"), "utf8"));
        expect(record).toMatchObject({ kind: "binary", path: exe, version: "0.6.2" });
        expect(existsSync(join(home, ".anynotate", "native-host"))).toBe(false);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
