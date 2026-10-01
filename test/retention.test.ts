import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RETENTION_DAYS, parseRetention, pruneBundles, resolveRetention, startRetentionSweeps, sweepRetention, writeRetentionSetting,
} from "../src/inbox/retention";
import { archiveOlderThan, writeBundle } from "../src/inbox/store";
import { readLatest } from "../src/platform/latest";
import { sampleInput } from "./fixtures/sample";

let home: string;
let savedRetention: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anynotate-"));
  process.env.ANYNOTATE_HOME = home;
  savedRetention = process.env.ANYNOTATE_RETENTION_DAYS;
  delete process.env.ANYNOTATE_RETENTION_DAYS;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.ANYNOTATE_HOME;
  if (savedRetention === undefined) delete process.env.ANYNOTATE_RETENTION_DAYS;
  else process.env.ANYNOTATE_RETENTION_DAYS = savedRetention;
});

const NOW = new Date(2026, 8, 30, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const inbox = () => join(home, "inbox");

function bundle(title: string, created: Date, delivered?: Date, state: "delivered" | "acked" = "delivered"): string {
  const { id } = writeBundle({ ...sampleInput, title }, {}, created);
  if (delivered) writeFileSync(join(inbox(), id, "status.json"), JSON.stringify({ state, at: delivered.toISOString() }));
  return id;
}

const gone = (id: string) => !existsSync(join(inbox(), id));

test("delivered or acked bundles expire from the delivery time; recent ones stay", () => {
  const oldDelivered = bundle("old-delivered", daysAgo(90), daysAgo(31));
  const oldAcked = bundle("old-acked", daysAgo(90), daysAgo(40), "acked");
  const recentDelivery = bundle("recent-delivery", daysAgo(90), daysAgo(5));
  const recent = bundle("recent", daysAgo(2), daysAgo(1));
  const { pruned } = pruneBundles(30, { now: NOW });
  expect(pruned.sort()).toEqual([oldAcked, oldDelivered].sort());
  expect(gone(oldDelivered) && gone(oldAcked)).toBe(true);
  expect(gone(recentDelivery) || gone(recent)).toBe(false);
});

test("a queued bundle expires from its creation time", () => {
  const oldQueued = bundle("old-queued", daysAgo(31));
  const newQueued = bundle("new-queued", daysAgo(29));
  expect(pruneBundles(30, { now: NOW }).pruned).toEqual([oldQueued]);
  expect(gone(newQueued)).toBe(false);
});

test("an active claim protects a bundle; a stale claim does not", () => {
  const claimAt = (id: string, at: Date) => {
    const dir = join(inbox(), id);
    const file = join(dir, "status.json.claim-ack-1");
    renameSync(join(dir, "status.json"), file);
    utimesSync(file, at, at);
  };
  const active = bundle("active", daysAgo(90), daysAgo(60));
  const stale = bundle("stale", daysAgo(90), daysAgo(60));
  claimAt(active, new Date(NOW.getTime() - 5_000));
  claimAt(stale, new Date(NOW.getTime() - 120_000));
  expect(pruneBundles(30, { now: NOW }).pruned).toEqual([stale]);
  expect(gone(active)).toBe(false);
  expect(gone(stale)).toBe(true);
});

test("inbox/latest is repointed to the newest remaining bundle when its target is pruned", () => {
  const kept = bundle("kept", daysAgo(10));
  const newestButOld = bundle("newest", daysAgo(5), daysAgo(45));
  expect(readLatest(inbox())).toBe(newestButOld);
  pruneBundles(30, { now: NOW });
  expect(readLatest(inbox())).toBe(kept);
});

test("inbox/latest is removed when nothing remains", () => {
  bundle("only", daysAgo(60));
  pruneBundles(30, { now: NOW });
  expect(readLatest(inbox())).toBeNull();
  expect(existsSync(join(inbox(), "latest"))).toBe(false);
});

test("off disables pruning", () => {
  const id = bundle("ancient", daysAgo(900));
  expect(pruneBundles(null, { now: NOW }).pruned).toEqual([]);
  expect(gone(id)).toBe(false);
});

test("dry-run lists what would go and deletes nothing", () => {
  const id = bundle("old", daysAgo(60));
  const r = pruneBundles(30, { now: NOW, dryRun: true });
  expect(r).toEqual({ days: 30, pruned: [id], dryRun: true });
  expect(gone(id)).toBe(false);
  expect(readLatest(inbox())).toBe(id);
});

test("non-bundle dirs, files and symlinks pointing outside the inbox are never touched", () => {
  const outside = mkdtempSync(join(tmpdir(), "anynotate-outside-"));
  try {
    const target = join(outside, "2020-01-01T000000-victim");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "x");
    bundle("anchor", daysAgo(1));
    symlinkSync(target, join(inbox(), "2020-01-01T000000-victim"));
    mkdirSync(join(inbox(), "notes"));
    writeFileSync(join(inbox(), "notes", "status.json"), JSON.stringify({ state: "delivered", at: daysAgo(400).toISOString() }));
    mkdirSync(join(inbox(), ".tmp-2020-01-01T000000-x-1-abc"));
    writeFileSync(join(inbox(), "2020-01-01T000000-file"), "x");
    expect(pruneBundles(1, { now: NOW }).pruned).toEqual([]);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
    expect(existsSync(join(inbox(), "notes", "status.json"))).toBe(true);
    expect(readlinkSync(join(inbox(), "2020-01-01T000000-victim"))).toBe(target);
    expect(existsSync(join(inbox(), ".tmp-2020-01-01T000000-x-1-abc"))).toBe(true);
    expect(existsSync(join(inbox(), "2020-01-01T000000-file"))).toBe(true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("archived bundles are pruned too", () => {
  const { id } = writeBundle({ ...sampleInput, title: "archived", sentAt: "2026-07-01T00:00:00.000Z" }, {}, daysAgo(60));
  expect(archiveOlderThan(30, NOW)).toEqual([id]);
  expect(pruneBundles(30, { now: NOW }).pruned).toEqual([id]);
  expect(existsSync(join(home, "archive", id))).toBe(false);
});

test("parseRetention accepts whole days and off", () => {
  expect(parseRetention("7")).toBe(7);
  expect(parseRetention(" 14 ")).toBe(14);
  expect(parseRetention(30)).toBe(30);
  expect(parseRetention("off")).toBeNull();
  expect(parseRetention("OFF")).toBeNull();
  expect(parseRetention("0")).toBeNull();
  expect(parseRetention(0)).toBeNull();
  for (const bad of ["-1", "1.5", "7d", "", "never", -3, 2.5, true, null]) expect(parseRetention(bad)).toBeUndefined();
});

test("precedence is env, then settings.json, then the default", () => {
  expect(resolveRetention({})).toEqual({ days: DEFAULT_RETENTION_DAYS, source: "default" });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retentionDays: 7 }));
  expect(resolveRetention({})).toEqual({ days: 7, source: "settings.json" });
  expect(resolveRetention({ ANYNOTATE_RETENTION_DAYS: "3" })).toEqual({ days: 3, source: "env" });
  expect(resolveRetention({ ANYNOTATE_RETENTION_DAYS: "off" })).toEqual({ days: null, source: "env" });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retentionDays: "off" }));
  expect(resolveRetention({})).toEqual({ days: null, source: "settings.json" });
});

test("invalid values fall back to the default with a warning", () => {
  const env = resolveRetention({ ANYNOTATE_RETENTION_DAYS: "soon" });
  expect(env.days).toBe(DEFAULT_RETENTION_DAYS);
  expect(env.source).toBe("default");
  expect(env.warning).toContain("ANYNOTATE_RETENTION_DAYS");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retentionDays: -4 }));
  expect(resolveRetention({}).warning).toContain("retentionDays");
  writeFileSync(join(home, "settings.json"), "{not json");
  const broken = resolveRetention({});
  expect(broken.days).toBe(DEFAULT_RETENTION_DAYS);
  expect(broken.warning).toContain("settings.json");
});

test("writeRetentionSetting keeps other keys and writes privately", () => {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ other: "kept" }));
  expect(writeRetentionSetting("14")).toBe(14);
  const path = join(home, "settings.json");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other: "kept", retentionDays: 14 });
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(writeRetentionSetting("off")).toBeNull();
  expect(JSON.parse(readFileSync(path, "utf8")).retentionDays).toBe("off");
  expect(() => writeRetentionSetting("later")).toThrow();
});

test("sweepRetention reads the setting each time and logs a summary only when it deletes", () => {
  const lines: string[] = [];
  const log = { info: (s: string) => lines.push(s), warn: (s: string) => lines.push(`warn ${s}`) };
  bundle("old", daysAgo(10));
  expect(sweepRetention(log, NOW).pruned).toEqual([]);
  expect(lines).toEqual([]);
  process.env.ANYNOTATE_RETENTION_DAYS = "7";
  expect(sweepRetention(log, NOW).pruned).toHaveLength(1);
  expect(lines).toEqual(["pruned 1 bundle(s) older than 7 days"]);
  process.env.ANYNOTATE_RETENTION_DAYS = "bogus";
  sweepRetention(log, NOW);
  expect(lines[1]).toStartWith("warn ");
});

test("startRetentionSweeps runs at once and its timer can be stopped", () => {
  const lines: string[] = [];
  writeBundle({ ...sampleInput, title: "ancient" }, {}, new Date(2000, 0, 1));
  const stop = startRetentionSweeps({ info: (s) => lines.push(s), warn: (s) => lines.push(s) });
  stop();
  expect(lines).toEqual([`pruned 1 bundle(s) older than ${DEFAULT_RETENTION_DAYS} days`]);
});

test("a blank ANYNOTATE_HOME means ~/.anynotate and a relative one is ignored", async () => {
  const { anynotateHome } = await import("../src/inbox/paths");
  const fallback = join((await import("node:os")).homedir(), ".anynotate");
  process.env.ANYNOTATE_HOME = "  ";
  expect(anynotateHome()).toBe(fallback);
  process.env.ANYNOTATE_HOME = "relative/home";
  expect(anynotateHome()).toBe(fallback);
  process.env.ANYNOTATE_HOME = home;
  expect(anynotateHome()).toBe(home);
});
