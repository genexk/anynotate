import { chmodSync, existsSync, lstatSync, statSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUNDLE_ID, Status } from "@anynotate/protocol";
import { anynotateHome, archiveDir, ensureHome, inboxDir } from "./paths";
import { repointLatestIfGone, STALE_CLAIM_MS } from "./store";

export const DEFAULT_RETENTION_DAYS = 30;
export const RETENTION_SWEEP_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const settingsPath = () => join(anynotateHome(), "settings.json");

export type RetentionSource = "env" | "settings.json" | "default";
// days === null means retention is off.
export type Retention = { days: number | null; source: RetentionSource; warning?: string };

export function parseRetention(value: unknown): number | null | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value || null : undefined;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "off") return null;
  if (!/^\d+$/.test(v)) return undefined;
  return Number(v) || null;
}

function readSettings(path = settingsPath()): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

export function resolveRetention(env: Record<string, string | undefined> = process.env): Retention {
  const fallback = (warning: string): Retention => ({ days: DEFAULT_RETENTION_DAYS, source: "default", warning });
  const raw = env.ANYNOTATE_RETENTION_DAYS;
  if (raw !== undefined && raw.trim() !== "") {
    const days = parseRetention(raw);
    if (days === undefined) return fallback(`ignoring invalid ANYNOTATE_RETENTION_DAYS=${JSON.stringify(raw)}`);
    return { days, source: "env" };
  }
  let settings: Record<string, unknown>;
  try {
    settings = readSettings();
  } catch (err) {
    return fallback(`ignoring unreadable ${settingsPath()}: ${(err as Error).message}`);
  }
  if (settings.retentionDays !== undefined) {
    const days = parseRetention(settings.retentionDays);
    if (days === undefined) return fallback(`ignoring invalid retentionDays ${JSON.stringify(settings.retentionDays)} in ${settingsPath()}`);
    return { days, source: "settings.json" };
  }
  return { days: DEFAULT_RETENTION_DAYS, source: "default" };
}

export const describeRetention = (r: Retention) =>
  `${r.days === null ? "off" : `${r.days} day${r.days === 1 ? "" : "s"}`} (${r.source})`;

// Keeps every other key; written to a temp file and renamed, mode 600 like the token.
export function writeRetentionSetting(value: string): number | null {
  const days = parseRetention(value);
  if (days === undefined) throw new Error(`expected a whole number of days or "off", got ${value}`);
  const path = settingsPath();
  const settings = readSettings(path);
  settings.retentionDays = days ?? "off";
  ensureHome();
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return days;
}

// The id's timestamp is local time (see newBundleId).
function createdAt(id: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function readStatusAt(dir: string): Status | null {
  try {
    return Status.parse(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")));
  } catch {
    return null;
  }
}

// Delivered or acked bundles age from that moment; anything else from when it was created.
function ageStart(id: string, dir: string): number {
  const status = readStatusAt(dir);
  if (status && status.state !== "queued") {
    const at = Date.parse(status.at);
    if (!Number.isNaN(at)) return at;
  }
  return createdAt(id);
}

// A claim older than STALE_CLAIM_MS belongs to a dead process, so it does not protect the bundle.
function hasActiveClaim(dir: string, now: number): boolean {
  return readdirSync(dir).some((n) => {
    if (!n.startsWith("status.json.claim-")) return false;
    try {
      return now - statSync(join(dir, n)).mtimeMs <= STALE_CLAIM_MS;
    } catch {
      return false;
    }
  });
}

function expiredIn(root: string, cutoff: number, now: number): { id: string; path: string }[] {
  if (!existsSync(root)) return [];
  const realRoot = realpathSync(root);
  const out: { id: string; path: string }[] = [];
  for (const id of readdirSync(root).sort()) {
    if (!BUNDLE_ID.test(id)) continue;
    const path = join(realRoot, id);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (dirname(realpathSync(path)) !== realRoot) continue;
      if (hasActiveClaim(path, now)) continue;
      if (!(ageStart(id, path) < cutoff)) continue;
      out.push({ id, path });
    } catch {}
  }
  return out;
}

export type PruneResult = { days: number | null; pruned: string[]; dryRun: boolean };

// Removes expired bundles from the inbox and the archive (the archive holds bundles moved out of the inbox).
export function pruneBundles(days: number | null, opts: { now?: Date; dryRun?: boolean } = {}): PruneResult {
  const dryRun = opts.dryRun ?? false;
  if (days === null) return { days, pruned: [], dryRun };
  const now = (opts.now ?? new Date()).getTime();
  const cutoff = now - days * DAY_MS;
  const pruned: string[] = [];
  const fromInbox: string[] = [];
  for (const root of [inboxDir(), archiveDir()]) {
    for (const { id, path } of expiredIn(root, cutoff, now)) {
      if (!dryRun) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch (err) {
          console.error(`anynotate: could not prune ${id}:`, err);
          continue;
        }
      }
      pruned.push(id);
      if (root === inboxDir()) fromInbox.push(id);
    }
  }
  if (!dryRun) repointLatestIfGone(fromInbox);
  return { days, pruned, dryRun };
}

export function sweepRetention(log: { info: (s: string) => void; warn: (s: string) => void } = { info: console.log, warn: console.error }, now?: Date): PruneResult {
  const r = resolveRetention();
  if (r.warning) log.warn(`anynotate: ${r.warning}; using ${DEFAULT_RETENTION_DAYS} days`);
  const result = pruneBundles(r.days, { now });
  if (result.pruned.length) log.info(`pruned ${result.pruned.length} bundle(s) older than ${r.days} days`);
  return result;
}

export function startRetentionSweeps(log?: Parameters<typeof sweepRetention>[0], intervalMs = RETENTION_SWEEP_MS): () => void {
  const run = () => {
    try {
      sweepRetention(log);
    } catch (err) {
      console.error("anynotate: retention sweep failed:", err);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
