import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPECTED_EXTENSION, extensionIsOlder, extensionLabel, extensionRecorder, extensionsPath, parseSender, readExtensions, type SeenExtension,
  senderFromHeader, senderNote,
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

const STORE = "chrome-extension://lefcmfmbmjmgfkgbbcodolcecbnfjgpp";
const DEV = "chrome-extension://epdjidoapjkdefnpaibacfepphipdioh";
const OTHER = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function clock(start = T0) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
}
const stored = () => JSON.parse(readFileSync(extensionsPath(), "utf8")) as { extensions: SeenExtension[] };
const seen = (at = T0) => readExtensions(extensionsPath(), new Date(at)).map((e) => `${e.version} ${extensionLabel(e.origin)}`);

test("extensions are labelled by where they came from", () => {
  expect(extensionLabel(STORE)).toBe("Chrome Web Store");
  expect(extensionLabel(DEV)).toBe("dev build");
  expect(extensionLabel(OTHER)).toBe("unpacked build abcd…");
  expect(extensionLabel("")).toBe("build not recorded");
});

test("two profiles on the store build with different versions are two entries, newest first", () => {
  const c = clock();
  const record = extensionRecorder({ now: c.now });
  record("0.3.1", STORE);
  c.advance(MIN);
  record("0.2.0", STORE);
  expect(extensionsPath()).toBe(join(home, "extensions.json"));
  expect(seen(T0 + MIN)).toEqual(["0.2.0 Chrome Web Store", "0.3.1 Chrome Web Store"]);
  expect(stored().extensions).toEqual([
    { origin: STORE, version: "0.2.0", lastSeen: new Date(T0 + MIN).toISOString() },
    { origin: STORE, version: "0.3.1", lastSeen: new Date(T0).toISOString() },
  ]);
  if (process.platform !== "win32") expect(statSync(extensionsPath()).mode & 0o777).toBe(0o600);
  expect(readdirSync(home).filter((n) => n.includes(".tmp-"))).toEqual([]);
});

test("the store and dev builds on the same version are separate entries", () => {
  const record = extensionRecorder({ now: clock().now });
  record("0.3.1", STORE);
  record("0.3.1", DEV);
  expect(seen().sort()).toEqual(["0.3.1 Chrome Web Store", "0.3.1 dev build"]);
});

test("an extension not seen for 14 days drops out", () => {
  const c = clock();
  const record = extensionRecorder({ now: c.now });
  record("0.2.0", OTHER);
  c.advance(14 * DAY - MIN);
  record("0.3.1", STORE);
  expect(seen(T0 + 14 * DAY - MIN)).toEqual(["0.3.1 Chrome Web Store", "0.2.0 unpacked build abcd…"]);
  expect(seen(T0 + 14 * DAY + MIN)).toEqual(["0.3.1 Chrome Web Store"]);
  c.advance(2 * MIN);
  record("0.3.2", STORE);
  expect(stored().extensions.map((e) => e.version)).toEqual(["0.3.2", "0.3.1"]);
});

test("at most 20 extensions are kept, dropping the oldest", () => {
  const c = clock();
  const record = extensionRecorder({ now: c.now });
  for (let i = 0; i < 25; i++) {
    record(`0.3.${i}`, STORE);
    c.advance(MIN);
  }
  const versions = stored().extensions.map((e) => e.version);
  expect(versions).toHaveLength(20);
  expect(versions[0]).toBe("0.3.24");
  expect(versions.at(-1)).toBe("0.3.5");
});

test("a repeat sighting rewrites the file only after five minutes", () => {
  const c = clock();
  const record = extensionRecorder({ now: c.now });
  record("0.3.1", STORE);
  const first = readFileSync(extensionsPath(), "utf8");
  c.advance(4 * MIN);
  record("0.3.1", STORE);
  expect(readFileSync(extensionsPath(), "utf8")).toBe(first);
  c.advance(2 * MIN);
  record("0.3.1", STORE);
  expect(stored().extensions).toEqual([{ origin: STORE, version: "0.3.1", lastSeen: new Date(T0 + 6 * MIN).toISOString() }]);
});

test("a malformed file reads as empty and is replaced on the next write", () => {
  for (const bad of ["{not json", "[]", `{"extensions":"x"}`, `{"extensions":[{"origin":"<b>","version":"0.3.1","lastSeen":"2026-10-01T12:00:00.000Z"}]}`]) {
    writeFileSync(extensionsPath(), bad);
    expect(readExtensions(extensionsPath(), new Date(T0))).toEqual([]);
  }
  writeFileSync(extensionsPath(), JSON.stringify({ extensions: [
    { origin: STORE, version: "0.3.1", lastSeen: new Date(T0).toISOString() },
    { origin: DEV, version: "<script>", lastSeen: new Date(T0).toISOString() },
    { origin: DEV, version: "0.3.1", lastSeen: "yesterday" },
  ] }));
  expect(seen()).toEqual(["0.3.1 Chrome Web Store"]);
  writeFileSync(extensionsPath(), "{not json");
  extensionRecorder({ now: clock().now })("0.3.1", DEV);
  expect(seen()).toEqual(["0.3.1 dev build"]);
});

test("the 0.6.4 extension-version file seeds the list once and is then removed", () => {
  const legacy = join(home, "extension-version");
  writeFileSync(legacy, "0.2.0\n");
  utimesSync(legacy, new Date(T0 - DAY), new Date(T0 - DAY));
  extensionRecorder({ now: clock().now })("0.3.1", STORE);
  expect(seen()).toEqual(["0.3.1 Chrome Web Store", "0.2.0 build not recorded"]);
  expect(stored().extensions[1]).toEqual({ origin: "", version: "0.2.0", lastSeen: new Date(T0 - DAY).toISOString() });
  expect(existsSync(legacy)).toBe(false);
});

test("an unreadable 0.6.4 file is dropped without seeding anything", () => {
  writeFileSync(join(home, "extension-version"), "<b>hi</b>\n");
  extensionRecorder({ now: clock().now })("0.3.1", STORE);
  expect(seen()).toEqual(["0.3.1 Chrome Web Store"]);
  expect(existsSync(join(home, "extension-version"))).toBe(false);
});

test("a lastSeen more than a day in the future is dropped, so it can't outlive the 14 days", () => {
  writeFileSync(extensionsPath(), JSON.stringify({ extensions: [
    { origin: STORE, version: "0.3.1", lastSeen: new Date(T0 + 30 * DAY).toISOString() },
    { origin: DEV, version: "0.3.1", lastSeen: new Date(T0 + 12 * 60 * MIN).toISOString() },
  ] }));
  expect(readExtensions(extensionsPath(), new Date(T0))).toEqual([
    { origin: DEV, version: "0.3.1", lastSeen: new Date(T0 + 12 * 60 * MIN).toISOString() },
  ]);
  expect(readExtensions(extensionsPath(), new Date(T0 + 15 * DAY))).toEqual([]);
  extensionRecorder({ now: clock().now })("0.3.2", STORE);
  expect(stored().extensions.map((e) => `${e.origin} ${e.version}`)).toEqual([`${DEV} 0.3.1`, `${STORE} 0.3.2`]);
});

test("a temp file left by a crash does not pass its mode on to the list", () => {
  if (process.platform === "win32") return;
  const tmp = `${extensionsPath()}.tmp-${process.pid}`;
  writeFileSync(tmp, "stale", { mode: 0o644 });
  chmodSync(tmp, 0o644);
  extensionRecorder({ now: clock().now })("0.3.1", STORE);
  expect(statSync(extensionsPath()).mode & 0o777).toBe(0o600);
  expect(existsSync(tmp)).toBe(false);
});
