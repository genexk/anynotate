import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NAME, type Agent } from "@anynotate/protocol";
import { inboxDir } from "../inbox/paths";
import { bunExec, type Exec } from "./exec";

export type Pane = { pane: string; agent: Agent; cwd: string; title: string; status: string; workspace?: string; workspaceId?: string };

const NOT_AN_AGENT = new Set(["unknown", "none"]);
const isAgentName = (v: unknown): v is Agent => typeof v === "string" && AGENT_NAME.test(v) && !NOT_AN_AGENT.has(v);

// herdr hands its plugins HERDR_BIN_PATH, but a bridge started from a plugin keeps it after herdr is upgraded and
// that path is gone, so it is used only while the file exists.
export const herdrBin = (env: Record<string, string | undefined> = process.env, exists: (path: string) => boolean = existsSync) =>
  env.ANYNOTATE_HERDR || (env.HERDR_BIN_PATH && exists(env.HERDR_BIN_PATH) ? env.HERDR_BIN_PATH : "herdr");
const defaultBin = () => herdrBin();

export type PaneList = { panes: Pane[] } | { error: string; missing?: true };

export async function readPanes(exec: Exec = bunExec, bin = defaultBin()): Promise<PaneList> {
  const r = await exec([bin, "agent", "list"], 5000);
  if (r.code === 127 && !r.stdout) return { error: `herdr not found: ${bin}`, missing: true };
  if (r.code !== 0) return { error: (r.stderr || r.stdout).trim() || `herdr agent list failed (exit ${r.code})` };
  let agents: Record<string, string>[];
  try {
    agents = (JSON.parse(r.stdout).result?.agents ?? []) as Record<string, string>[];
  } catch {
    return { error: "herdr agent list printed something that is not JSON" };
  }
  return {
    panes: agents
      .filter((a) => isAgentName(a.agent))
      .map((a) => ({
        pane: a.pane_id ?? "",
        agent: a.agent!,
        cwd: a.cwd ?? "",
        title: a.terminal_title_stripped ?? "",
        status: a.agent_status ?? "unknown",
        ...(a.workspace_id ? { workspaceId: a.workspace_id } : {}),
      })),
  };
}

const WORKSPACE_NAME_MAX = 60;
const displayName = (v: unknown) =>
  typeof v === "string" ? Array.from(v.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim()).slice(0, WORKSPACE_NAME_MAX).join("") : "";

export const WORKSPACE_LIST_TIMEOUT_MS = 1500;
export const WORKSPACE_CACHE_MS = 10_000;
const workspaceLabel = (v: unknown) => displayName(typeof v === "string" ? v.replace(/^\s*\[\d+\]\s*/, "") : v);

export async function readWorkspaceNames(exec: Exec = bunExec, bin = defaultBin()): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const r = await exec([bin, "workspace", "list"], WORKSPACE_LIST_TIMEOUT_MS);
  if (r.code !== 0) return names;
  try {
    for (const w of (JSON.parse(r.stdout).result?.workspaces ?? []) as Record<string, unknown>[]) {
      const name = workspaceLabel(w.label);
      if (typeof w.workspace_id === "string" && name) names.set(w.workspace_id, name);
    }
  } catch {
    return names;
  }
  return names;
}

export type WorkspaceCache = { now: () => number; entry?: { bin: string; at: number; names: Promise<Map<string, string>> } };
export const newWorkspaceCache = (now: () => number = Date.now): WorkspaceCache => ({ now });
const sharedWorkspaceCache = newWorkspaceCache();

function cachedWorkspaceNames(exec: Exec, bin: string, cache: WorkspaceCache): Promise<Map<string, string>> {
  const at = cache.now();
  const e = cache.entry;
  if (e && e.bin === bin && at - e.at < WORKSPACE_CACHE_MS) return e.names;
  const names = readWorkspaceNames(exec, bin).catch(() => new Map<string, string>());
  cache.entry = { bin, at, names };
  return names;
}

export async function listPanes(exec: Exec = bunExec, bin = defaultBin(), cache: WorkspaceCache = sharedWorkspaceCache): Promise<Pane[]> {
  const [r, names] = await Promise.all([readPanes(exec, bin), cachedWorkspaceNames(exec, bin, cache)]);
  if (!("panes" in r)) return [];
  return r.panes.map(({ workspaceId, ...p }) => {
    const workspace = workspaceId ? names.get(workspaceId) : undefined;
    return workspace ? { ...p, workspace } : p;
  });
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
