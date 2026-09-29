import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateToken } from "../src/bridge/token";
import { ensureHome } from "../src/inbox/paths";
import { touchSeen } from "../src/inbox/seen";
import { archiveOlderThan, writeBundle } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";

let parent: string, home: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "anynotate-perms-"));
  chmodSync(parent, 0o755);
  home = join(parent, "anynotate-home");
  process.env.ANYNOTATE_HOME = home;
});
afterEach(() => { rmSync(parent, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

const mode = (p: string) => statSync(p).mode & 0o777;

test("the hook's first touch creates home and sessions private", () => {
  touchSeen("claude", "s-1", "/r");
  expect(mode(home)).toBe(0o700);
  expect(mode(join(home, "sessions"))).toBe(0o700);
});

test("writing and archiving a bundle keeps home, inbox and archive private", () => {
  writeBundle({ ...sampleInput, sentAt: "2026-07-01T00:00:00.000Z" }, {});
  expect(mode(home)).toBe(0o700);
  expect(mode(join(home, "inbox"))).toBe(0o700);
  expect(archiveOlderThan(30, new Date("2026-09-24T00:00:00Z"))).toHaveLength(1);
  expect(mode(join(home, "archive"))).toBe(0o700);
});

test("the token path creates home private", () => {
  loadOrCreateToken();
  expect(mode(home)).toBe(0o700);
  expect(mode(join(home, "token"))).toBe(0o600);
});

test("ensureHome tightens an existing home that is too open", () => {
  mkdirSync(home, { mode: 0o755 });
  chmodSync(home, 0o755);
  expect(ensureHome()).toBe(home);
  expect(mode(home)).toBe(0o700);
});

test("an existing sessions dir that is too open is tightened", () => {
  mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o755 });
  chmodSync(home, 0o755);
  chmodSync(join(home, "sessions"), 0o755);
  touchSeen("gemini", "s-2", "/r");
  expect(mode(home)).toBe(0o700);
  expect(mode(join(home, "sessions"))).toBe(0o700);
});
