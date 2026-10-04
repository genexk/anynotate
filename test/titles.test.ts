import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanTitle, createTitler, MISS_RETRY_MS, TITLE_MAX } from "../src/bridge/titles";

let root: string;
let claudeProjects: string;
let codexHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anynotate-titles-"));
  claudeProjects = join(root, "claude", "projects");
  codexHome = join(root, "codex");
  mkdirSync(claudeProjects, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const titler = () => createTitler(() => ({ claudeProjects, codexHome }));
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const SID = "0b5e6c1a-1111-4222-8333-944455556666";

function claudeTranscript(cwd: string, rows: unknown[], sid = SID) {
  const dir = join(claudeProjects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, jsonl(rows));
  return path;
}
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content }, ...extra });

test("cleanTitle keeps one line and cuts long text with an ellipsis", () => {
  expect(cleanTitle("  fix the\n\tlogin   page  ")).toBe("fix the login page");
  const long = cleanTitle("word ".repeat(40));
  expect(Array.from(long)).toHaveLength(TITLE_MAX);
  expect(long.endsWith("…")).toBe(true);
  expect(cleanTitle("<command-name>/clear</command-name>\n<command-args></command-args>")).toBe("");
  expect(cleanTitle("<system-reminder>ctx</system-reminder>\nmake the button blue")).toBe("make the button blue");
});

test("a Claude session prefers its custom title, then the newest ai title", () => {
  const t = titler();
  const path = claudeTranscript("/home/me/shop", [
    user("first prompt"),
    { type: "ai-title", aiTitle: "Older AI title", sessionId: SID },
    { type: "ai-title", aiTitle: "Newer AI title", sessionId: SID },
  ]);
  expect(t({ agent: "claude", sessionId: SID, cwd: "/home/me/shop" })).toBe("Newer AI title");
  appendFileSync(path, jsonl([{ type: "custom-title", customTitle: "Checkout rework", sessionId: SID }, { type: "ai-title", aiTitle: "Later AI", sessionId: SID }]));
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  expect(t({ agent: "claude", sessionId: SID, cwd: "/home/me/shop" })).toBe("Checkout rework");
});

test("a Claude session without a title entry uses a summary, else its first real prompt", () => {
  claudeTranscript("/home/me/a", [{ type: "summary", summary: "Summary title", leafUuid: "x" }, user("prompt")]);
  expect(titler()({ agent: "claude", sessionId: SID, cwd: "/home/me/a" })).toBe("Summary title");

  claudeTranscript("/home/me/b", [
    user("<local-command-caveat>Caveat text</local-command-caveat>", { isMeta: true }),
    user("<command-name>/model</command-name>\n<command-args></command-args>"),
    user([{ type: "tool_result", content: "out" }]),
    user("side", { isSidechain: true }),
    user([{ type: "image", source: {} }, { type: "text", text: "<system-reminder>r</system-reminder>\nmake the\nheader sticky" }]),
    user("second prompt"),
  ]);
  expect(titler()({ agent: "claude", sessionId: SID, cwd: "/home/me/b" })).toBe("make the header sticky");
});

test("a Claude transcript filed under another folder name is still found", () => {
  const dir = join(claudeProjects, "-some-other-name");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), jsonl([{ type: "ai-title", aiTitle: "Found anyway" }]));
  expect(titler()({ agent: "claude", sessionId: SID, cwd: "/home/me/moved" })).toBe("Found anyway");
});

test("a title entry far from the start of a large transcript is read from its tail", () => {
  claudeTranscript("/home/me/big", [user("first prompt"), ...Array.from({ length: 4000 }, () => ({ type: "assistant", message: { content: "x".repeat(200) } })), { type: "ai-title", aiTitle: "Tail title" }]);
  expect(titler()({ agent: "claude", sessionId: SID, cwd: "/home/me/big" })).toBe("Tail title");
});

test("a Codex session uses its thread name, else its first user message", () => {
  writeFileSync(join(codexHome, "session_index.jsonl"), jsonl([
    { id: SID, thread_name: "Old name", updated_at: "2026-10-01T00:00:00Z" },
    { id: SID, thread_name: "Renamed thread", updated_at: "2026-10-02T00:00:00Z" },
  ]));
  expect(titler()({ agent: "codex", sessionId: SID, cwd: "/home/me/x" })).toBe("Renamed thread");

  const other = "7a7a7a7a-1111-4222-8333-944455556666";
  const day = join(codexHome, "sessions", "2026", "10", "02");
  mkdirSync(day, { recursive: true });
  const msg = (role: string, text: string) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  writeFileSync(join(day, `rollout-2026-10-02T10-00-00-${other}.jsonl`), jsonl([
    { type: "session_meta", payload: { id: other, cwd: "/home/me/x" } },
    msg("developer", "<permissions instructions>p</permissions instructions>"),
    msg("user", "# AGENTS.md instructions for /home/me/x\n\nrules"),
    msg("user", "<environment_context>\n  <cwd>/home/me/x</cwd>\n</environment_context>"),
    msg("user", "rename the settings tab"),
  ]));
  expect(titler()({ agent: "codex", sessionId: other, cwd: "/home/me/x" })).toBe("rename the settings tab");

  writeFileSync(join(day, `rollout-2026-10-02T11-00-00-${SID.replace("0b", "0c")}.jsonl`), jsonl([
    msg("user", "<environment_context></environment_context>"),
    { type: "event_msg", payload: { type: "user_message", message: "typed by the user" } },
    msg("user", "typed by the user"),
  ]));
  expect(titler()({ agent: "codex", sessionId: SID.replace("0b", "0c"), cwd: "/home/me/x" })).toBe("typed by the user");
});

test("unknown agents, missing files, unsafe ids and malformed lines give an empty title", () => {
  const t = titler();
  expect(t({ agent: "gemini", sessionId: SID, cwd: "/home/me" })).toBe("");
  expect(t({ agent: "claude", sessionId: SID, cwd: "/home/me/none" })).toBe("");
  expect(t({ agent: "codex", sessionId: SID, cwd: "/home/me/none" })).toBe("");
  expect(t({ agent: "claude", sessionId: "../../etc/passwd", cwd: "/home/me" })).toBe("");
  claudeTranscript("/home/me/bad", ["not json", "{", { type: "ai-title", aiTitle: 42 }]);
  writeFileSync(join(claudeProjects, "-home-me-bad", `${SID}.jsonl`), "{ broken\n[1,2]\nnull\n");
  expect(t({ agent: "claude", sessionId: SID, cwd: "/home/me/bad" })).toBe("");
  expect(createTitler(() => { throw new Error("no home"); })({ agent: "claude", sessionId: SID, cwd: "/" })).toBe("");
});

test("titles are cached until the transcript changes", () => {
  const t = titler();
  const path = claudeTranscript("/home/me/c", [{ type: "ai-title", aiTitle: "First" }]);
  const at = new Date("2026-10-01T10:00:00Z");
  utimesSync(path, at, at);
  expect(t({ agent: "claude", sessionId: SID, cwd: "/home/me/c" })).toBe("First");
  writeFileSync(path, jsonl([{ type: "ai-title", aiTitle: "Secnd" }]));
  utimesSync(path, at, at);
  expect(t({ agent: "claude", sessionId: SID, cwd: "/home/me/c" })).toBe("First");
  utimesSync(path, at, new Date(at.getTime() + 10_000));
  expect(t({ agent: "claude", sessionId: SID, cwd: "/home/me/c" })).toBe("Secnd");
});

test("a transcript that is a FIFO or a symlink is skipped without blocking", () => {
  const dir = join(claudeProjects, "-home-me-odd");
  mkdirSync(dir, { recursive: true });
  const target = join(root, "elsewhere.jsonl");
  writeFileSync(target, jsonl([{ type: "ai-title", aiTitle: "Should not be read" }]));
  symlinkSync(target, join(dir, `${SID}.jsonl`));
  expect(titler()({ agent: "claude", sessionId: SID, cwd: "/home/me/odd" })).toBe("");
  if (process.platform !== "win32") {
    const fifoId = "f1f0f1f0-1111-4222-8333-944455556666";
    Bun.spawnSync(["mkfifo", join(dir, `${fifoId}.jsonl`)]);
    expect(titler()({ agent: "claude", sessionId: fifoId, cwd: "/home/me/odd" })).toBe("");
    const day = join(codexHome, "sessions", "2026", "10", "02");
    mkdirSync(day, { recursive: true });
    Bun.spawnSync(["mkfifo", join(day, `rollout-2026-10-02T10-00-00-${fifoId}.jsonl`)]);
    Bun.spawnSync(["mkfifo", join(codexHome, "session_index.jsonl")]);
    expect(titler()({ agent: "codex", sessionId: fifoId, cwd: "/home/me/odd" })).toBe("");
  }
});

test("a session whose transcript is missing is not searched for again for a minute", () => {
  let now = 1_000_000;
  const t = createTitler(() => ({ claudeProjects, codexHome }), () => now);
  const q = { agent: "claude", sessionId: SID, cwd: "/home/me/late" };
  expect(t(q)).toBe("");
  const dir = join(claudeProjects, "-some-other-name");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), jsonl([{ type: "ai-title", aiTitle: "Now there" }]));
  now += MISS_RETRY_MS - 1;
  expect(t(q)).toBe("");
  now += 2;
  expect(t(q)).toBe("Now there");
});

test("a first prompt that looks like a pasted secret or blob gives no title", () => {
  const cases = [
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
    `use token ${["sk", "live", "4eC39HqLyjWDarjtT1zdp7dcAbCdEfGh1234"].join("_")} please`,
    "hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 check",
    "x".repeat(5000),
  ];
  for (const [i, text] of cases.entries()) {
    const cwd = `/home/me/s${i}`;
    claudeTranscript(cwd, [user(text), { type: "last-prompt", lastPrompt: text }]);
    expect(titler()({ agent: "claude", sessionId: SID, cwd })).toBe("");
  }
  claudeTranscript("/home/me/long", [user(`review the plan below\n${"step one is fine. ".repeat(500)}`)]);
  expect(titler()({ agent: "claude", sessionId: SID, cwd: "/home/me/long" })).toBe("review the plan below step one is fine. step one is fine. s…");
  claudeTranscript("/home/me/id", [user("session 0b5e6c1a-1111-4222-8333-944455556666 hangs")]);
  expect(titler()({ agent: "claude", sessionId: SID, cwd: "/home/me/id" })).toBe("session 0b5e6c1a-1111-4222-8333-944455556666 hangs");
  claudeTranscript("/home/me/ok", [user("open /home/me/projects/website/src/components/header/index.tsx and fix it")]);
  expect(titler()({ agent: "claude", sessionId: SID, cwd: "/home/me/ok" })).toBe("open /home/me/projects/website/src/components/header/index.…");
  const day = join(codexHome, "sessions", "2026", "10", "02");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-10-02T10-00-00-${SID}.jsonl`), jsonl([{ type: "event_msg", payload: { type: "user_message", message: cases[0] } }]));
  expect(titler()({ agent: "codex", sessionId: SID, cwd: "/home/me/x" })).toBe("");
});

test("prompts holding well-known credential shapes give no title", () => {
  const r = (alphabet: string, n: number) => Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
  const AZ09 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const mixed = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const fakes = [
    `sk-ant-api03-${r(mixed, 40)}`,
    `sk-proj-${r(mixed, 40)}`,
    `AKIA${r(AZ09, 16)}`,
    `ASIA${r(AZ09, 16)}`,
    `xoxb-${r("0123456789", 12)}-${r(mixed, 24)}`,
    `glpat-${r(mixed, 20)}`,
    `github_pat_${r(mixed, 22)}_${r(mixed, 59)}`,
    `ghp_${r(mixed, 36)}`,
    `gho_${r(mixed, 36)}`,
    `ghs_${r(mixed, 36)}`,
    `eyJ${r(mixed, 20)}.eyJ${r(mixed, 30)}.${r(mixed, 40)}`,
    `AIza${r(mixed, 35)}`,
    `${r(mixed, 13)}/${r(mixed, 7)}/${r(mixed, 18)}`,
  ];
  for (const [i, fake] of fakes.entries()) {
    const cwd = `/home/me/k${i}`;
    claudeTranscript(cwd, [user(`try this key ${fake} on staging`)]);
    expect([i, titler()({ agent: "claude", sessionId: SID, cwd })]).toEqual([i, ""]);
  }
});

test("ordinary prompts with paths, URLs and kebab-case words keep their titles", () => {
  const prompts = [
    "open /home/me/projects/website2/src/components/Header2024/index.tsx",
    "see https://example.com/docs/v2/getting-started/installation-guide-2026.html",
    "rename user-profile-settings-panel-v2-redesign-2026 to settings-v3",
    "the build of my-app-2026.10.03-release-candidate-1 fails on step 4",
    "ask the desk-team about task-1234 before Friday",
    "release notes for v0.6.1 mention protocol 0.5.0 and the 12 h window",
  ];
  for (const [i, text] of prompts.entries()) {
    const cwd = `/home/me/p${i}`;
    claudeTranscript(cwd, [user(text)]);
    expect(titler()({ agent: "claude", sessionId: SID, cwd })).toBe(cleanTitle(text));
  }
});
