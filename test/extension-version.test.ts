import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_EXTENSION, extensionIsOlder, extensionRecorder, extensionStatePath, parseSender, readLastExtension, senderFromHeader, senderNote,
} from "../src/bridge/extension-version";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anynotate-ext-"));
  process.env.ANYNOTATE_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.ANYNOTATE_HOME;
});

test("this bridge expects extension 0.3.1 or later", () => {
  expect(EXPECTED_EXTENSION).toBe("0.3.1");
});

test("versions compare numerically, and a prerelease of the expected version counts as it", () => {
  expect(extensionIsOlder("0.2.0")).toBe(true);
  expect(extensionIsOlder("0.3.0")).toBe(true);
  expect(extensionIsOlder("0.3.1")).toBe(false);
  expect(extensionIsOlder("0.3.10")).toBe(false);
  expect(extensionIsOlder("0.10.0", "0.9.0")).toBe(false);
  expect(extensionIsOlder("0.9.0", "0.10.0")).toBe(true);
  expect(extensionIsOlder("1.0.0")).toBe(false);
  expect(extensionIsOlder("0.3.1-beta.2")).toBe(false);
  expect(extensionIsOlder("0.3.0-beta.2")).toBe(true);
  expect(extensionIsOlder("unknown")).toBe(true);
});

test("the header becomes a version, or unknown when it is missing or not a version", () => {
  expect(senderFromHeader("0.3.1")).toBe("0.3.1");
  expect(senderFromHeader(" 0.4.0-rc.1 ")).toBe("0.4.0-rc.1");
  for (const bad of [null, "", "latest", "0.3", "v0.3.1", "0.3.1; echo hi", `0.3.1-${"x".repeat(40)}`, "1234567.0.0"]) {
    expect(senderFromHeader(bad)).toBe("unknown");
  }
});

test("a stored sender is trusted only when it is a version or unknown", () => {
  expect(parseSender("0.3.1\n")).toBe("0.3.1");
  expect(parseSender("unknown\n")).toBe("unknown");
  expect(parseSender("<b>hi</b>")).toBeNull();
  expect(parseSender("")).toBeNull();
  expect(parseSender(null)).toBeNull();
});

test("an older or unknown sender gets one note line; an equal or newer one none", () => {
  expect(senderNote("0.2.0")).toBe("Note: sent from extension 0.2.0; 0.3.1 or later is expected, so some details may be missing.");
  expect(senderNote("unknown")).toBe("Note: sent from an older extension; 0.3.1 or later is expected, so some details may be missing.");
  expect(senderNote("0.3.1")).toBeNull();
  expect(senderNote("0.4.0")).toBeNull();
  expect(senderNote(null)).toBeNull();
});

test("the recorder keeps only the version string, privately, and rewrites it only when it changes", () => {
  const record = extensionRecorder();
  expect(readLastExtension()).toBeNull();
  record("0.3.1");
  const path = extensionStatePath();
  expect(path).toBe(join(home, "extension-version"));
  expect(readFileSync(path, "utf8")).toBe("0.3.1\n");
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  const before = statSync(path).mtimeMs;
  record("0.3.1");
  expect(statSync(path).mtimeMs).toBe(before);
  record("unknown");
  expect(readLastExtension()).toBe("unknown");
  expect(readdirSync(home).filter((n) => n.includes(".tmp-"))).toEqual([]);
});
