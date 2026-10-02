import { BUNDLE_ID } from "@anynotate/protocol";
import { type PaneList, readPanes } from "../bridge/herdr";
import { latestBundleId } from "../inbox/store";
import { runDeliver } from "./deliver";
import { type DeleteResult, deleteBundle, loadRows, readReadme } from "./inbox-data";
import {
  type Effect,
  fit,
  formatAge,
  handleKey,
  type InboxRow,
  type InboxState,
  initialState,
  parseKeys,
  renderInbox,
  sanitize,
  splitKeys,
  statusLabel,
  withPanes,
  withReadme,
  withRows,
  withSize,
} from "./inbox-view";

export const INBOX_USAGE = "usage: anynotate inbox [--select <id|latest>] [--plain]";

export type InboxDeps = {
  loadRows: (withArchive: boolean) => InboxRow[];
  readReadme: (id: string, archived: boolean) => string;
  listPanes: () => Promise<PaneList>;
  deliver: (id: string, pane: string) => Promise<{ ok: boolean; line: string }>;
  remove: (id: string, archived: boolean) => DeleteResult;
};

async function deliverThroughCli(id: string, pane: string): Promise<{ ok: boolean; line: string }> {
  const out: string[] = [];
  const errs: string[] = [];
  const code = await runDeliver([id, "--pane", pane], { log: (l) => out.push(l), err: (l) => errs.push(l) });
  const line = code === 0 ? out.at(-1) ?? `delivered ${id}` : (errs.at(-1) ?? "delivery failed").replace(/^anynotate: /, "");
  return { ok: code === 0, line };
}

export const defaultDeps = (): InboxDeps => ({
  loadRows,
  readReadme,
  listPanes: () => readPanes(),
  deliver: deliverThroughCli,
  remove: deleteBundle,
});

type Parsed = { select?: string; plain: boolean };

function parse(args: string[]): Parsed | null {
  const out: Parsed = { plain: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--plain") out.plain = true;
    else if (a === "--select") {
      const v = args[++i];
      if (!v) return null;
      out.select = v;
    } else return null;
  }
  return out;
}

export function plainList(rows: InboxRow[], now: number, selected?: string): string {
  if (!rows.length) return "No browser notes yet.";
  return rows
    .map((r) => {
      const notes = `${r.notes} note${r.notes === 1 ? "" : "s"}`;
      const title = sanitize(r.archived ? `(archived) ${r.title}` : r.title);
      const line = `${formatAge(r.sentAt, now).padStart(4)}  ${fit(statusLabel(r.state), 9)}  ${fit(notes, 9)}  ${sanitize(r.target)}  "${title}"  ${r.id}`;
      return selected === undefined ? line : `${r.id === selected ? "›" : " "} ${line}`;
    })
    .join("\n");
}

type Selection = { id: string; archived: boolean } | { error: string };

function findSelection(ref: string, deps: InboxDeps): Selection {
  const id = ref === "latest" ? latestBundleId() : ref;
  if (!id || !BUNDLE_ID.test(id)) return { error: ref === "latest" ? "no bundles in the inbox" : `no bundle "${ref}"` };
  const hit = deps.loadRows(true).find((r) => r.id === id);
  return hit ? { id, archived: hit.archived } : { error: `no bundle "${ref}"` };
}

export async function applyEffect(s: InboxState, e: Effect, deps: InboxDeps): Promise<{ state: InboxState; quit?: true }> {
  const refreshed = (state: InboxState, message?: string) => ({ ...withRows(state, deps.loadRows(state.archive)), message });
  switch (e.kind) {
    case "quit":
      return { state: s, quit: true };
    case "refresh":
      return { state: refreshed(s, s.message) };
    case "open": {
      const row = s.rows.find((r) => r.id === e.id);
      try {
        return { state: withReadme(s, e.id, deps.readReadme(e.id, row?.archived ?? false)) };
      } catch (err) {
        return { state: refreshed(s, `Could not read ${e.id}: ${(err as Error).message}`) };
      }
    }
    case "panes":
      return { state: withPanes(s, await deps.listPanes()) };
    case "deliver": {
      const r = await deps.deliver(e.id, e.pane);
      return { state: refreshed(s, r.line) };
    }
    case "delete": {
      const title = s.rows.find((r) => r.id === e.id)?.title || e.id;
      const r = deps.remove(e.id, e.archived);
      return { state: refreshed(s, "ok" in r ? `Deleted “${title}”.` : r.error) };
    }
  }
}

type In = {
  isTTY?: boolean;
  setRawMode?: (on: boolean) => unknown;
  setEncoding: (enc: BufferEncoding) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (ev: "data", fn: (chunk: string | Buffer) => void) => unknown;
  off: (ev: "data", fn: (chunk: string | Buffer) => void) => unknown;
};
type Out = {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write: (chunk: string) => unknown;
  on: (ev: "resize", fn: () => void) => unknown;
  off: (ev: "resize", fn: () => void) => unknown;
};

export type InboxIO = {
  stdin: In;
  stdout: Out;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  err: (line: string) => void;
  deps?: InboxDeps;
  now?: () => number;
};

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export async function runInbox(args: string[], io: InboxIO): Promise<number> {
  const parsed = parse(args);
  if (!parsed) {
    io.err(INBOX_USAGE);
    return 1;
  }
  const deps = io.deps ?? defaultDeps();
  const now = io.now ?? Date.now;
  const tty = !parsed.plain && Boolean(io.stdout.isTTY && io.stdin.isTTY && io.stdin.setRawMode);

  let selection: { id: string; archived: boolean } | undefined;
  let notice: string | undefined;
  try {
    if (parsed.select !== undefined) {
      const found = findSelection(parsed.select, deps);
      if ("error" in found) {
        if (!tty) {
          io.err(`anynotate: ${found.error} — run \`anynotate inbox --plain\` to list`);
          return 1;
        }
        notice = `${found.error[0]!.toUpperCase()}${found.error.slice(1)} — showing the inbox.`;
      } else selection = found;
    }
    if (!tty) {
      io.log(plainList(deps.loadRows(selection?.archived ?? false), now(), selection?.id));
      return 0;
    }
  } catch (err) {
    io.err(`anynotate: ${(err as Error).message}`);
    return 1;
  }
  return runTty(io, deps, now, selection, notice);
}

export const ESC_WAIT_MS = 50;

function runTty(io: InboxIO, deps: InboxDeps, now: () => number, selection?: { id: string; archived: boolean }, notice?: string): Promise<number> {
  const { stdin, stdout } = io;
  const color = !(io.env.NO_COLOR ?? "");
  let state: InboxState = { ...initialState([], selection?.archived ?? false), message: notice };
  let pending = "";
  let escTimer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let restored = false;

  return new Promise<number>((resolve) => {
    const draw = () => {
      if (restored) return;
      const lines = renderInbox(state, { now: now(), color });
      stdout.write(`\x1b[H${lines.map((l) => `\x1b[2K${l}`).join("\r\n")}`);
    };
    const restore = () => {
      if (restored) return;
      restored = true;
      clearTimeout(escTimer);
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      for (const sig of SIGNALS) process.off(sig, onSignal);
      if (process.platform !== "win32") process.off("SIGWINCH", onResize);
      process.off("exit", restore);
      try {
        stdin.setRawMode?.(false);
      } catch {}
      stdin.pause();
      stdout.write(LEAVE_SCREEN);
    };
    const finish = (code: number, message?: string) => {
      restore();
      if (message) io.err(message);
      resolve(code);
    };
    const onSignal = () => finish(130);
    const onResize = () => {
      state = withSize(state, stdout.columns ?? state.width, stdout.rows ?? state.height);
      draw();
    };
    const run = async (effect: Effect) => {
      const r = await applyEffect(state, effect, deps);
      state = withSize(r.state, state.width, state.height);
      if (r.quit) return finish(0);
      draw();
    };
    const onKeys = (keys: string[]) => {
      for (const key of keys) {
        if (restored) return;
        if (busy) {
          if (key === "ctrl-c") finish(130);
          continue;
        }
        const confirming = state.mode.kind === "confirm";
        const step = handleKey(state, key);
        state = step.state;
        draw();
        if (!confirming && state.mode.kind === "confirm") {
          pending = "";
          return;
        }
        if (!step.effect) continue;
        busy = true;
        run(step.effect)
          .catch((err) => finish(1, `anynotate: ${(err as Error).message}`))
          .finally(() => {
            busy = false;
          });
      }
    };
    const onData = (chunk: string | Buffer) => {
      clearTimeout(escTimer);
      const { keys, rest } = splitKeys(pending + chunk.toString());
      pending = rest;
      onKeys(keys);
      if (pending && !restored) {
        escTimer = setTimeout(() => {
          const lone = pending;
          pending = "";
          onKeys(parseKeys(lone));
        }, ESC_WAIT_MS);
      }
    };

    try {
      stdin.setRawMode!(true);
      stdin.setEncoding("utf8");
      stdin.resume();
      stdout.write(ENTER_SCREEN);
      process.on("exit", restore);
      for (const sig of SIGNALS) process.on(sig, onSignal);
      if (process.platform !== "win32") process.on("SIGWINCH", onResize);
      stdout.on("resize", onResize);
      stdin.on("data", onData);
      state = withSize(withRows(state, deps.loadRows(state.archive)), stdout.columns ?? 80, stdout.rows ?? 24);
      const start = selection ? state.rows.findIndex((r) => r.id === selection.id) : -1;
      if (start >= 0) {
        state = withSize({ ...state, sel: start }, state.width, state.height);
        busy = true;
        run({ kind: "open", id: selection!.id })
          .catch((err) => finish(1, `anynotate: ${(err as Error).message}`))
          .finally(() => {
            busy = false;
          });
      } else draw();
    } catch (err) {
      finish(1, `anynotate: ${(err as Error).message}`);
    }
  });
}
