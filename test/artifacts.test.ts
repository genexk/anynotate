import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, openSync, rmSync, truncateSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactIdOf, createArtifactIndex } from "../src/bridge/artifacts";

let root: string;
let claudeProjects: string;
let codexHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anynotate-artifacts-"));
  claudeProjects = join(root, "claude", "projects");
  codexHome = join(root, "codex");
  mkdirSync(claudeProjects, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const index = () => createArtifactIndex(() => ({ claudeProjects, codexHome }));
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const SID = "0b5e6c1a-1111-4222-8333-944455556666";
const CWD = "/home/me/site";
const ID = "Xq7artifactFixture01";
const URL = `https://claude.ai/artifact/${ID}`;

function claudeTranscript(cwd: string, rows: unknown[], sid = SID) {
  const dir = join(claudeProjects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, jsonl(rows));
  return path;
}
const frameLink = (frameUrl: string, timestamp: string) => ({
  type: "frame-link",
  sessionId: SID,
  path: "/home/me/site/page.html",
  frameUrl,
  title: "Page",
  artifactCount: 1,
  timestamp,
});

test("artifactIdOf accepts only claude.ai artifact URLs", () => {
  expect(artifactIdOf(`https://claude.ai/artifact/${ID}`)).toBe(ID);
  expect(artifactIdOf(`https://claude.ai/code/artifact/${ID}`)).toBe(ID);
  expect(artifactIdOf("https://claude.ai/artifact/Xq7a?x=1")).toBe("Xq7a");
  expect(artifactIdOf("https://claude.ai/artifact/Xq7a/")).toBe("Xq7a");
  expect(artifactIdOf("https://claude.ai/artifact/Xq7a#c")).toBe("Xq7a");
  expect(artifactIdOf("https://evil.example/artifact/Xq7a")).toBeNull();
  expect(artifactIdOf("https://claude.ai.evil.example/artifact/Xq7a")).toBeNull();
  expect(artifactIdOf("https://claude.ai/chat/abc")).toBeNull();
  expect(artifactIdOf("http://claude.ai/artifact/x")).toBeNull();
  expect(artifactIdOf("https://claude.ai/artifact/")).toBeNull();
  expect(artifactIdOf("https://claude.ai/artifact/a.b")).toBeNull();
  expect(artifactIdOf(`https://claude.ai/artifact/${"a".repeat(65)}`)).toBeNull();
});

test("keeps each artifact's first publish time, newest first", () => {
  claudeTranscript(CWD, [
    frameLink(URL, "2026-10-29T22:59:47.301Z"),
    frameLink("https://claude.ai/code/artifact/other-1", "2026-10-29T23:10:00.000Z"),
    frameLink(URL, "2026-10-29T23:42:00.000Z"),
  ]);
  expect(index()({ sessionId: SID, cwd: CWD })).toEqual([
    { id: "other-1", at: "2026-10-29T23:10:00.000Z" },
    { id: ID, at: "2026-10-29T22:59:47.301Z" },
  ]);
});

test("rows that only mention an artifact URL do not count", () => {
  claudeTranscript(CWD, [
    { type: "user", message: { role: "user", content: `look at ${URL} (frame-link)` }, timestamp: "2026-10-29T22:00:00.000Z" },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: `Published frame-link at ${URL}` }] },
      frameUrl: URL,
      timestamp: "2026-10-29T22:01:00.000Z",
    },
    { type: "assistant", message: { content: [{ type: "tool_use", input: { url: URL } }] }, timestamp: "2026-10-29T22:02:00.000Z" },
  ]);
  expect(index()({ sessionId: SID, cwd: CWD })).toEqual([]);
});

test("a truncated last line and a non-artifact frameUrl are skipped without throwing", () => {
  const path = claudeTranscript(CWD, [frameLink("https://example.com/x", "2026-10-29T22:00:00.000Z"), frameLink(URL, "2026-10-29T22:59:47.301Z")]);
  appendFileSync(path, JSON.stringify(frameLink("https://claude.ai/artifact/half", "2026-10-29T23:00:00.000Z")).slice(0, 60));
  const idx = index();
  expect(idx({ sessionId: SID, cwd: CWD })).toEqual([{ id: ID, at: "2026-10-29T22:59:47.301Z" }]);
});

test("a partial trailing line is read once it is completed", () => {
  const path = claudeTranscript(CWD, [frameLink(URL, "2026-10-29T22:59:47.301Z")]);
  const line = JSON.stringify(frameLink("https://claude.ai/artifact/later", "2026-10-29T23:00:00.000Z"));
  appendFileSync(path, line.slice(0, 40));
  const idx = index();
  expect(idx({ sessionId: SID, cwd: CWD }).map((a) => a.id)).toEqual([ID]);
  appendFileSync(path, `${line.slice(40)}\n`);
  expect(idx({ sessionId: SID, cwd: CWD }).map((a) => a.id)).toEqual(["later", ID]);
});

test("reads only appended bytes, and re-reads from 0 when the file shrinks", () => {
  const path = claudeTranscript(CWD, [frameLink(URL, "2026-10-29T22:59:47.301Z")]);
  const idx = index();
  expect(idx({ sessionId: SID, cwd: CWD }).map((a) => a.id)).toEqual([ID]);

  const swapped = jsonl([frameLink(URL.replace(ID, "YYYYYYYYYYYYYYYYYYYY"), "2026-10-29T22:59:47.301Z")]);
  const fd = openSync(path, "r+");
  writeSync(fd, Buffer.from(swapped), 0, Buffer.byteLength(swapped), 0);
  closeSync(fd);
  appendFileSync(path, jsonl([frameLink("https://claude.ai/artifact/second", "2026-10-29T23:00:00.000Z")]));
  expect(idx({ sessionId: SID, cwd: CWD }).map((a) => a.id)).toEqual(["second", ID]);

  writeFileSync(path, jsonl([frameLink("https://claude.ai/artifact/fresh", "2026-10-29T21:00:00.000Z")]));
  expect(idx({ sessionId: SID, cwd: CWD })).toEqual([{ id: "fresh", at: "2026-10-29T21:00:00.000Z" }]);

  truncateSync(path, 0);
  expect(idx({ sessionId: SID, cwd: CWD })).toEqual([]);
});

test("more than 50 artifacts returns the newest 50", () => {
  const rows = Array.from({ length: 60 }, (_, i) =>
    frameLink(`https://claude.ai/artifact/a${i}`, new Date(Date.UTC(2026, 9, 29, 0, i)).toISOString()),
  );
  claudeTranscript(CWD, rows);
  const got = index()({ sessionId: SID, cwd: CWD });
  expect(got).toHaveLength(50);
  expect(got[0]?.id).toBe("a59");
  expect(got[49]?.id).toBe("a10");
});

test("an unsafe session id or a missing transcript gives []", () => {
  claudeTranscript(CWD, [frameLink(URL, "2026-10-29T22:59:47.301Z")]);
  const idx = index();
  expect(idx({ sessionId: "../x", cwd: CWD })).toEqual([]);
  expect(idx({ sessionId: "1c0ffee0-0000-4000-8000-000000000000", cwd: CWD })).toEqual([]);
});

test("a transcript found after a miss is picked up once the retry window passes", () => {
  let t = 1_000_000;
  const idx = createArtifactIndex(() => ({ claudeProjects, codexHome }), () => t);
  expect(idx({ sessionId: SID, cwd: CWD })).toEqual([]);
  claudeTranscript(CWD, [frameLink(URL, "2026-10-29T22:59:47.301Z")]);
  expect(idx({ sessionId: SID, cwd: CWD })).toEqual([]);
  t += 61_000;
  expect(idx({ sessionId: SID, cwd: CWD }).map((a) => a.id)).toEqual([ID]);
});

test("an over-long line is skipped and the frame-link rows around it still count", () => {
  const path = claudeTranscript(CWD, [frameLink(URL, "2026-10-29T22:59:47.301Z")]);
  appendFileSync(path, `${JSON.stringify({ type: "user", text: `frame-link ${"x".repeat(3 * 1024 * 1024)}` })}\n`);
  appendFileSync(path, jsonl([frameLink("https://claude.ai/artifact/after", "2026-10-29T23:00:00.000Z")]));
  expect(index()({ sessionId: SID, cwd: CWD }).map((a) => a.id)).toEqual(["after", ID]);
});
