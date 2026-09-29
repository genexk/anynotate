import { join } from "node:path";
import { AGENT_NAME, type Agent } from "@anynotate/protocol";
import { inboxDir } from "../inbox/paths";
import { bunExec, type Exec } from "./exec";

export type Pane = { pane: string; agent: Agent; cwd: string; title: string; status: string };

const NOT_AN_AGENT = new Set(["unknown", "none"]);
const isAgentName = (v: unknown): v is Agent => typeof v === "string" && AGENT_NAME.test(v) && !NOT_AN_AGENT.has(v);

const defaultBin = () => process.env.ANYNOTATE_HERDR ?? "herdr";

export async function listPanes(exec: Exec = bunExec, bin = defaultBin()): Promise<Pane[]> {
  const r = await exec([bin, "agent", "list"], 5000);
  if (r.code !== 0) return [];
  try {
    const agents = (JSON.parse(r.stdout).result?.agents ?? []) as Record<string, string>[];
    return agents
      .filter((a) => isAgentName(a.agent))
      .map((a) => ({
        pane: a.pane_id ?? "",
        agent: a.agent!,
        cwd: a.cwd ?? "",
        title: a.terminal_title_stripped ?? "",
        status: a.agent_status ?? "unknown",
      }));
  } catch {
    return [];
  }
}

export const herdrPromptText = (bundleId: string) =>
  `Browser notes waiting: read ${join(inboxDir(), bundleId, "README.md")} and act on them.`;

export type PaneResult = { ok: true } | { ok: false; error: string };
type HerdrOpts = { exec?: Exec; bin?: string };

const fail = (r: { stdout: string; stderr: string }): PaneResult => ({ ok: false, error: (r.stderr || r.stdout).trim() || "herdr failed" });

// Typing into a busy pane would mix with the running turn, so the router waits for idle first.
export async function waitIdle(pane: string, opts: HerdrOpts & { idleTimeoutMs?: number } = {}): Promise<PaneResult> {
  const exec = opts.exec ?? bunExec;
  const bin = opts.bin ?? defaultBin();
  const idle = opts.idleTimeoutMs ?? 600_000;
  const r = await exec([bin, "agent", "wait", pane, "--until", "idle", "--until", "done", "--timeout", String(idle)], idle + 5000);
  return r.code === 0 ? { ok: true } : fail(r);
}

// Bounded well below STALE_CLAIM_MS: the router holds the bundle's claim for the whole call.
export const PROMPT_TIMEOUT_MS = 15_000;

export async function promptPane(pane: string, bundleId: string, opts: HerdrOpts = {}): Promise<PaneResult> {
  const exec = opts.exec ?? bunExec;
  const bin = opts.bin ?? defaultBin();
  const r = await exec(
    [bin, "agent", "prompt", pane, herdrPromptText(bundleId), "--wait", "--until", "working", "--until", "idle", "--timeout", "10000"],
    PROMPT_TIMEOUT_MS,
  );
  return r.code === 0 ? { ok: true } : fail(r);
}
