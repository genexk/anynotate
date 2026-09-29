import type { Agent, Session } from "@anynotate/protocol";

type Entry = { id: string; agent: Agent; cwd: string; title: string; lastSeen: number; send?: (bundleId: string) => void };

export class Registry {
  private entries = new Map<string, Entry>();

  constructor(private ttlMs = 30_000, private now: () => number = () => Date.now()) {}

  register(e: { id: string; agent: Agent; cwd: string; title: string }): void {
    const prev = this.entries.get(e.id);
    this.entries.set(e.id, { ...e, lastSeen: this.now(), send: prev?.send });
  }

  heartbeat(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.lastSeen = this.now();
    return true;
  }

  attach(id: string, send: (bundleId: string) => void): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.send = send;
    return true;
  }

  // With `send`, only clear it if it is still the current sender, so a late
  // disconnect of a replaced stream cannot detach its successor.
  detach(id: string, send?: (bundleId: string) => void): void {
    const e = this.entries.get(id);
    if (e && (send === undefined || e.send === send)) e.send = undefined;
  }

  private isLive(e: Entry): boolean {
    return this.now() - e.lastSeen <= this.ttlMs;
  }

  live(): Session[] {
    return [...this.entries.values()]
      .filter((e) => this.isLive(e))
      .map(({ id, agent, cwd, title }) => ({ id, agent, cwd, title, method: "push" as const }));
  }

  sender(id: string): ((bundleId: string) => void) | undefined {
    const e = this.entries.get(id);
    return e && this.isLive(e) ? e.send : undefined;
  }
}
