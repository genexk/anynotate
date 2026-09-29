import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/agent/hook";
import { bunExec } from "../src/bridge/exec";
import { waitIdle } from "../src/bridge/herdr";
import { Registry } from "../src/bridge/registry";
import { route, type RouteDeps } from "../src/bridge/router";
import { readStatus, updateStatus, writeBundle } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

const never = async (): Promise<never> => { throw new Error("herdr should not be called"); };
const ok = async () => ({ ok: true as const });
const deps = (over: Partial<RouteDeps> = {}): RouteDeps => ({ registry: new Registry(), waitIdle: never, promptPane: never, ...over });
const ack = (id: string) => updateStatus(id, "test-ack", (s) => ({ ...s, state: "acked", summary: "done" }));

test("live push adapter wins", async () => {
  const registry = new Registry();
  registry.register({ id: "s-1", agent: "claude", cwd: "/tmp/repo", title: "" });
  const sent: string[] = [];
  registry.attach("s-1", (b) => sent.push(b));
  const b = writeBundle(sampleInput, {});
  const s = await route(b, deps({ registry }));
  expect(sent).toEqual([b.id]);
  expect(s).toMatchObject({ state: "delivered", via: "push", session: "s-1" });
  expect(readStatus(b.id)!.via).toBe("push");
});

test("pane target waits for idle, then prompts through herdr", async () => {
  const b = writeBundle({ ...sampleInput, target: { agent: "codex", pane: "w1:p2", cwd: "/r2" } }, {});
  const calls: string[] = [];
  const s = await route(b, deps({
    waitIdle: async (p) => { calls.push(`wait ${p}`); return { ok: true }; },
    promptPane: async (p, id) => { calls.push(`prompt ${p}:${id}`); return { ok: true }; },
  }));
  expect(calls).toEqual(["wait w1:p2", `prompt w1:p2:${b.id}`]);
  expect(s).toMatchObject({ state: "delivered", via: "herdr", session: "w1:p2" });
});

test("herdr idle-wait failure leaves it queued with a note", async () => {
  const b = writeBundle({ ...sampleInput, target: { agent: "gemini", pane: "p", cwd: "/r" } }, {});
  const s = await route(b, deps({ waitIdle: async () => ({ ok: false, error: "timeout" }) }));
  expect(s).toMatchObject({ state: "queued", note: "herdr: timeout" });
  expect(readStatus(b.id)).toMatchObject({ state: "queued", note: "herdr: timeout" });
});

test("herdr prompt failure leaves it queued with a note", async () => {
  const b = writeBundle({ ...sampleInput, target: { agent: "gemini", pane: "p", cwd: "/r" } }, {});
  const s = await route(b, deps({ waitIdle: ok, promptPane: async () => ({ ok: false, error: "no such pane" }) }));
  expect(s).toMatchObject({ state: "queued", note: "herdr: no such pane" });
  expect(readStatus(b.id)).toMatchObject({ state: "queued", note: "herdr: no such pane" });
});

test("no push adapter and no pane stays queued", async () => {
  const b = writeBundle(sampleInput, {});
  const s = await route(b, deps());
  expect(s!.state).toBe("queued");
  expect(s!.note).toBeUndefined();
});

test("a throwing push sender falls through to queued with a note", async () => {
  const registry = new Registry();
  registry.register({ id: "s-1", agent: "claude", cwd: "/tmp/repo", title: "" });
  registry.attach("s-1", () => { throw new Error("stream closed"); });
  const b = writeBundle(sampleInput, {});
  const s = await route(b, deps({ registry }));
  expect(s).toMatchObject({ state: "queued", note: "push: stream closed" });
  expect(readStatus(b.id)).toMatchObject({ state: "queued", note: "push: stream closed" });
});

test("a missing herdr binary leaves the bundle queued with a note", async () => {
  const b = writeBundle({ ...sampleInput, target: { agent: "codex", pane: "w1:p2", cwd: "/r2" } }, {});
  const s = await route(b, deps({ waitIdle: (p) => waitIdle(p, { exec: bunExec, bin: "/nonexistent/herdr", idleTimeoutMs: 1000 }) }));
  expect(s!.state).toBe("queued");
  expect(s!.note).toStartWith("herdr: ");
  expect(readStatus(b.id)!.state).toBe("queued");
});

test("the hook fired by the typed herdr prompt does not deliver the bundle a second time", async () => {
  const b = writeBundle({ ...sampleInput, target: { agent: "gemini", pane: "w2:p1", cwd: "/g" } }, {});
  const hookOut: string[] = [];
  const s = await route(b, deps({
    waitIdle: ok,
    promptPane: async () => {
      hookOut.push(runHook("gemini", JSON.stringify({ session_id: "g-1", cwd: "/g" })));
      return { ok: true };
    },
  }));
  expect(hookOut).toEqual([""]);
  expect(s).toMatchObject({ state: "delivered", via: "herdr", session: "w2:p1" });
  expect(readStatus(b.id)).toMatchObject({ state: "delivered", via: "herdr" });
});

test("a bundle the hook delivered during the idle wait is not prompted again", async () => {
  const b = writeBundle({ ...sampleInput, target: { agent: "gemini", pane: "w2:p1", cwd: "/g" } }, {});
  const s = await route(b, deps({
    waitIdle: async () => {
      expect(runHook("gemini", JSON.stringify({ session_id: "g-1", cwd: "/g" }))).toContain(b.id);
      return { ok: true };
    },
  }));
  expect(s).toMatchObject({ state: "delivered", via: "hook", session: "g-1" });
  expect(readStatus(b.id)).toMatchObject({ state: "delivered", via: "hook" });
});

test("an ack during the idle wait survives a herdr failure", async () => {
  const b = writeBundle({ ...sampleInput, target: { agent: "gemini", pane: "p", cwd: "/r" } }, {});
  const s = await route(b, deps({
    waitIdle: async () => {
      expect(ack(b.id)).toBe(true);
      return { ok: false, error: "timeout" };
    },
  }));
  expect(s).toMatchObject({ state: "acked", summary: "done" });
  expect(readStatus(b.id)).toMatchObject({ state: "acked", summary: "done" });
  expect(readStatus(b.id)!.note).toBeUndefined();
});

test("an ack during the idle wait is not followed by a prompt", async () => {
  const b = writeBundle({ ...sampleInput, target: { agent: "gemini", pane: "p", cwd: "/r" } }, {});
  const s = await route(b, deps({ waitIdle: async () => { ack(b.id); return { ok: true }; } }));
  expect(s).toMatchObject({ state: "acked" });
});

test("push onto a bundle that is no longer queued does not send", async () => {
  const registry = new Registry();
  registry.register({ id: "s-1", agent: "claude", cwd: "/tmp/repo", title: "" });
  const sent: string[] = [];
  registry.attach("s-1", (id) => sent.push(id));
  const b = writeBundle(sampleInput, {});
  ack(b.id);
  const s = await route(b, deps({ registry }));
  expect(sent).toEqual([]);
  expect(s).toMatchObject({ state: "acked" });
});
