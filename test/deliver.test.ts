import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverToPane } from "../src/bridge/router";
import { claim, readStatus, updateStatus, writeBundle } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";
import { cliArgv, writeHerdrShim } from "./fixtures/spawn";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

const ok = async () => ({ ok: true as const });
const any = () => true;
const ack = (id: string) => updateStatus(id, "test-ack", (s) => ({ ...s, state: "acked", summary: "done" }));

test("deliverToPane records a new herdr delivery over an acked bundle, keeping the earlier ack summary", async () => {
  const b = writeBundle(sampleInput, {});
  ack(b.id);
  const prompted: string[] = [];
  const r = await deliverToPane(b.id, "w1:p2", { waitIdle: ok, promptPane: async (p, id) => { prompted.push(`${p} ${id}`); return { ok: true }; } }, any, undefined, "codex");
  expect(r).toEqual({ result: "delivered" });
  expect(prompted).toEqual([`w1:p2 ${b.id}`]);
  expect(readStatus(b.id)).toMatchObject({ state: "delivered", via: "herdr", session: "w1:p2", agent: "codex", summary: "done" });
});

test("deliverToPane writes no agent or summary when there is none", async () => {
  const b = writeBundle(sampleInput, {});
  expect(await deliverToPane(b.id, "p", { waitIdle: ok, promptPane: ok }, any)).toEqual({ result: "delivered" });
  const s = readStatus(b.id)!;
  expect(s.agent).toBeUndefined();
  expect(s.summary).toBeUndefined();
});

test("deliverToPane leaves the status untouched when the prompt fails and no failure status is given", async () => {
  const b = writeBundle(sampleInput, {});
  ack(b.id);
  const r = await deliverToPane(b.id, "p", { waitIdle: ok, promptPane: async () => ({ ok: false, error: "agent_blocked" }) }, any);
  expect(r).toEqual({ result: "prompt-failed", error: "agent_blocked" });
  expect(readStatus(b.id)).toMatchObject({ state: "acked", summary: "done" });
});

test("deliverToPane reports a failed idle wait without claiming or prompting", async () => {
  const b = writeBundle(sampleInput, {});
  const never = async (): Promise<never> => { throw new Error("should not prompt"); };
  const r = await deliverToPane(b.id, "p", { waitIdle: async () => ({ ok: false, error: "timed out" }), promptPane: never }, any);
  expect(r).toEqual({ result: "wait-failed", error: "timed out" });
  expect(readStatus(b.id)).toMatchObject({ state: "queued" });
});

test("deliverToPane does not prompt while another process holds the claim", async () => {
  const b = writeBundle(sampleInput, {});
  expect(claim(b.id, "someone-else")).not.toBeNull();
  const never = async (): Promise<never> => { throw new Error("should not prompt"); };
  expect(await deliverToPane(b.id, "p", { waitIdle: ok, promptPane: never }, any)).toEqual({ result: "unclaimed" });
});

test("deliverToPane skips a bundle whose status is not accepted and puts it back", async () => {
  const b = writeBundle(sampleInput, {});
  ack(b.id);
  const never = async (): Promise<never> => { throw new Error("should not prompt"); };
  expect(await deliverToPane(b.id, "p", { waitIdle: ok, promptPane: never }, (s) => s.state === "queued")).toEqual({ result: "unclaimed" });
  expect(readStatus(b.id)).toMatchObject({ state: "acked" });
});

const AGENTS = { result: { agents: [
  { agent: "claude", agent_status: "idle", cwd: "/home/me/repo", pane_id: "w1:p2", terminal_title_stripped: "repo" },
  { agent_status: "idle", cwd: "/home/me", pane_id: "w1:p3", terminal_title_stripped: "shell" },
] } };

type Run = { code: number; out: string; err: string; log: string };

async function deliver(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const herdr = writeHerdrShim(home);
  const shimLog = join(home, "herdr.log");
  rmSync(shimLog, { force: true });
  writeFileSync(join(home, "list.json"), JSON.stringify(AGENTS));
  const base: Record<string, string | undefined> = { ...process.env, ANYNOTATE_HOME: home, ANYNOTATE_HERDR: herdr, HERDR_SHIM_LOG: shimLog, HERDR_SHIM_LIST: join(home, "list.json"), ...env };
  delete base.HERDR_BIN_PATH;
  const proc = Bun.spawn(cliArgv("deliver", ...args), { env: base, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err, log: existsSync(shimLog) ? readFileSync(shimLog, "utf8") : "" };
}

const twoBundles = () => [
  writeBundle({ ...sampleInput, title: "Older page" }, {}, new Date("2026-09-24T10:00:00")),
  writeBundle({ ...sampleInput, title: "Newer page" }, {}, new Date("2026-09-24T11:00:00")),
];
const prompt = (id: string) => `agent prompt w1:p2 Browser notes waiting: read ${join(home, "inbox", id, "README.md")} and act on them.`;
const oneLine = (r: Run) => expect(r.err.trim().split("\n")).toHaveLength(1);

test("deliver latest types the newest bundle into the agent pane and records it", async () => {
  const [, newer] = twoBundles();
  const r = await deliver(["latest", "--pane", "w1:p2"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`delivered ${newer!.id} to pane w1:p2`);
  expect(r.log).toContain("agent list");
  expect(r.log).toContain("agent wait w1:p2 --until idle");
  expect(r.log).toContain(prompt(newer!.id));
  expect(readStatus(newer!.id)).toMatchObject({ state: "delivered", via: "herdr", session: "w1:p2" });
});

test("deliver by id re-sends a bundle that was already acknowledged", async () => {
  const [older] = twoBundles();
  ack(older!.id);
  const r = await deliver([older!.id, "--pane", "w1:p2"]);
  expect(r.code).toBe(0);
  expect(r.log).toContain(prompt(older!.id));
  expect(readStatus(older!.id)).toMatchObject({ state: "delivered", via: "herdr", session: "w1:p2", agent: "claude", summary: "done" });
});

test("deliver refuses a pane that is not a herdr agent pane", async () => {
  const [b] = twoBundles();
  for (const pane of ["w1:p3", "w9:p9"]) {
    const r = await deliver([b!.id, "--pane", pane]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`pane ${pane} is not a herdr agent pane`);
    oneLine(r);
    expect(r.log).not.toContain("agent prompt");
  }
  expect(readStatus(b!.id)).toMatchObject({ state: "queued" });
});

test("deliver reports an open approval dialog and leaves the status alone", async () => {
  const [b] = twoBundles();
  const r = await deliver([b!.id, "--pane", "w1:p2"], { HERDR_SHIM_FAIL: JSON.stringify({ "agent prompt": { code: 1, stderr: "error: agent_blocked\n" } }) });
  expect(r.code).toBe(1);
  expect(r.err).toContain("pane w1:p2 is showing an approval dialog (agent_blocked)");
  oneLine(r);
  expect(readStatus(b!.id)).toMatchObject({ state: "queued" });
  expect(readStatus(b!.id)!.note).toBeUndefined();
});

test("deliver reports a timeout waiting for the pane", async () => {
  const [b] = twoBundles();
  const r = await deliver([b!.id, "--pane", "w1:p2"], { HERDR_SHIM_FAIL: JSON.stringify({ "agent wait": { code: 1, stderr: "timeout waiting for agent\n" } }) });
  expect(r.code).toBe(1);
  expect(r.err).toContain("timed out waiting for pane w1:p2");
  oneLine(r);
  expect(r.log).not.toContain("agent prompt");
});

test("deliver --dry-run says what it would type and where, and types nothing", async () => {
  const [, newer] = twoBundles();
  const r = await deliver(["latest", "--pane", "w1:p2", "--dry-run"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`would type into pane w1:p2 (claude): Browser notes waiting: read ${join(home, "inbox", newer!.id, "README.md")} and act on them.`);
  expect(r.log.trim()).toBe("agent list");
  expect(readStatus(newer!.id)).toMatchObject({ state: "queued" });
});

test("deliver errors clearly on no bundles, unknown or invalid ids, missing herdr and bad usage", async () => {
  const none = await deliver(["latest", "--pane", "w1:p2"]);
  expect(none.code).toBe(1);
  expect(none.err).toContain("no bundles");
  oneLine(none);

  twoBundles();
  const unknown = await deliver(["2026-01-01T000000-nothing-here", "--pane", "w1:p2"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('no bundle "2026-01-01T000000-nothing-here"');
  oneLine(unknown);

  const invalid = await deliver(["../etc", "--pane", "w1:p2"]);
  expect(invalid.code).toBe(1);
  expect(invalid.err).toContain('no bundle "../etc"');

  const missing = await deliver(["latest", "--pane", "w1:p2"], { ANYNOTATE_HERDR: join(home, "no-such-herdr") });
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("herdr not found");
  oneLine(missing);

  for (const args of [["latest"], ["--pane", "w1:p2"], ["latest", "--pane"], ["latest", "--pane", "w1:p2", "--bogus"]]) {
    const r = await deliver(args);
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage: anynotate deliver <id|latest> --pane <pane-id> [--dry-run]");
  }
});
