import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const installSh = join(repo, "scripts", "install.sh");
const installPs1 = join(repo, "scripts", "install.ps1");
const which = (cmd: string) => {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const posix = process.platform !== "win32";
const dash = posix ? which("dash") : null;
const pwsh = which("pwsh");

const STUB = '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$ANYNOTATE_TEST_RECORD"\n';
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

let tmp: string;
let release: string;
let fakebin: string;
let binDir: string;
let record: string;

function fakeUname(os: string, arch: string) {
  writeFileSync(join(fakebin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo ${arch};; *) echo ${os};; esac\n`);
  chmodSync(join(fakebin, "uname"), 0o755);
}

function fakeSysctl(translated: string) {
  writeFileSync(join(fakebin, "sysctl"), `#!/bin/sh\necho ${translated}\n`);
  chmodSync(join(fakebin, "sysctl"), 0o755);
}

function publish(asset: string, sumsFor: (hash: string) => string = (h) => `${h}  ${asset}\n`) {
  writeFileSync(join(release, asset), STUB);
  writeFileSync(join(release, "SHA256SUMS"), `${"0".repeat(64)}  anynotate-other\n${"e".repeat(64)}  ${asset}.sig\n${sumsFor(sha256(STUB))}`);
}

function run(env: Record<string, string> = {}, shell = "sh", path = `${fakebin}:${process.env.PATH}`) {
  const r = spawnSync(shell, [installSh], {
    encoding: "utf8",
    env: {
      PATH: path,
      HOME: tmp,
      ANYNOTATE_BASE_URL: `file://${release}`,
      ANYNOTATE_BIN_DIR: binDir,
      ANYNOTATE_TEST_RECORD: record,
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "anynotate-installsh-"));
  release = join(tmp, "release");
  fakebin = join(tmp, "fakebin");
  binDir = join(tmp, "bin");
  record = join(tmp, "record");
  mkdirSync(release);
  mkdirSync(fakebin);
  fakeUname("Linux", "x86_64");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!posix)("install.sh", () => {
  test("parses as POSIX sh", () => {
    expect(spawnSync("sh", ["-n", installSh]).status).toBe(0);
  });

  test("everything runs from main() on the last line, so a truncated download runs nothing", () => {
    const lines = readFileSync(installSh, "utf8").trimEnd().split("\n");
    expect(lines.at(-1)).toBe('main "$@"');
    const body = lines.filter((l) => l && !l.startsWith("#") && !/^\s/.test(l) && l !== "}");
    for (const l of body) expect(l).toMatch(/^(set -eu|[a-z0-9_]+\(\) \{|main "\$@")$/);
  });

  test("downloads, verifies, installs mode 755 and runs `anynotate install`", () => {
    publish("anynotate-linux-x64");
    const r = run();
    expect(r.code).toBe(0);
    const bin = join(binDir, "anynotate");
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(readFileSync(bin, "utf8")).toBe(STUB);
    expect(readFileSync(record, "utf8").trim()).toBe("install");
    expect(r.out).toContain(`file://${release}/anynotate-linux-x64`);
    expect(r.out).toContain(bin);
    expect(r.out.trimEnd().split("\n").at(-1)).toBe("Run: anynotate doctor");
    expect(readdirSync(binDir)).toEqual(["anynotate"]);
  });

  test("says what it will do before doing it", () => {
    publish("anynotate-linux-x64");
    const out = run().out;
    expect(out.indexOf(join(binDir, "anynotate"))).toBeLessThan(out.indexOf("Verified"));
  });

  test("refuses a binary whose checksum does not match, installing nothing", () => {
    publish("anynotate-linux-x64", () => `${"f".repeat(64)}  anynotate-linux-x64\n`);
    const r = run();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("checksum mismatch");
    expect(existsSync(join(binDir, "anynotate"))).toBe(false);
    expect(existsSync(record)).toBe(false);
  });

  test("refuses when SHA256SUMS has no line for the asset", () => {
    publish("anynotate-linux-x64", () => "");
    const r = run();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no checksum");
    expect(existsSync(join(binDir, "anynotate"))).toBe(false);
  });

  test("refuses when the install path is a directory", () => {
    mkdirSync(join(binDir, "anynotate"), { recursive: true });
    publish("anynotate-linux-x64");
    const r = run();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("is a directory");
    expect(existsSync(record)).toBe(false);
    expect(readdirSync(binDir)).toEqual(["anynotate"]);
  });

  test("makes a relative ANYNOTATE_BIN_DIR absolute", () => {
    publish("anynotate-linux-x64");
    const r = spawnSync("sh", [installSh], {
      cwd: tmp,
      encoding: "utf8",
      env: { PATH: `${fakebin}:${process.env.PATH}`, HOME: tmp, ANYNOTATE_BASE_URL: `file://${release}`, ANYNOTATE_BIN_DIR: "rel/bin/", ANYNOTATE_TEST_RECORD: record },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/install: +\/\S*\/rel\/bin\/anynotate\n/);
    expect(existsSync(join(tmp, "rel", "bin", "anynotate"))).toBe(true);
  });

  test("restricts curl to https (and file:// for CI), including redirects", () => {
    const code = readFileSync(installSh, "utf8");
    expect(code).toContain("--proto '=https,file'");
    expect(code).toContain("--proto-redir '=https'");
  });

  test("refuses a base URL that is not https:// or file:// before downloading anything", () => {
    writeFileSync(join(fakebin, "curl"), `#!/bin/sh\necho "$*" >> "${tmp}/urls"\nexit 22\n`);
    chmodSync(join(fakebin, "curl"), 0o755);
    for (const base of ["http://example.com/release", "ftp://example.com/release", "example.com/release"]) {
      const r = run({ ANYNOTATE_BASE_URL: base });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("ANYNOTATE_BASE_URL must start with https://");
    }
    expect(existsSync(join(tmp, "urls"))).toBe(false);
    expect(existsSync(binDir)).toBe(false);
  });

  // A PATH holding every tool the host has except curl, so the script falls back to the fake wget.
  function pathWithoutCurl(): string {
    const dir = join(tmp, "nocurl");
    mkdirSync(dir);
    for (const d of (process.env.PATH ?? "").split(":")) {
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {
        continue;
      }
      for (const n of names) {
        if (n === "curl" || n === "wget" || existsSync(join(dir, n))) continue;
        try {
          symlinkSync(join(d, n), join(dir, n));
        } catch {}
      }
    }
    return `${fakebin}:${dir}`;
  }

  function fakeWget(help: string) {
    writeFileSync(
      join(fakebin, "wget"),
      `#!/bin/sh\nif [ "$1" = --help ]; then echo "${help}"; exit 0; fi\necho "$*" >> "${tmp}/wget"\nexit 4\n`,
    );
    chmodSync(join(fakebin, "wget"), 0o755);
  }

  test.skipIf(!posix)("without curl, GNU wget downloads with --https-only", () => {
    fakeWget("  --https-only  only follow secure HTTPS links");
    const r = run({ ANYNOTATE_BASE_URL: "https://example.com/release" }, "sh", pathWithoutCurl());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("download failed: https://example.com/release/");
    expect(readFileSync(join(tmp, "wget"), "utf8")).toContain("-q --https-only -O ");
  });

  test.skipIf(!posix)("without curl, a wget lacking --https-only (BusyBox) still downloads", () => {
    fakeWget("BusyBox v1.36 multi-call binary");
    const r = run({ ANYNOTATE_BASE_URL: "https://example.com/release" }, "sh", pathWithoutCurl());
    expect(r.code).not.toBe(0);
    const args = readFileSync(join(tmp, "wget"), "utf8");
    expect(args).toContain("-q -O ");
    expect(args).not.toContain("--https-only");
  });

  test.skipIf(!posix)("without curl, a file:// release is copied rather than fetched", () => {
    fakeWget("  --https-only");
    publish("anynotate-linux-x64");
    const r = run({}, "sh", pathWithoutCurl());
    expect(r.code).toBe(0);
    expect(readFileSync(join(binDir, "anynotate"), "utf8")).toBe(STUB);
    expect(existsSync(join(tmp, "wget"))).toBe(false);
  });

  test("replaces an existing install", () => {
    mkdirSync(binDir);
    writeFileSync(join(binDir, "anynotate"), "old");
    publish("anynotate-linux-x64");
    expect(run().code).toBe(0);
    expect(readFileSync(join(binDir, "anynotate"), "utf8")).toBe(STUB);
  });

  test.each([
    ["Linux", "aarch64", "anynotate-linux-arm64"],
    ["Linux", "arm64", "anynotate-linux-arm64"],
    ["Linux", "amd64", "anynotate-linux-x64"],
    ["Darwin", "arm64", "anynotate-darwin-arm64"],
    ["Darwin", "x86_64", "anynotate-darwin-x64"],
  ])("%s %s installs %s", (os, arch, asset) => {
    fakeUname(os, arch);
    fakeSysctl("0");
    publish(asset);
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain(`/${asset}`);
  });

  test("an x64 shell under Rosetta installs the arm64 build", () => {
    fakeUname("Darwin", "x86_64");
    fakeSysctl("1");
    publish("anynotate-darwin-arm64");
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("/anynotate-darwin-arm64");
  });

  test.each([
    ["FreeBSD", "amd64"],
    ["Linux", "i686"],
    ["Linux", "armv7l"],
  ])("refuses %s %s, listing the supported targets", (os, arch) => {
    fakeUname(os, arch);
    const r = run();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("unsupported");
    for (const t of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) expect(r.out).toContain(t);
    expect(existsSync(binDir)).toBe(false);
  });

  test("ANYNOTATE_VERSION pins a release when no base URL is given", () => {
    writeFileSync(join(fakebin, "curl"), `#!/bin/sh\nfor a; do last=$a; done\necho "$last" >> "${tmp}/urls"\nexit 22\n`);
    chmodSync(join(fakebin, "curl"), 0o755);
    const r = run({ ANYNOTATE_BASE_URL: "", ANYNOTATE_VERSION: "v0.4.0" });
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(tmp, "urls"), "utf8")).toContain("https://github.com/genexk/anynotate/releases/download/v0.4.0/");
  });

  test("defaults to the latest release", () => {
    writeFileSync(join(fakebin, "curl"), `#!/bin/sh\nfor a; do last=$a; done\necho "$last" >> "${tmp}/urls"\nexit 22\n`);
    chmodSync(join(fakebin, "curl"), 0o755);
    const r = run({ ANYNOTATE_BASE_URL: "" });
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(tmp, "urls"), "utf8")).toContain("https://github.com/genexk/anynotate/releases/latest/download/");
  });

  test("tells you to add the bin dir to PATH only when it is missing", () => {
    publish("anynotate-linux-x64");
    expect(run().out).toContain(`Add ${binDir} to your PATH`);
    expect(run({}, "sh", `${binDir}:${fakebin}:${process.env.PATH}`).out).not.toContain("to your PATH");
    expect(run({}, "sh", `${binDir}/:${fakebin}:${process.env.PATH}`).out).not.toContain("to your PATH");
    expect(run({ ANYNOTATE_BIN_DIR: `${binDir}/` }, "sh", `${binDir}:${fakebin}:${process.env.PATH}`).out).not.toContain("to your PATH");
  });

  test("fails rather than skip verification when no SHA-256 tool exists", () => {
    publish("anynotate-linux-x64");
    const tools = ["sh", "mktemp", "curl", "awk", "tr", "mkdir", "chmod", "cp", "mv", "rm", "cat", "grep", "sed", "printf"];
    for (const t of tools) {
      const p = which(t);
      if (p && p.startsWith("/")) symlinkSync(p, join(fakebin, t));
    }
    const r = run({}, which("sh") ?? "sh", fakebin);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("sha256sum");
    expect(existsSync(join(binDir, "anynotate"))).toBe(false);
  });

  test("leaves no temp dir behind", () => {
    const scratch = join(tmp, "scratch");
    mkdirSync(scratch);
    publish("anynotate-linux-x64");
    expect(run({ TMPDIR: scratch }).code).toBe(0);
    publish("anynotate-linux-x64", () => `${"f".repeat(64)}  anynotate-linux-x64\n`);
    expect(run({ TMPDIR: scratch }).code).not.toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  });

  test.skipIf(!dash)("works under dash", () => {
    publish("anynotate-linux-x64");
    const r = run({}, dash ?? "dash");
    expect(r.code).toBe(0);
    expect(readFileSync(record, "utf8").trim()).toBe("install");
  });
});

describe("install.ps1", () => {
  const src = () => readFileSync(installPs1, "utf8");

  test("runs everything from one function invoked on the last line", () => {
    const lines = src().trimEnd().split(/\r?\n/);
    expect(lines.at(-1)).toBe("Install-Anynotate");
    expect(lines.filter((l) => /^function /.test(l))).toEqual(["function Install-Anynotate {"]);
  });

  test("stays PowerShell 5.1 compatible", () => {
    const code = src().split(/\r?\n/).filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect(code).not.toContain("??");
    expect(code).not.toMatch(/\s\?\s[^:]+\s:\s/);
    expect(code).toContain("$ErrorActionPreference = 'Stop'");
    expect(code).toContain("Tls12");
  });

  test("edits the user PATH without expanding %VAR% entries", () => {
    const code = src();
    expect(code).toContain("'DoNotExpandEnvironmentNames'");
    expect(code).toContain("-Type ExpandString");
    expect(code).not.toMatch(/SetEnvironmentVariable\(\s*'Path'/);
    expect(code).toContain("$env:Path");
  });

  test("names the Windows asset, verifies SHA-256 and ends with the doctor hint", () => {
    const code = src();
    expect(code).toContain("anynotate-windows-x64.exe");
    expect(code).toContain("Get-FileHash");
    expect(code).toContain("'Run: anynotate doctor'");
    expect(code).toContain("https://github.com/genexk/anynotate/releases/latest/download");
  });

  test("cleans old binaries, rolls back a failed swap and surfaces install output", () => {
    const code = src();
    expect(code).toContain("anynotate.exe.*.old");
    expect(code).toMatch(/Move-Item -LiteralPath \$aside -Destination \$exe/);
    expect(code).toMatch(/\$ErrorActionPreference = 'Continue'[\s\S]*& \$exe install 2>&1 \| Out-Host[\s\S]*\$code = \$LASTEXITCODE[\s\S]*\$ErrorActionPreference = 'Stop'/);
  });

  test("normalizes the bin dir, refuses ';' and non-Windows hosts, notes ARM64 emulation", () => {
    const code = src();
    expect(code).toContain("[IO.Path]::GetFullPath(");
    expect(code).toMatch(/Contains\(';'\)/);
    expect(code).toContain("$env:OS -ne 'Windows_NT'");
    expect(code).toContain("PROCESSOR_ARCHITEW6432");
    expect(code).toContain("emulation");
  });

  test("accepts only https:// or file:// base URLs, and only https:// where redirects end", () => {
    const code = src();
    expect(code).toContain("[Uri]::TryCreate($base, [UriKind]::Absolute, [ref]$baseUri)");
    expect(code).toContain("$baseUri.Scheme -ne 'https' -and $baseUri.Scheme -ne 'file'");
    expect(code).toContain("-OutFile $dest -PassThru");
    expect(code).toContain("$resp.BaseResponse.ResponseUri");
    expect(code).toContain("$resp.BaseResponse.RequestMessage.RequestUri");
    expect(code).toMatch(/if \(-not \$final -or \$final\.Scheme -ne 'https'\) \{\s*Remove-Item -LiteralPath \$dest[^\n]*\n\s*throw/);
  });

  test.skipIf(!pwsh || process.platform !== "win32")("refuses an http:// base URL before downloading", () => {
    const binDir = mkdtempSync(join(tmpdir(), "anynotate-ps1-"));
    try {
      const r = spawnSync(pwsh ?? "pwsh", ["-NoProfile", "-File", installPs1], {
        encoding: "utf8",
        env: { ...process.env, ANYNOTATE_BASE_URL: "http://example.com/release", ANYNOTATE_BIN_DIR: join(binDir, "bin") },
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("ANYNOTATE_BASE_URL must start with https://");
      expect(existsSync(join(binDir, "bin"))).toBe(false);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test.skipIf(!pwsh)("parses with the PowerShell parser", () => {
    const cmd = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${installPs1}',[ref]$t,[ref]$e);if($e.Count){$e|%{$_.ToString()};exit 1}`;
    const r = spawnSync(pwsh ?? "pwsh", ["-NoProfile", "-Command", cmd], { encoding: "utf8" });
    expect(`${r.stdout}${r.stderr}`).toBe("");
    expect(r.status).toBe(0);
  });
});
