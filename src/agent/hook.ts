import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { touchSeen } from "../inbox/seen";
import { bundleDir, claim, queuedFor, release, restoreClaim } from "../inbox/store";
import type { Agent } from "@anynotate/protocol";

const EVENT = new Map<Agent, string>([["gemini", "BeforeAgent"]]);
const eventFor = (agent: Agent) => EVENT.get(agent) ?? "UserPromptSubmit";

// Claims one bundle and marks it delivered via the hook, returning the text to inject.
// queuedFor's snapshot is unlocked, so the state is re-checked under the claim: a bundle the
// router or an ack moved on in the meantime is released unchanged and skipped (null).
export function deliverBundle(id: string, owner: string, session: string | undefined): string | null {
  // Read before claiming: a bundle whose README can't be read stays queued.
  const readme = readFileSync(join(bundleDir(id), "README.md"), "utf8");
  const cur = claim(id, owner);
  if (!cur) return null;
  try {
    if (cur.state !== "queued") {
      release(id, owner, cur);
      return null;
    }
    release(id, owner, { state: "delivered", via: "hook", session, at: new Date().toISOString() });
  } catch (err) {
    restoreClaim(id, owner);
    throw err;
  }
  return `${readme}\nBundle folder: ${bundleDir(id)}`;
}

// Never talks to the bridge, and any error yields "" so the agent's prompt is never blocked.
export function runHook(agent: Agent, stdin: string): string {
  try {
    const input = JSON.parse(stdin) as { session_id?: string; cwd?: string };
    const cwd = input.cwd ?? process.cwd();
    if (input.session_id) touchSeen(agent, input.session_id, cwd, new Date(), process.env.HERDR_PANE_ID || undefined);

    // Unique per call so two hooks in one process never share a claim file.
    const owner = `hook-${process.pid}-${randomUUID()}`;
    const blocks: string[] = [];
    for (const b of queuedFor(agent, input.session_id, cwd)) {
      // One bad bundle must not drop the ones already delivered in this call.
      try {
        const block = deliverBundle(b.id, owner, input.session_id);
        if (block) blocks.push(block);
      } catch {
        continue;
      }
    }
    if (!blocks.length) return "";

    const additionalContext = [
      `The user sent ${blocks.length} browser annotation bundle(s) to this session with Anynotate. Read the files in each bundle folder as needed.`,
      ...blocks,
    ].join("\n\n---\n\n");
    return JSON.stringify({ hookSpecificOutput: { hookEventName: eventFor(agent), additionalContext } });
  } catch {
    return "";
  }
}
