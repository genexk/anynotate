import { randomUUID } from "node:crypto";
import { claim, readStatus, release, restoreClaim } from "../inbox/store";
import type { Bundle, Status } from "@anynotate/protocol";
import type { PaneResult } from "./herdr";
import type { Registry } from "./registry";

export type RouteDeps = {
  registry: Registry;
  waitIdle: (pane: string) => Promise<PaneResult>;
  promptPane: (pane: string, bundleId: string) => Promise<PaneResult>;
};

// A unique owner per call keeps concurrent claims from sharing claim/temp file names.
const newOwner = () => `router-${process.pid}-${randomUUID()}`;

type Held = { owner: string; status: Status };

// Claims the bundle only while it is still queued. A bundle the hook, a pull or an ack has moved
// on is put back untouched. null means "not ours to deliver": busy or no longer queued.
function claimQueued(id: string): Held | null {
  const owner = newOwner();
  const status = claim(id, owner);
  if (!status) return null;
  if (status.state === "queued") return { owner, status };
  restoreClaim(id, owner);
  return null;
}

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
    const waited = await deps.waitIdle(target.pane);
    if (!waited.ok) {
      notes.push(`herdr: ${waited.error}`);
    } else {
      // The typed prompt fires that pane's own prompt hook. Holding the claim across the prompt
      // makes that hook see the bundle as taken and skip it, so it is delivered exactly once.
      const held = claimQueued(id);
      if (held) {
        let r: PaneResult;
        try {
          r = await deps.promptPane(target.pane, id);
        } catch (err) {
          restoreClaim(id, held.owner);
          throw err;
        }
        if (r.ok) {
          finish(id, held, { state: "delivered", via: "herdr", session: target.pane });
        } else {
          notes.push(`herdr: ${r.error}`);
          finish(id, held, { state: "queued", note: notes.join("; ") });
        }
        return readStatus(id);
      }
      if (!isQueued(id)) return readStatus(id);
    }
  }

  return record(id, { state: "queued", ...(notes.length ? { note: notes.join("; ") } : {}) });
}
