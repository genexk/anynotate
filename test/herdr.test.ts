import { afterEach, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { bunExec, type Exec } from "../src/bridge/exec";
import { herdrBin, herdrPromptText, listPanes, newWorkspaceCache, WORKSPACE_CACHE_MS, WORKSPACE_LIST_TIMEOUT_MS, PROMPT_TIMEOUT_MS, promptPane, readNamedPanes, readPanes, waitIdle } from "../src/bridge/herdr";
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

test("listPanes names each pane's workspace, reading the workspace list alongside the panes", async () => {
  const agents = JSON.stringify({ result: { agents: [
    { agent: "claude", agent_status: "idle", cwd: "/r1", pane_id: "w4:pV", workspace_id: "w4" },
    { agent: "codex", agent_status: "idle", cwd: "/r2", pane_id: "w1:p2", workspace_id: "w1" },
    { agent: "claude", agent_status: "idle", cwd: "/r3", pane_id: "w9:p1", workspace_id: "w9" },
  ] } });
  const workspaces = JSON.stringify({ result: { type: "workspace_list", workspaces: [
    { workspace_id: "w4", label: "[1] shop", number: 1 },
    { workspace_id: "w1", label: "  docs\nsite ", number: 2 },
  ] } });
  const calls: string[][] = [];
  const timeouts: Record<string, number | undefined> = {};
  const base = fakeExec({ "agent list": { code: 0, stdout: agents }, "workspace list": { code: 0, stdout: workspaces } }, calls);
  const exec: Exec = (argv, t) => { timeouts[argv.slice(1, 3).join(" ")] = t; return base(argv, t); };
  const panes = await listPanes(exec, "herdr", newWorkspaceCache());
  expect(panes.map((p) => [p.pane, p.workspace])).toEqual([["w4:pV", "shop"], ["w1:p2", "docs site"], ["w9:p1", undefined]]);
  expect(panes[2]).not.toHaveProperty("workspace");
  expect(panes[0]).not.toHaveProperty("workspaceId");
  expect(calls.map((c) => c.slice(1).join(" ")).sort()).toEqual(["agent list", "workspace list"]);
  expect(timeouts["workspace list"]).toBeLessThanOrEqual(WORKSPACE_LIST_TIMEOUT_MS);
  expect(WORKSPACE_LIST_TIMEOUT_MS).toBeLessThanOrEqual(1500);
});

test("workspace names are reused for a short while, then read again", async () => {
  const agents = JSON.stringify({ result: { agents: [{ agent: "claude", agent_status: "idle", cwd: "/r1", pane_id: "w4:pV", workspace_id: "w4" }] } });
  const ws = (label: string) => JSON.stringify({ result: { workspaces: [{ workspace_id: "w4", label }] } });
  let label = "first";
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: argv[1] === "agent" ? agents : ws(label), stderr: "" };
  };
  let now = 1_000_000;
  const cache = newWorkspaceCache(() => now);
  expect((await listPanes(exec, "herdr", cache))[0]!.workspace).toBe("first");
  label = "second";
  now += WORKSPACE_CACHE_MS - 1;
  expect((await listPanes(exec, "herdr", cache))[0]!.workspace).toBe("first");
  now += 2;
  expect((await listPanes(exec, "herdr", cache))[0]!.workspace).toBe("second");
  expect(calls.filter((c) => c[1] === "workspace")).toHaveLength(2);
});

test("listPanes keeps panes without workspace names when workspace list fails", async () => {
  const agents = JSON.stringify({ result: { agents: [{ agent: "claude", agent_status: "idle", cwd: "/r1", pane_id: "w4:pV", workspace_id: "w4" }] } });
  for (const ws of [{ code: 1, stderr: "old herdr" }, { code: 0, stdout: "nope" }]) {
    const panes = await listPanes(fakeExec({ "agent list": { code: 0, stdout: agents }, "workspace list": ws }, []), "herdr", newWorkspaceCache());
    expect(panes).toEqual([{ pane: "w4:pV", agent: "claude", cwd: "/r1", title: "", status: "idle" }]);
  }
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
  process.env.ANYNOTATE_HOME = resolve("/home/me/.anynotate");
  const calls: string[][] = [];
  expect(await promptPane("w4:pV", "b-1", { exec: fakeExec({}, calls), bin: "herdr" })).toEqual({ ok: true });
  expect(calls).toEqual([["herdr", "agent", "prompt", "w4:pV", herdrPromptText("b-1"), "--wait", "--until", "working", "--until", "idle", "--timeout", "10000"]]);
  expect(herdrPromptText("b-1")).toBe(`Browser notes waiting: read ${join(resolve("/home/me/.anynotate"), "inbox", "b-1", "README.md")} and act on them.`);
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

test("herdrBin prefers ANYNOTATE_HERDR, then herdr's own HERDR_BIN_PATH while it exists, then herdr on PATH", () => {
  const exists = (p: string) => p === "/b/herdr";
  expect(herdrBin({ ANYNOTATE_HERDR: "/a/herdr", HERDR_BIN_PATH: "/b/herdr" }, exists)).toBe("/a/herdr");
  expect(herdrBin({ HERDR_BIN_PATH: "/b/herdr" }, exists)).toBe("/b/herdr");
  expect(herdrBin({ HERDR_BIN_PATH: "/gone/herdr" }, exists)).toBe("herdr");
  expect(herdrBin({ HERDR_BIN_PATH: "/gone/herdr" })).toBe("herdr");
  expect(herdrBin({ ANYNOTATE_HERDR: "", HERDR_BIN_PATH: "" }, exists)).toBe("herdr");
});

test("readPanes says why herdr could not list panes", async () => {
  expect(await readPanes(fakeExec({ "agent list": { code: 0, stdout: listJson } }, []), "herdr")).toMatchObject({ panes: [{ pane: "w4:pV" }, { pane: "w1:p2" }, { pane: "w1:p3" }] });
  expect(await readPanes(fakeExec({ "agent list": { code: 2, stderr: "server not running" } }, []), "herdr")).toEqual({ error: "server not running" });
  expect(await readPanes(fakeExec({ "agent list": { code: 0, stdout: "nope" } }, []), "herdr")).toEqual({ error: "herdr agent list printed something that is not JSON" });
  expect(await readPanes(bunExec, "/nonexistent/herdr")).toEqual({ error: "herdr not found: /nonexistent/herdr", missing: true });
});

test("bunExec says when it stopped a command for running past its timeout", async () => {
  const r = await bunExec([process.execPath, "-e", "await Bun.sleep(5000)"], 200);
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("timed out after 200 ms");
});

test("readNamedPanes names workspaces with the [n] prefix stripped and passes herdr errors through", async () => {
  const agents = JSON.stringify({ result: { agents: [{ agent: "claude", agent_status: "idle", cwd: "/r1", pane_id: "w4:pV", workspace_id: "w4" }] } });
  const workspaces = JSON.stringify({ result: { workspaces: [{ workspace_id: "w4", label: "[3] research" }] } });
  const ok = await readNamedPanes(fakeExec({ "agent list": { code: 0, stdout: agents }, "workspace list": { code: 0, stdout: workspaces } }, []), "herdr", newWorkspaceCache());
  expect(ok).toEqual({ panes: [{ pane: "w4:pV", agent: "claude", cwd: "/r1", title: "", status: "idle", workspace: "research" }] });
  const failed = await readNamedPanes(fakeExec({ "agent list": { code: 2, stderr: "server not running" } }, []), "herdr", newWorkspaceCache());
  expect(failed).toEqual({ error: "server not running" });
});
