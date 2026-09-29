import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Agent, Agent as AgentSchema } from "@anynotate/protocol";
import { ensureHome, ensurePrivateDir, sessionsDir } from "./paths";

type Seen = { agent: Agent; sessionId: string; cwd: string; lastSeen: string; pane?: string };

const fileFor = (agent: Agent, sessionId: string) =>
  join(sessionsDir(), `${agent}-${Buffer.from(sessionId).toString("base64url")}.json`);

export function touchSeen(agent: Agent, sessionId: string, cwd: string, now = new Date(), pane?: string): void {
  ensureHome();
  ensurePrivateDir(sessionsDir());
  const path = fileFor(agent, sessionId);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ agent, sessionId, cwd, lastSeen: now.toISOString(), ...(pane ? { pane } : {}) } satisfies Seen));
  renameSync(tmp, path);
}

export function listSeen(maxAgeMs = 12 * 3600_000, now = new Date()): Seen[] {
  if (!existsSync(sessionsDir())) return [];
  const out: Seen[] = [];
  for (const name of readdirSync(sessionsDir())) {
    if (!name.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(sessionsDir(), name), "utf8")) as Seen;
      AgentSchema.parse(s.agent);
      if (now.getTime() - Date.parse(s.lastSeen) <= maxAgeMs) out.push(s);
    } catch {
      // Ignore unreadable entries.
    }
  }
  return out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}
