import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/platform/exec";
import { isPrivate, makePrivateDir, writePrivateFile } from "../src/platform/files";
import { clearLatest, LATEST_ID_FILE, readLatest, writeLatest } from "../src/platform/latest";

const posixHost = process.platform !== "win32";
const ID = "2026-10-01T120000-abcd";
const OTHER = "2026-10-02T080000-efgh";

let dir: string;
let savedUser: string | undefined;
let savedDomain: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anynotate-files-"));
  savedUser = process.env.USERNAME;
  savedDomain = process.env.USERDOMAIN;
  delete process.env.USERDOMAIN;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedUser === undefined) delete process.env.USERNAME;
  else process.env.USERNAME = savedUser;
  if (savedDomain === undefined) delete process.env.USERDOMAIN;
  else process.env.USERDOMAIN = savedDomain;
});

const mode = (p: string) => statSync(p).mode & 0o777;

function recorder(code = 0): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, exec: (argv) => { calls.push(argv); return { code, stdout: "", stderr: code ? "denied" : "" }; } };
}

test.skipIf(!posixHost)("makePrivateDir creates an owner-only dir and tightens an open one", () => {
  const d = join(dir, "a", "b");
  makePrivateDir(d);
  expect(mode(d)).toBe(0o700);
  mkdirSync(join(dir, "open"), { mode: 0o755 });
  makePrivateDir(join(dir, "open"));
  expect(mode(join(dir, "open"))).toBe(0o700);
  expect(isPrivate(d)).toBe(true);
});

test.skipIf(!posixHost)("writePrivateFile writes mode 600 content atomically and leaves no temp file", () => {
  const f = join(dir, "token");
  writePrivateFile(f, "secret\n");
  expect(readFileSync(f, "utf8")).toBe("secret\n");
  expect(mode(f)).toBe(0o600);
  expect(isPrivate(f)).toBe(true);
  writePrivateFile(f, "again\n");
  expect(readFileSync(f, "utf8")).toBe("again\n");
  expect(readdirSync(dir)).toEqual(["token"]);
});

test.skipIf(!posixHost)("isPrivate is false for a group- or world-readable file", () => {
  const f = join(dir, "open");
  writeFileSync(f, "x", { mode: 0o644 });
  expect(isPrivate(f)).toBe(false);
});

test("isPrivate is unknown on Windows", () => {
  writeFileSync(join(dir, "f"), "x");
  expect(isPrivate(join(dir, "f"), "win32")).toBe("unknown");
});

test("makePrivateDir on Windows strips inheritance and grants only the current user", () => {
  process.env.USERNAME = "me";
  const { exec, calls } = recorder();
  const d = join(dir, "home");
  makePrivateDir(d, "win32", exec);
  expect(existsSync(d)).toBe(true);
  expect(calls).toEqual([["icacls", d, "/inheritance:r", "/grant:r", "me:(OI)(CI)F"]]);
});

test("makePrivateDir on Windows restricts an existing dir once per process", () => {
  process.env.USERNAME = "me";
  const { exec, calls } = recorder();
  const d = join(dir, "existing");
  mkdirSync(d);
  makePrivateDir(d, "win32", exec);
  makePrivateDir(d, "win32", exec);
  expect(calls).toEqual([["icacls", d, "/inheritance:r", "/grant:r", "me:(OI)(CI)F"]]);
});

test("the Windows grantee is DOMAIN\\user when USERDOMAIN is set", () => {
  process.env.USERNAME = "me";
  process.env.USERDOMAIN = "DESKTOP-1";
  const { exec, calls } = recorder();
  const f = join(dir, "token");
  writePrivateFile(f, "x", "win32", exec);
  expect(calls[0]?.at(-1)).toBe("DESKTOP-1\\me:F");
  makePrivateDir(join(dir, "d"), "win32", exec);
  expect(calls[1]?.at(-1)).toBe("DESKTOP-1\\me:(OI)(CI)F");
});

test("makePrivateDir on Windows ignores an icacls failure", () => {
  process.env.USERNAME = "me";
  const { exec } = recorder(1);
  expect(() => makePrivateDir(join(dir, "home"), "win32", exec)).not.toThrow();
});

test("writePrivateFile on Windows restricts the file to the current user before it lands", () => {
  process.env.USERNAME = "me";
  const { exec, calls } = recorder();
  const f = join(dir, "token");
  writePrivateFile(f, "secret\n", "win32", exec);
  expect(readFileSync(f, "utf8")).toBe("secret\n");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(2)).toEqual(["/inheritance:r", "/grant:r", "me:F"]);
  expect(calls[0]?.[1]).toStartWith(`${f}.tmp-`);
  expect(readdirSync(dir)).toEqual(["token"]);
});

test("writeLatest then readLatest returns the id, and the id file holds it too", () => {
  writeLatest(dir, ID);
  expect(readLatest(dir)).toBe(ID);
  expect(readFileSync(join(dir, LATEST_ID_FILE), "utf8").trim()).toBe(ID);
  writeLatest(dir, OTHER);
  expect(readLatest(dir)).toBe(OTHER);
});

test.skipIf(!posixHost)("on macOS and Linux latest is still a relative symlink to the bundle", () => {
  mkdirSync(join(dir, ID));
  writeLatest(dir, ID, "linux");
  expect(require("node:fs").readlinkSync(join(dir, "latest"))).toBe(ID);
  expect(readLatest(dir)).toBe(ID);
  expect(readdirSync(dir).sort()).toEqual([ID, "latest", LATEST_ID_FILE].sort());
});

test("when the link cannot be created readLatest still finds the id via the id file", () => {
  mkdirSync(join(dir, "latest", "blocker"), { recursive: true });
  const orig = console.error;
  console.error = () => {};
  try {
    writeLatest(dir, ID);
  } finally {
    console.error = orig;
  }
  expect(readLatest(dir)).toBe(ID);
  expect(existsSync(join(dir, "latest", "blocker"))).toBe(true);
});

test("a stale link is not trusted over a newer id file", () => {
  mkdirSync(join(dir, ID));
  mkdirSync(join(dir, OTHER));
  writeLatest(dir, ID);
  writeFileSync(join(dir, LATEST_ID_FILE), `${OTHER}\n`);
  rmSync(join(dir, ID), { recursive: true });
  expect(readLatest(dir)).toBe(OTHER);
});

test("readLatest returns null when nothing exists and ignores an invalid id file", () => {
  expect(readLatest(dir)).toBeNull();
  expect(readLatest(join(dir, "missing"))).toBeNull();
  writeFileSync(join(dir, LATEST_ID_FILE), "../etc\n");
  expect(readLatest(dir)).toBeNull();
});

test("clearLatest removes the link and the id file", () => {
  writeLatest(dir, ID);
  clearLatest(dir);
  expect(readLatest(dir)).toBeNull();
  expect(readdirSync(dir)).toEqual([]);
});

const quietly = <T>(fn: () => T): T => {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
};
const isLinkAt = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
// An absolute directory link: a junction on Windows, which needs no privilege, a symlink elsewhere.
const dirLink = (target: string, path: string) => symlinkSync(target, path, posixHost ? undefined : "junction");

test("a failed link update removes the stale latest link, so the id file wins", () => {
  mkdirSync(join(dir, ID));
  mkdirSync(join(dir, OTHER));
  writeLatest(dir, ID);
  expect(isLinkAt(join(dir, "latest"))).toBe(true);
  const spy = spyOn(fs, "symlinkSync").mockImplementation(() => {
    throw new Error("EPERM");
  });
  try {
    quietly(() => writeLatest(dir, OTHER));
  } finally {
    spy.mockRestore();
  }
  expect(isLinkAt(join(dir, "latest"))).toBe(false);
  expect(readLatest(dir)).toBe(OTHER);
  expect(existsSync(join(dir, ID))).toBe(true);
});

test("a latest link aimed outside the inbox counts only by its name, and only if the inbox has that bundle", () => {
  const outside = mkdtempSync(join(tmpdir(), "anynotate-outside-"));
  try {
    mkdirSync(join(outside, OTHER));
    writeFileSync(join(dir, LATEST_ID_FILE), `${ID}\n`);
    dirLink(join(outside, OTHER), join(dir, "latest"));
    expect(readLatest(dir)).toBe(ID);
    mkdirSync(join(dir, OTHER));
    expect(readLatest(dir)).toBe(OTHER);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test.skipIf(!posixHost)("a relative latest link that climbs out of the inbox counts only by its name", () => {
  mkdirSync(join(dir, "inbox"));
  mkdirSync(join(dir, OTHER));
  symlinkSync(join("..", OTHER), join(dir, "inbox", "latest"));
  expect(readLatest(join(dir, "inbox"))).toBeNull();
  mkdirSync(join(dir, "inbox", OTHER));
  expect(readLatest(join(dir, "inbox"))).toBe(OTHER);
});

test.skipIf(posixHost)("on Windows latest is a junction that clearLatest removes without touching the bundle", () => {
  mkdirSync(join(dir, ID));
  writeFileSync(join(dir, ID, "README.md"), "notes\n");
  writeLatest(dir, ID);
  expect(lstatSync(join(dir, "latest")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(dir, "latest", "README.md"), "utf8")).toBe("notes\n");
  expect(readLatest(dir)).toBe(ID);
  mkdirSync(join(dir, OTHER));
  writeLatest(dir, OTHER);
  expect(readLatest(dir)).toBe(OTHER);
  clearLatest(dir);
  expect(isLinkAt(join(dir, "latest"))).toBe(false);
  expect(readFileSync(join(dir, ID, "README.md"), "utf8")).toBe("notes\n");
  expect(readdirSync(dir).sort()).toEqual([ID, OTHER].sort());
});
