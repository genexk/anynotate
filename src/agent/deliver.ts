import { existsSync } from "node:fs";
import { join } from "node:path";
import { bunExec, type Exec } from "../bridge/exec";
import { herdrBin, herdrPromptText, promptPane, readPanes, waitIdle } from "../bridge/herdr";
import { deliverToPane } from "../bridge/router";
import { BUNDLE_ID, bundleDir, latestBundleId } from "../inbox/store";
import { inboxDir } from "../inbox/paths";

export const DELIVER_USAGE = "usage: anynotate deliver <id|latest> --pane <pane-id> [--dry-run]";

// Shorter than the bridge's idle wait: someone is watching the command, not a background router.
export const DELIVER_IDLE_TIMEOUT_MS = 120_000;

export type DeliverOptions = {
  exec?: Exec;
  bin?: string;
  idleTimeoutMs?: number;
  log: (line: string) => void;
  err: (line: string) => void;
};

type Parsed = { ref: string; pane: string; dryRun: boolean };

function parse(args: string[]): Parsed | null {
  let ref: string | undefined;
  let pane: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--pane") {
      pane = args[++i];
      if (!pane) return null;
    } else if (a.startsWith("-") || ref !== undefined) return null;
    else ref = a;
  }
  return ref && pane ? { ref, pane, dryRun } : null;
}

export type BundleRef = { id: string } | { error: string };

// "latest" or a bundle id, checked against the bundle-id rule before it touches the filesystem.
export function resolveBundleRef(ref: string): BundleRef {
  if (ref === "latest") {
    const id = latestBundleId();
    return id ? { id } : { error: `no bundles in ${inboxDir()}` };
  }
  if (!BUNDLE_ID.test(ref) || !existsSync(join(bundleDir(ref), "annotations.json"))) {
    return { error: `no bundle "${ref}" — run \`anynotate annotations\` to list` };
  }
  return { id: ref };
}

const firstLine = (text: string) => text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? text.trim();

export function describeHerdrError(pane: string, error: string, phase: "wait" | "prompt"): string {
  if (/agent_blocked/.test(error)) return `pane ${pane} is showing an approval dialog (agent_blocked) — answer it, then retry`;
  if (/time(d)?[ _-]?out/i.test(error)) {
    return phase === "wait" ? `timed out waiting for pane ${pane} to go idle` : `timed out typing into pane ${pane}`;
  }
  return `herdr: ${firstLine(error)}`;
}

export async function runDeliver(args: string[], o: DeliverOptions): Promise<number> {
  const parsed = parse(args);
  if (!parsed) {
    o.err(DELIVER_USAGE);
    return 1;
  }
  const { pane, dryRun } = parsed;
  const fail = (line: string) => {
    o.err(`anynotate: ${line}`);
    return 1;
  };

  const ref = resolveBundleRef(parsed.ref);
  if ("error" in ref) return fail(ref.error);
  const { id } = ref;

  const exec = o.exec ?? bunExec;
  const bin = o.bin ?? herdrBin();
  const list = await readPanes(exec, bin);
  if ("error" in list) {
    return fail(list.missing ? `herdr not found (${bin}) — install herdr or set ANYNOTATE_HERDR` : `herdr agent list failed: ${firstLine(list.error)}`);
  }
  const target = list.panes.find((p) => p.pane === pane);
  if (!target) {
    const known = list.panes.map((p) => p.pane).join(", ");
    return fail(`pane ${pane} is not a herdr agent pane (agent panes: ${known || "none"})`);
  }

  if (dryRun) {
    o.log(`would type into pane ${pane} (${target.agent}): ${herdrPromptText(id)}`);
    return 0;
  }

  const r = await deliverToPane(
    id,
    pane,
    {
      waitIdle: (p) => waitIdle(p, { exec, bin, idleTimeoutMs: o.idleTimeoutMs ?? DELIVER_IDLE_TIMEOUT_MS }),
      promptPane: (p, bundleId) => promptPane(p, bundleId, { exec, bin }),
    },
    () => true,
    undefined,
    target.agent,
  );
  switch (r.result) {
    case "delivered":
      o.log(`delivered ${id} to pane ${pane} (${target.agent})`);
      return 0;
    case "unclaimed":
      return fail(`${id} is being updated by another process — retry in a moment`);
    case "wait-failed":
      return fail(describeHerdrError(pane, r.error, "wait"));
    case "prompt-failed":
      return fail(describeHerdrError(pane, r.error, "prompt"));
  }
}
