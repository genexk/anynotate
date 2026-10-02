import { randomUUID } from "node:crypto";
import { claim, readStatus, release, restoreClaim } from "../inbox/store";
import type { Bundle, Status } from "@anynotate/protocol";
import type { PaneResult } from "./herdr";
import type { Registry } from "./registry";

export type PaneDeps = {
  waitIdle: (pane: string) => Promise<PaneResult>;
  promptPane: (pane: string, bundleId: string) => Promise<PaneResult>;
};

export type RouteDeps = PaneDeps & { registry: Registry };

export type PaneOutcome =
  | { result: "delivered" }
  | { result: "wait-failed" | "prompt-failed"; error: string }
  | { result: "unclaimed" };

// A unique owner per call keeps concurrent claims from sharing claim/temp file names.
const newOwner = () => `router-${process.pid}-${randomUUID()}`;

type Held = { owner: string; status: Status };

// Claims the bundle only while it is still queued. A bundle the hook, a pull or an ack has moved
// on is put back untouched. null means "not ours to deliver": busy or no longer queued.
function claimIf(id: string, accept: (s: Status) => boolean): Held | null {
  const owner = newOwner();
  const status = claim(id, owner);
  if (!status) return null;
  if (accept(status)) return { owner, status };
  restoreClaim(id, owner);
  return null;
}

const claimQueued = (id: string) => claimIf(id, (s) => s.state === "queued");

function finish(id: string, held: Held, next: Omit<Status, "at">): void {
  try {
    release(id, held.owner, { ...next, at: new Date().toISOString() });
  } catch (err) {
    restoreClaim(id, held.owner);
    throw err;
  }
}

// Writes only over a still-queued status, and reports what is actually on disk.
function record(id: string, next: Omit<Status, "at">): Status | null {
  const held = claimQueued(id);
  if (held) finish(id, held, next);
  return readStatus(id);
}

const isQueued = (id: string) => readStatus(id)?.state === "queued";

// The typed prompt fires that pane's own prompt hook. Holding the claim across the prompt makes
// that hook see the bundle as taken and skip it, so it is delivered exactly once.
// Without onPromptError a failed prompt puts the claimed status back unchanged. A re-send keeps the summary of an
// earlier ack, and records the pane's agent when it is known, since it can differ from the bundle's target.
export async function deliverToPane(
  id: string,
  pane: string,
  deps: PaneDeps,
  accept: (s: Status) => boolean,
  onPromptError?: (error: string) => Omit<Status, "at">,
  agent?: string,
): Promise<PaneOutcome> {
  const waited = await deps.waitIdle(pane);
  if (!waited.ok) return { result: "wait-failed", error: waited.error };
  const held = claimIf(id, accept);
  if (!held) return { result: "unclaimed" };
  let r: PaneResult;
  try {
    r = await deps.promptPane(pane, id);
  } catch (err) {
    restoreClaim(id, held.owner);
    throw err;
  }
  if (r.ok) {
    const { summary } = held.status;
    finish(id, held, { state: "delivered", via: "herdr", session: pane, ...(agent ? { agent } : {}), ...(summary ? { summary } : {}) });
    return { result: "delivered" };
  }
  if (onPromptError) finish(id, held, onPromptError(r.error));
  else restoreClaim(id, held.owner);
  return { result: "prompt-failed", error: r.error };
}

export async function route(bundle: Bundle, deps: RouteDeps): Promise<Status | null> {
  const { id, target } = bundle;
  const notes: string[] = [];

  if (target.sessionId) {
    const send = deps.registry.sender(target.sessionId);
    if (send) {
      const held = claimQueued(id);
      if (held) {
        let sent = true;
        try {
          send(id);
        } catch (e) {
          sent = false;
          notes.push(`push: ${(e as Error).message}`);
        }
        if (sent) {
          finish(id, held, { state: "delivered", via: "push", session: target.sessionId });
          return readStatus(id);
        }
        restoreClaim(id, held.owner);
      } else if (!isQueued(id)) {
        return readStatus(id);
      }
    }
  }

  if (target.pane) {
    const r = await deliverToPane(id, target.pane, deps, (s) => s.state === "queued", (error) => ({
      state: "queued",
      note: [...notes, `herdr: ${error}`].join("; "),
    }));
    if (r.result === "wait-failed") notes.push(`herdr: ${r.error}`);
    else if (r.result !== "unclaimed" || !isQueued(id)) return readStatus(id);
  }

  return record(id, { state: "queued", ...(notes.length ? { note: notes.join("; ") } : {}) });
}
