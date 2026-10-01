import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anynotate-files-"));
  savedUser = process.env.USERNAME;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedUser === undefined) delete process.env.USERNAME;
  else process.env.USERNAME = savedUser;
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
