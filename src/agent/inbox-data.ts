import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { Bundle, BUNDLE_ID, Status } from "@anynotate/protocol";
import { archiveDir, inboxDir } from "../inbox/paths";
import { bundleFolderIn, hasActiveClaim } from "../inbox/retention";
import { listBundles, repointLatestIfGone } from "../inbox/store";
import type { InboxRow } from "./inbox-view";

export function targetLabel(bundle: Bundle, status: Status | null): string {
  const t = bundle.target;
  const herdr = status?.via === "herdr" && status.session ? status : null;
  const agent = herdr?.agent ?? t.agent;
  const where = herdr?.session || t.pane || t.sessionId?.slice(0, 8) || (t.cwd ? basename(t.cwd) : "");
  return where ? `${agent} · ${where}` : agent;
}

export function rowFor(bundle: Bundle, status: Status | null, archived = false): InboxRow {
  return {
    id: bundle.id,
    title: bundle.title,
    target: targetLabel(bundle, status),
    state: status?.state ?? "busy",
    notes: bundle.annotations.length,
    sentAt: bundle.sentAt,
    archived,
  };
}

function readJson<T>(path: string, parse: (v: unknown) => T): T | null {
  try {
    return parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function archivedRows(): InboxRow[] {
  const root = archiveDir();
  if (!existsSync(root)) return [];
  const out: InboxRow[] = [];
  for (const id of readdirSync(root).filter((n) => BUNDLE_ID.test(n))) {
    const dir = bundleFolderIn(root, id);
    if (!dir) continue;
    const bundle = readJson(join(dir, "annotations.json"), (v) => Bundle.parse(v));
    if (bundle) out.push(rowFor(bundle, readJson(join(dir, "status.json"), (v) => Status.parse(v)), true));
  }
  return out;
}

export function loadRows(withArchive: boolean): InboxRow[] {
  const rows = listBundles().map(({ bundle, status }) => rowFor(bundle, status));
  if (!withArchive) return rows;
  return [...rows, ...archivedRows()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

const rootFor = (archived: boolean) => (archived ? archiveDir() : inboxDir());

export function readReadme(id: string, archived: boolean): string {
  const dir = bundleFolderIn(rootFor(archived), id);
  if (!dir) throw new Error(`no bundle ${id}`);
  return readFileSync(join(dir, "README.md"), "utf8");
}

export type DeleteResult = { ok: true } | { error: string };

// Only a real bundle folder directly inside the inbox or archive is removed, never a link or anything outside.
export function deleteBundle(id: string, archived: boolean): DeleteResult {
  const dir = bundleFolderIn(rootFor(archived), id);
  if (!dir || !existsSync(join(dir, "annotations.json"))) return { error: `no bundle "${id}" ${archived ? "in the archive" : "in the inbox"}` };
  if (hasActiveClaim(dir)) return { error: `${id} is being updated by another process — try again in a moment` };
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return { error: `could not delete ${id}: ${(err as Error).message}` };
  }
  if (!archived) repointLatestIfGone([id]);
  return { ok: true };
}
