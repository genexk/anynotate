import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_ID_FILE, readLatest } from "../src/platform/latest";
import { sampleInput } from "./fixtures/sample";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

const store = () => import("../src/inbox/store");
const png = new Uint8Array([137, 80, 78, 71]);

test("newBundleId uses local time and a slug", async () => {
  const { newBundleId } = await store();
  const id = newBundleId("Tomato soup – Recipes!", new Date(2026, 8, 24, 15, 32, 7));
  expect(id).toBe("2026-09-24T153207-tomato-soup-recipes");
});

test("a title with no ASCII letters falls back to the page's hostname for the slug", async () => {
  const { newBundleId } = await store();
  const when = new Date(2026, 8, 24, 15, 32, 7);
  expect(newBundleId("3. 番茄汤的做法", when, "https://docs.example.com/guide/x")).toBe("2026-09-24T153207-3");
  expect(newBundleId("番茄汤的做法", when, "https://docs.example.com/guide/x")).toBe("2026-09-24T153207-docs-example-com");
  expect(newBundleId("", when, "https://www.example.co.uk/")).toBe("2026-09-24T153207-www-example-co-uk");
  expect(newBundleId("番茄", when, "not a url")).toBe("2026-09-24T153207-page");
  expect(newBundleId("番茄", when)).toBe("2026-09-24T153207-page");
});

test("a file:// page with no usable title is named after the file, without its extension", async () => {
  const { newBundleId, BUNDLE_ID } = await store();
  const when = new Date(2026, 8, 24, 15, 32, 7);
  const url = "file:///home/me/notes/weekend-plans.html";
  expect(newBundleId("", when, url)).toBe("2026-09-24T153207-weekend-plans");
  expect(newBundleId("周末计划", when, url)).toBe("2026-09-24T153207-weekend-plans");
  expect(newBundleId("Weekend Plans", when, url)).toBe("2026-09-24T153207-weekend-plans");
  expect(newBundleId("", when, "file:///tmp/Packing%20List.v2.htm")).toBe("2026-09-24T153207-packing-list-v2");
  expect(newBundleId("", when, "file:///tmp/%E6%96%87.html")).toBe("2026-09-24T153207-page");
  expect(newBundleId("", when, "file:///tmp/%E0%A4%A.html")).toBe("2026-09-24T153207-e0-a4-a");
  expect(newBundleId("", when, "file:///")).toBe("2026-09-24T153207-page");
  expect(newBundleId("", when, "file:///tmp/README")).toBe("2026-09-24T153207-readme");
  expect(newBundleId("", when, "file:///tmp/dir/")).toBe("2026-09-24T153207-page");
  expect(newBundleId("", when, "file:///tmp/.hidden")).toBe("2026-09-24T153207-page");
  for (const u of ["file:///tmp/README", "file:///tmp/dir/", "file:///tmp/.hidden", "file:///tmp/%E0%A4%A.html", url]) {
    expect(newBundleId("", when, u)).toMatch(BUNDLE_ID);
  }
});

test("writeBundle names a non-ASCII-titled bundle after its hostname", async () => {
  const { writeBundle } = await store();
  const b = writeBundle({ ...sampleInput, title: "基本思路", url: "https://docs.example.com/guide/" }, { "page.md": new TextEncoder().encode("# hi"), "screenshot.png": png });
  expect(b.id).toMatch(/T\d{6}-docs-example-com$/);
});

test("writeBundle writes an atomic folder with queued status", async () => {
  const { writeBundle, readStatus, bundleDir } = await store();
  const b = writeBundle(sampleInput, { "page.md": new TextEncoder().encode("# hi"), "screenshot.png": png, "crops/A1.png": png });
  const dir = bundleDir(b.id);
  expect(readdirSync(dir).sort()).toEqual(["README.md", "annotations.json", "crops", "page.md", "screenshot.png", "status.json"]);
  expect(readStatus(b.id)!.state).toBe("queued");
  expect(b.files).toEqual({ page: "page.md", screenshot: "screenshot.png" });
  expect(readdirSync(join(home, "inbox")).some((n) => n.startsWith(".tmp-"))).toBe(false);
  expect(statSync(join(home, "inbox")).mode & 0o777).toBe(0o700);
});

test("README names only the crops that were uploaded", async () => {
  const { writeBundle, bundleDir } = await store();
  const input = { ...sampleInput, annotations: [sampleInput.annotations[0]!, { ...sampleInput.annotations[0]!, id: "A2", crop: "crops/A2.png" }] };
  const b = writeBundle(input, { "page.md": new TextEncoder().encode("# hi"), "screenshot.png": png, "crops/A1.png": png });
  const readme = readFileSync(join(bundleDir(b.id), "README.md"), "utf8");
  expect(readme).toContain("Crop: crops/A1.png");
  expect(readme).not.toContain("crops/A2.png");
  expect(readme).toContain("Crop: (none)");
});

test("writeBundle rejects unexpected file names", async () => {
  const { writeBundle } = await store();
  expect(() => writeBundle(sampleInput, { "../evil.sh": png })).toThrow(/file name/);
  expect(() => writeBundle(sampleInput, { "crops/x.png": png })).toThrow(/file name/);
});

test("same-second ids get a numeric suffix", async () => {
  const { writeBundle } = await store();
  const now = new Date(2026, 8, 24, 15, 32, 7);
  const a = writeBundle(sampleInput, {}, now);
  const b = writeBundle(sampleInput, {}, now);
  expect(b.id).toBe(`${a.id}-2`);
});

test("claim is exclusive and release restores status", async () => {
  const { writeBundle, claim, release, readStatus } = await store();
  const b = writeBundle(sampleInput, {});
  expect(claim(b.id, "p1")!.state).toBe("queued");
  expect(claim(b.id, "p2")).toBeNull();
  expect(existsSync(join(home, "inbox", b.id, "status.json"))).toBe(false);
  expect(readStatus(b.id)!.state).toBe("queued");
  release(b.id, "p1", { state: "delivered", via: "hook", at: "t" });
  expect(readStatus(b.id)!.via).toBe("hook");
  expect(existsSync(join(home, "inbox", b.id, "status.json.claim-p1"))).toBe(false);
});

test("queuedFor matches sessionId strictly, else cwd", async () => {
  const { writeBundle, queuedFor, updateStatus } = await store();
  const bySession = writeBundle(sampleInput, {});
  const byCwd = writeBundle({ ...sampleInput, title: "cwd one", target: { agent: "claude", cwd: "/tmp/repo" } }, {});
  const codex = writeBundle({ ...sampleInput, title: "codex", target: { agent: "codex", cwd: "/tmp/repo" } }, {});
  expect(queuedFor("claude", "s-1", "/tmp/repo").map((b) => b.id).sort()).toEqual([bySession.id, byCwd.id].sort());
  expect(queuedFor("claude", "s-2", "/tmp/repo").map((b) => b.id)).toEqual([byCwd.id]);
  expect(queuedFor("codex", undefined, "/tmp/repo").map((b) => b.id)).toEqual([codex.id]);
  updateStatus(byCwd.id, "t", (s) => ({ ...s, state: "delivered", via: "pull" }));
  expect(queuedFor("claude", "s-2", "/tmp/repo")).toEqual([]);
});

test("archiveOlderThan moves old bundles and never deletes", async () => {
  const { writeBundle, archiveOlderThan, listBundles } = await store();
  const old = writeBundle({ ...sampleInput, title: "old", sentAt: "2026-07-01T00:00:00.000Z" }, {});
  writeBundle({ ...sampleInput, title: "fresh", sentAt: "2026-09-20T00:00:00.000Z" }, {});
  expect(archiveOlderThan(30, new Date("2026-09-24T00:00:00Z"))).toEqual([old.id]);
  expect(listBundles().map((x) => x.bundle.title)).toEqual(["fresh"]);
  expect(existsSync(join(home, "archive", old.id, "annotations.json"))).toBe(true);
});

test("listBundles is newest first and skips temp dirs", async () => {
  const { writeBundle, listBundles } = await store();
  writeBundle({ ...sampleInput, title: "old" }, {}, new Date(2026, 0, 1));
  writeBundle({ ...sampleInput, title: "new" }, {}, new Date(2026, 5, 1));
  expect(listBundles().map((x) => x.bundle.title)).toEqual(["new", "old"]);
  expect(JSON.parse(readFileSync(join(home, "inbox", listBundles()[0]!.bundle.id, "annotations.json"), "utf8")).id).toContain("new");
});

test("bundle ids that are not store-generated are rejected", async () => {
  const { bundleDir, claim, readStatus } = await store();
  expect(() => bundleDir("..")).toThrow("invalid bundle id: ..");
  expect(() => bundleDir("a/b")).toThrow(/invalid bundle id/);
  expect(claim("..", "x")).toBeNull();
  expect(readStatus("../inbox")).toBeNull();
});

test("claim on a corrupt status.json returns null and leaves status.json in place", async () => {
  const { writeBundle, claim, bundleDir } = await store();
  const b = writeBundle(sampleInput, {});
  const status = join(bundleDir(b.id), "status.json");
  writeFileSync(status, "{not json");
  expect(claim(b.id, "p1")).toBeNull();
  expect(existsSync(status)).toBe(true);
  expect(existsSync(`${status}.claim-p1`)).toBe(false);
});

test("updateStatus restores the original status when fn throws or yields an invalid status", async () => {
  const { writeBundle, updateStatus, readStatus } = await store();
  const b = writeBundle(sampleInput, {});
  const before = readStatus(b.id);
  expect(() => updateStatus(b.id, "p1", () => { throw new Error("boom"); })).toThrow("boom");
  expect(readStatus(b.id)).toEqual(before);
  expect(() => updateStatus(b.id, "p1", (s) => ({ ...s, state: "bogus" as any }))).toThrow();
  expect(readStatus(b.id)).toEqual(before);
});

test("a stale claim older than the TTL is recovered by the next claim", async () => {
  const { writeBundle, claim, bundleDir, STALE_CLAIM_MS } = await store();
  expect(STALE_CLAIM_MS).toBe(60_000);
  const b = writeBundle(sampleInput, {});
  const status = join(bundleDir(b.id), "status.json");
  renameSync(status, `${status}.claim-dead`);
  const past = (Date.now() - 61_000) / 1000;
  utimesSync(`${status}.claim-dead`, past, past);
  expect(claim(b.id, "p2")!.state).toBe("queued");
  expect(existsSync(`${status}.claim-dead`)).toBe(false);
});

test("a fresh claim is not recovered", async () => {
  const { writeBundle, claim } = await store();
  const b = writeBundle(sampleInput, {});
  expect(claim(b.id, "p1")).not.toBeNull();
  expect(claim(b.id, "p2")).toBeNull();
});

test("claiming an old status is still exclusive", async () => {
  const { writeBundle, claim, bundleDir } = await store();
  const b = writeBundle(sampleInput, {});
  const past = (Date.now() - 120_000) / 1000;
  utimesSync(join(bundleDir(b.id), "status.json"), past, past);
  expect(claim(b.id, "p1")).not.toBeNull();
  expect(claim(b.id, "p2")).toBeNull();
});

test("restoreClaim puts a claimed status back", async () => {
  const { writeBundle, claim, readStatus, restoreClaim } = await store();
  const b = writeBundle(sampleInput, {});
  expect(claim(b.id, "o")).not.toBeNull();
  expect(existsSync(join(home, "inbox", b.id, "status.json"))).toBe(false);
  restoreClaim(b.id, "o");
  expect(readStatus(b.id)!.state).toBe("queued");
});

test("readStatus reads the held claim while status.json is renamed away", async () => {
  const { writeBundle, claim, release, readStatus, bundleDir } = await store();
  const b = writeBundle(sampleInput, {});
  expect(claim(b.id, "old")).not.toBeNull();
  const oldClaim = join(bundleDir(b.id), "status.json.claim-old");
  writeFileSync(oldClaim, JSON.stringify({ state: "acked", at: "2026-01-01T00:00:00.000Z" }));
  utimesSync(oldClaim, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
  writeFileSync(join(bundleDir(b.id), "status.json.claim-new"), JSON.stringify({ state: "delivered", via: "herdr", at: "2026-01-02T00:00:00.000Z" }));
  expect(readStatus(b.id)).toMatchObject({ state: "delivered", via: "herdr" });
  rmSync(join(bundleDir(b.id), "status.json.claim-new"));
  expect(readStatus(b.id)).toMatchObject({ state: "acked" });
  release(b.id, "old", { state: "queued", at: "x" });
  expect(readStatus(b.id)!.state).toBe("queued");
});

test("readStatus is null when neither status.json nor a claim parses", async () => {
  const { writeBundle, readStatus, bundleDir } = await store();
  const b = writeBundle(sampleInput, {});
  rmSync(join(bundleDir(b.id), "status.json"));
  expect(readStatus(b.id)).toBeNull();
  writeFileSync(join(bundleDir(b.id), "status.json.claim-x"), "junk");
  expect(readStatus(b.id)).toBeNull();
});

test("archiveOlderThan leaves a bundle whose sentAt doesn't parse in the inbox", async () => {
  const { writeBundle, archiveOlderThan, bundleDir } = await store();
  const b = writeBundle(sampleInput, {});
  const file = join(bundleDir(b.id), "annotations.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), sentAt: "junk" }));
  expect(archiveOlderThan(30, new Date("2027-01-01T00:00:00Z"))).toEqual([]);
  expect(existsSync(bundleDir(b.id))).toBe(true);
});

test("archiveOlderThan keeps going when one bundle can't be moved", async () => {
  const { writeBundle, archiveOlderThan, bundleDir } = await store();
  const stuck = writeBundle({ ...sampleInput, title: "stuck", sentAt: "2026-07-01T00:00:00.000Z" }, {});
  const other = writeBundle({ ...sampleInput, title: "other", sentAt: "2026-07-02T00:00:00.000Z" }, {});
  mkdirSync(join(home, "archive", stuck.id), { recursive: true });
  writeFileSync(join(home, "archive", stuck.id, "occupied"), "x");
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    expect(archiveOlderThan(30, new Date("2026-09-24T00:00:00Z"))).toEqual([other.id]);
  } finally {
    console.error = orig;
  }
  expect(errors.length).toBe(1);
  expect(existsSync(bundleDir(stuck.id))).toBe(true);
  expect(existsSync(join(home, "archive", other.id, "annotations.json"))).toBe(true);
});

const latestLink = () => join(home, "inbox", "latest");
const latestTarget = () => readLatest(join(home, "inbox"));

test("inbox/latest points at the bundle written last, re-pointed on every write", async () => {
  const { writeBundle } = await store();
  const a = writeBundle({ ...sampleInput, title: "zeta" }, {}, new Date(2026, 5, 1, 12, 0, 0));
  expect(latestTarget()).toBe(a.id);
  expect(readFileSync(join(latestLink(), "README.md"), "utf8")).toContain("zeta");
  const b = writeBundle({ ...sampleInput, title: "alpha" }, {}, new Date(2026, 5, 1, 12, 0, 0));
  expect(latestTarget()).toBe(b.id);
  expect(readdirSync(join(home, "inbox")).filter((n) => n.startsWith("latest")).sort()).toEqual(["latest", LATEST_ID_FILE]);
});

test.skipIf(process.platform === "win32")("on macOS and Linux inbox/latest stays a relative symlink", async () => {
  const { writeBundle } = await store();
  const a = writeBundle(sampleInput, {}, new Date(2026, 5, 1, 12, 0, 0));
  expect(readlinkSync(latestLink())).toBe(a.id);
});

test("listing, queuedFor and the archive sweep never treat inbox/latest as a bundle", async () => {
  const { archiveOlderThan, listBundles, queuedFor, writeBundle } = await store();
  const b = writeBundle(sampleInput, {}, new Date(2026, 5, 1));
  expect(listBundles().map((r) => r.bundle.id)).toEqual([b.id]);
  expect(queuedFor("claude", "s-1", "/tmp/repo").map((x) => x.id)).toEqual([b.id]);
  expect(archiveOlderThan(30, new Date(2026, 5, 2))).toEqual([]);
  expect(latestTarget()).toBe(b.id);
});

test("the archive sweep re-points inbox/latest at the newest bundle left, or removes it when none is", async () => {
  const { archiveOlderThan, writeBundle } = await store();
  const kept = writeBundle({ ...sampleInput, sentAt: "2026-06-01T00:00:00.000Z", title: "kept" }, {}, new Date(2026, 5, 1));
  const old = writeBundle({ ...sampleInput, sentAt: "2026-01-01T00:00:00.000Z", title: "old" }, {}, new Date(2026, 0, 1));
  expect(latestTarget()).toBe(old.id);
  expect(archiveOlderThan(30, new Date(2026, 5, 2))).toEqual([old.id]);
  expect(latestTarget()).toBe(kept.id);
  expect(archiveOlderThan(30, new Date(2026, 11, 1))).toEqual([kept.id]);
  expect(existsSync(latestLink())).toBe(false);
  expect(existsSync(join(home, "inbox", LATEST_ID_FILE))).toBe(false);
  expect(latestTarget()).toBeNull();
});
