import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandArgv, detectInstallKind, quoteArgv, readInstallRecord, writeInstallRecord } from "../src/agent/installkind";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "anynotate-kind-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a compiled binary is detected from Bun's embedded file system", () => {
  expect(detectInstallKind({ mainPath: "/$bunfs/root/anynotate", execPath: "/home/me/.local/bin/anynotate" })).toEqual({
    kind: "binary",
    exe: "/home/me/.local/bin/anynotate",
  });
  expect(detectInstallKind({ mainPath: "B:\\~BUN\\root\\anynotate.exe", execPath: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe" })).toEqual({
    kind: "binary",
    exe: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe",
  });
});

test("running cli.ts under bun is a source install rooted at the clone", () => {
  expect(detectInstallKind({ mainPath: "/home/me/src/anynotate/src/cli.ts", execPath: "/usr/bin/bun" })).toEqual({
    kind: "source",
    repo: "/home/me/src/anynotate",
    bun: "/usr/bin/bun",
  });
  expect(detectInstallKind({ mainPath: "C:\\src\\anynotate\\src\\cli.ts", execPath: "C:\\bun\\bun.exe" })).toEqual({
    kind: "source",
    repo: "C:\\src\\anynotate",
    bun: "C:\\bun\\bun.exe",
  });
});

test("by default this checkout is detected as a source install", () => {
  expect(detectInstallKind()).toEqual({ kind: "source", repo: process.cwd(), bun: process.execPath });
});

test("commandArgv runs the binary itself, or cli.ts under bun", () => {
  expect(commandArgv({ kind: "binary", exe: "/home/me/.local/bin/anynotate" })).toEqual(["/home/me/.local/bin/anynotate"]);
  expect(commandArgv({ kind: "source", repo: "/home/me/src/anynotate", bun: "/usr/bin/bun" })).toEqual(["/usr/bin/bun", "/home/me/src/anynotate/src/cli.ts"]);
  expect(commandArgv({ kind: "source", repo: "C:\\src\\anynotate", bun: "C:\\bun\\bun.exe" })).toEqual(["C:\\bun\\bun.exe", "C:\\src\\anynotate\\src\\cli.ts"]);
});

test("quoteArgv quotes only elements with spaces", () => {
  expect(quoteArgv(["/home/me/.local/bin/anynotate"])).toBe("/home/me/.local/bin/anynotate");
  expect(quoteArgv(["C:\\Users\\Me Me\\bun.exe", "C:\\src\\cli.ts"])).toBe('"C:\\Users\\Me Me\\bun.exe" C:\\src\\cli.ts');
});

test("the install record round-trips through install.json, written private", () => {
  expect(readInstallRecord(dir)).toBeNull();
  const r = { kind: "binary" as const, path: "/home/me/.local/bin/anynotate", version: "0.4.0", installedAt: "2026-10-01T12:00:00.000Z", platform: "linux" as const };
  writeInstallRecord(dir, r);
  expect(readInstallRecord(dir)).toEqual(r);
  if (process.platform !== "win32") expect(statSync(join(dir, "install.json")).mode & 0o777).toBe(0o600);
});

test("a malformed install.json reads as no record", () => {
  writeFileSync(join(dir, "install.json"), "{not json");
  expect(readInstallRecord(dir)).toBeNull();
  writeFileSync(join(dir, "install.json"), JSON.stringify({ kind: "other", path: "/x" }));
  expect(readInstallRecord(dir)).toBeNull();
});

test("an install.json whose path is not absolute reads as no record", () => {
  const base = { kind: "binary", version: "0.4.0", installedAt: "2026-10-01T12:00:00.000Z", platform: "linux" };
  for (const path of ["anynotate", "./bin/anynotate", "", "..\\anynotate.exe"]) {
    writeFileSync(join(dir, "install.json"), JSON.stringify({ ...base, path }));
    expect(readInstallRecord(dir)).toBeNull();
  }
  writeFileSync(join(dir, "install.json"), JSON.stringify({ ...base, path: "C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe" }));
  expect(readInstallRecord(dir)?.path).toBe("C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe");
});
