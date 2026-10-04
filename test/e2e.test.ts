import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleInput } from "./fixtures/sample";
import { cliArgv, writeHerdrShim } from "./fixtures/spawn";

let home: string, bridge: ReturnType<typeof Bun.spawn> | undefined, base: string, token: string, shimLog: string, promptHookOut: string;

// Resolves with the port from the bridge's "listening" line, or null if it exits or stays silent first.
async function waitForListening(proc: ReturnType<typeof Bun.spawn>): Promise<number | null> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!chunk || chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
    const port = /anynotate bridge on http:\/\/127\.0\.0\.1:(\d+)/.exec(seen)?.[1];
    if (port) {
      reader.releaseLock();
      return Number(port);
    }
  }
  return null;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "anynotate-e2e-"));
  shimLog = join(home, "herdr.log");
  promptHookOut = join(home, "prompt-hook.out");
  const onPrompt = JSON.stringify({ argv: cliArgv("hook", "--agent", "gemini"), stdin: JSON.stringify({ session_id: "g-e2e", cwd: "/g" }) });
  const herdr = writeHerdrShim(home);
  const list = join(home, "list.json");
  writeFileSync(list, JSON.stringify({ result: { agents: [{ agent: "gemini", agent_status: "idle", cwd: "/g", pane_id: "w2:p1", workspace_id: "w2", terminal_title_stripped: "gem" }] } }));
  const workspaces = join(home, "workspaces.json");
  writeFileSync(workspaces, JSON.stringify({ result: { workspaces: [{ workspace_id: "w2", label: "garden", number: 1 }] } }));

  // Port 0 lets the OS pick a free port, so no fixed range can collide with a reserved one (Windows reserves some).
  const env = { ...process.env, ANYNOTATE_HOME: home, ANYNOTATE_PORT: "0", ANYNOTATE_HERDR: herdr, HERDR_SHIM_LOG: shimLog, HERDR_SHIM_LIST: list, HERDR_SHIM_WORKSPACES: workspaces, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), HERDR_SHIM_ON_PROMPT: onPrompt, HERDR_SHIM_ON_PROMPT_OUT: promptHookOut };
  const proc = Bun.spawn(cliArgv("bridge"), { env, stdout: "pipe", stderr: "inherit" });
  const port = await waitForListening(proc);
  if (port) {
    bridge = proc;
    base = `http://127.0.0.1:${port}`;
  } else {
    proc.kill();
    await proc.exited;
  }
  if (!bridge) throw new Error("anynotate bridge did not start");
  expect((await fetch(`${base}/health`)).ok).toBe(true);
  token = readFileSync(join(home, "token"), "utf8").trim();
});

afterAll(async () => {
  bridge?.kill();
  await bridge?.exited;
  rmSync(home, { recursive: true, force: true });
});

const auth = () => ({ "X-Anynotate-Token": token });

const send = (target: object): Promise<{ id: string; status: { state: string; via?: string } }> => {
  const f = new FormData();
  f.set("bundle", JSON.stringify({ ...sampleInput, target }));
  f.set("page.md", new Blob(["# p ⟦A1⟧x⟦/A1⟧"]), "page.md");
  return fetch(`${base}/bundles`, { method: "POST", headers: auth(), body: f }).then((r) => r.json());
};

const getStatus = async (id: string) => (await (await fetch(`${base}/bundles/${id}`, { headers: auth() })).json()).status;

test("sessions lists the herdr pane with its workspace name", async () => {
  const s = await (await fetch(`${base}/sessions`, { headers: auth() })).json();
  expect(s).toContainEqual(expect.objectContaining({ method: "herdr", agent: "gemini", pane: "w2:p1", workspace: "garden" }));
});

test("pane target is typed into herdr with the path-only prompt", async () => {
  const { id } = await send({ agent: "gemini", pane: "w2:p1", cwd: "/g" });
  // POST answers within ROUTE_WAIT_MS and routing may still be running, so poll the stored status.
  let status = await getStatus(id);
  for (let i = 0; i < 200 && status?.via !== "herdr"; i++) {
    await Bun.sleep(50);
    status = await getStatus(id);
  }
  expect(status).toMatchObject({ state: "delivered", via: "herdr", session: "w2:p1" });
  const log = readFileSync(shimLog, "utf8");
  expect(log).toContain("agent wait w2:p1 --until idle");
  expect(log).toContain(`agent prompt w2:p1 Browser notes waiting: read ${join(home, "inbox", id, "README.md")} and act on them.`);
});

test("the pane's own hook, fired by the typed prompt, injects nothing", async () => {
  rmSync(promptHookOut, { force: true });
  const { id } = await send({ agent: "gemini", pane: "w2:p1", cwd: "/g" });
  let status = await getStatus(id);
  for (let i = 0; i < 200 && status?.via !== "herdr"; i++) {
    await Bun.sleep(50);
    status = await getStatus(id);
  }
  expect(readFileSync(promptHookOut, "utf8")).toBe("[]\n");
  expect(status).toMatchObject({ state: "delivered", via: "herdr", session: "w2:p1" });
});

test("queued bundle is delivered by the real hook process on the next prompt", async () => {
  const { id, status } = await send({ agent: "claude", cwd: "/work/repo" });
  expect(status.state).toBe("queued");
  const hook = Bun.spawn(cliArgv("hook", "--agent", "claude"), {
    env: { ...process.env, ANYNOTATE_HOME: home }, stdin: new Blob([JSON.stringify({ session_id: "live-1", cwd: "/work/repo" })]), stdout: "pipe",
  });
  const out = JSON.parse(await new Response(hook.stdout).text());
  expect(await hook.exited).toBe(0);
  expect(out.hookSpecificOutput.additionalContext).toContain(id);
  expect(await getStatus(id)).toMatchObject({ state: "delivered", via: "hook", session: "live-1" });
});
