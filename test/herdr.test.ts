import { afterEach, expect, test } from "bun:test";
import { bunExec, type Exec } from "../src/bridge/exec";
import { herdrPromptText, listPanes, PROMPT_TIMEOUT_MS, promptPane, waitIdle } from "../src/bridge/herdr";
import { STALE_CLAIM_MS } from "../src/inbox/store";

const originalHome = process.env.ANYNOTATE_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.ANYNOTATE_HOME;
  else process.env.ANYNOTATE_HOME = originalHome;
});

const listJson = JSON.stringify({ id: "cli:agent:list", result: { agents: [
  { agent: "claude", agent_status: "idle", cwd: "/r1", pane_id: "w4:pV", terminal_title_stripped: "Build logs" },
  { agent: "codex", agent_status: "working", cwd: "/r2", pane_id: "w1:p2", terminal_title_stripped: "" },
  { agent: "agy", agent_status: "idle", cwd: "/r3", pane_id: "w1:p3" },
  { agent_status: "idle", cwd: "/r4", pane_id: "w1:p4" },
  { agent: "unknown", agent_status: "idle", cwd: "/r5", pane_id: "w1:p5" },
  { agent: "Not A Name", agent_status: "idle", cwd: "/r6", pane_id: "w1:p6" },
] } });

const fakeExec = (responses: Record<string, { code: number; stdout?: string; stderr?: string }>, calls: string[][]): Exec =>
  async (argv) => {
    calls.push(argv);
    const r = responses[argv.slice(1, 3).join(" ")] ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

test("listPanes keeps every agent herdr detects and drops panes without a usable agent name", async () => {
  const calls: string[][] = [];
  const panes = await listPanes(fakeExec({ "agent list": { code: 0, stdout: listJson } }, calls), "herdr");
  expect(panes).toEqual([
    { pane: "w4:pV", agent: "claude", cwd: "/r1", title: "Build logs", status: "idle" },
    { pane: "w1:p2", agent: "codex", cwd: "/r2", title: "", status: "working" },
    { pane: "w1:p3", agent: "agy", cwd: "/r3", title: "", status: "idle" },
  ]);
});

test("listPanes returns [] when herdr fails or prints junk", async () => {
  expect(await listPanes(fakeExec({ "agent list": { code: 1 } }, []), "herdr")).toEqual([]);
  expect(await listPanes(fakeExec({ "agent list": { code: 0, stdout: "nope" } }, []), "herdr")).toEqual([]);
});

test("waitIdle waits for idle or done with the given timeout", async () => {
  const calls: string[][] = [];
  expect(await waitIdle("w4:pV", { exec: fakeExec({}, calls), bin: "herdr", idleTimeoutMs: 1000 })).toEqual({ ok: true });
  expect(calls).toEqual([["herdr", "agent", "wait", "w4:pV", "--until", "idle", "--until", "done", "--timeout", "1000"]]);
});

test("promptPane submits the fixed path-only prompt", async () => {
  process.env.ANYNOTATE_HOME = "/tmp/mh";
  const calls: string[][] = [];
  expect(await promptPane("w4:pV", "b-1", { exec: fakeExec({}, calls), bin: "herdr" })).toEqual({ ok: true });
  expect(calls).toEqual([["herdr", "agent", "prompt", "w4:pV", herdrPromptText("b-1"), "--wait", "--until", "working", "--until", "idle", "--timeout", "10000"]]);
  expect(herdrPromptText("b-1")).toBe("Browser notes waiting: read /tmp/mh/inbox/b-1/README.md and act on them.");
});

test("promptPane's exec timeout stays below the stale-claim TTL", async () => {
  const timeouts: number[] = [];
  await promptPane("p", "b", { exec: async (_argv, t) => { timeouts.push(t ?? -1); return { code: 0, stdout: "", stderr: "" }; }, bin: "herdr" });
  expect(timeouts).toEqual([PROMPT_TIMEOUT_MS]);
  expect(PROMPT_TIMEOUT_MS).toBeLessThan(STALE_CLAIM_MS);
});

test("waitIdle and promptPane report herdr's error text", async () => {
  expect(await waitIdle("p", { exec: fakeExec({ "agent wait": { code: 1, stderr: "timeout" } }, []), bin: "herdr" })).toEqual({ ok: false, error: "timeout" });
  expect(await promptPane("p", "b", { exec: fakeExec({ "agent prompt": { code: 1, stdout: "no pane" } }, []), bin: "herdr" })).toEqual({ ok: false, error: "no pane" });
});

test("a missing herdr binary degrades instead of throwing", async () => {
  expect(await listPanes(bunExec, "/nonexistent/herdr")).toEqual([]);
  const r = await waitIdle("p", { exec: bunExec, bin: "/nonexistent/herdr", idleTimeoutMs: 1000 });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/ENOENT|no such file|not found/i);
});
