import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEffect, type InboxDeps, plainList, runInbox } from "../src/agent/inbox";
import { initialState, type InboxRow } from "../src/agent/inbox-view";
import { writeBundle } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";
import { cliArgv, writeHerdrShim } from "./fixtures/spawn";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

const NOW = Date.parse("2026-09-24T12:00:00Z");
const at = (h: number) => new Date(`2026-09-24T${String(h).padStart(2, "0")}:00:00`);
const row = (over: Partial<InboxRow> = {}): InboxRow => ({
  id: "2026-09-24T110000-page", title: "A page", target: "claude · w1:p2", state: "delivered", notes: 3, sentAt: "2026-09-24T09:00:00Z", archived: false, ...over,
});

function fakeDeps(over: Partial<InboxDeps> = {}): InboxDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loadRows: () => [row()],
    readReadme: (id) => `# README of ${id}`,
    listPanes: async () => ({ panes: [{ pane: "w1:p7", agent: "claude", cwd: "/home/me", title: "t", status: "idle" }] }),
    deliver: async (id, pane) => { calls.push(`deliver ${id} ${pane}`); return { ok: true, line: `delivered ${id} to pane ${pane}` }; },
    remove: (id, archived) => { calls.push(`remove ${id} ${archived}`); return { ok: true }; },
    ...over,
  };
}

test("plainList prints one line per bundle: age, status, notes, target, title, id", () => {
  const out = plainList([row(), row({ id: "2026-09-24T100000-b", title: "Second", state: "acked", notes: 1 })], NOW);
  const lines = out.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\s*3h\s+delivered\s+3 notes\s+claude · w1:p2\s+"A page"\s+2026-09-24T110000-page$/);
  expect(lines[1]).toContain("read ✓");
  expect(lines[1]).toContain("1 note ");
  expect(plainList([], NOW)).toBe("No browser notes yet.");
});

test("plainList strips control characters from titles", () => {
  expect(plainList([row({ title: "evil\x1b[2Jtitle" })], NOW)).not.toContain("\x1b");
});

test("the deliver effect calls the deliver function with the chosen pane and shows its result", async () => {
  const deps = fakeDeps();
  const s = { ...initialState([row()]), width: 80, height: 12 };
  const r = await applyEffect(s, { kind: "deliver", id: row().id, pane: "w1:p7" }, deps);
  expect(deps.calls).toEqual([`deliver ${row().id} w1:p7`]);
  expect(r.state.message).toBe(`delivered ${row().id} to pane w1:p7`);
});

test("a failed delivery shows the error line", async () => {
  const deps = fakeDeps({ deliver: async () => ({ ok: false, line: "pane w1:p7 is showing an approval dialog" }) });
  const r = await applyEffect({ ...initialState([row()]), width: 80, height: 12 }, { kind: "deliver", id: row().id, pane: "w1:p7" }, deps);
  expect(r.state.message).toContain("approval dialog");
});

test("the delete effect removes through the guarded function and refreshes", async () => {
  let rows = [row(), row({ id: "2026-09-24T100000-b" })];
  const deps = fakeDeps({ loadRows: () => rows, remove: (id) => { rows = rows.filter((r) => r.id !== id); return { ok: true }; } });
  const r = await applyEffect({ ...initialState(rows), width: 80, height: 12 }, { kind: "delete", id: row().id, archived: false }, deps);
  expect(r.state.rows.map((x) => x.id)).toEqual(["2026-09-24T100000-b"]);
  expect(r.state.message).toContain("Deleted");
});

test("open and panes effects load the README and the pane list", async () => {
  const deps = fakeDeps();
  const s = { ...initialState([row()]), width: 80, height: 12 };
  const v = await applyEffect(s, { kind: "open", id: row().id }, deps);
  expect(v.state.mode).toMatchObject({ kind: "view", id: row().id });
  const p = await applyEffect({ ...s, mode: { kind: "picker", id: row().id, panes: null, sel: 0 } }, { kind: "panes", id: row().id }, deps);
  expect(p.state.mode).toMatchObject({ kind: "picker", panes: [{ pane: "w1:p7" }] });
  expect((await applyEffect(s, { kind: "quit" }, deps)).quit).toBe(true);
});

class FakeIn extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode(on: boolean) { this.raw.push(on); return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
}
class FakeOut extends EventEmitter {
  isTTY = true;
  columns = 70;
  rows = 14;
  out = "";
  write(chunk: string) { this.out += chunk; return true; }
}

async function tty(keys: string[], deps: InboxDeps, args: string[] = []) {
  const stdin = new FakeIn();
  const stdout = new FakeOut();
  const errs: string[] = [];
  const done = runInbox(args, { stdin, stdout, env: {}, deps, err: (l) => errs.push(l), log: () => {} });
  for (const k of keys) {
    await Bun.sleep(5);
    stdin.emit("data", k);
  }
  return { code: await done, stdin, stdout, errs };
}

test("the TTY shell switches to the alternate screen, sends via the picker and restores the terminal on quit", async () => {
  const deps = fakeDeps();
  const r = await tty(["s", "\r", "q"], deps);
  expect(r.code).toBe(0);
  expect(deps.calls).toEqual([`deliver ${row().id} w1:p7`]);
  expect(r.stdin.raw).toEqual([true, false]);
  expect(r.stdout.out.startsWith("\x1b[?1049h\x1b[?25l")).toBe(true);
  expect(r.stdout.out.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
  expect(r.stdout.out).toContain("Anynotate inbox");
});

test("the TTY shell restores the terminal when an effect throws", async () => {
  const deps = fakeDeps({ loadRows: () => { throw new Error("disk on fire"); } });
  const r = await tty([], deps);
  expect(r.code).toBe(1);
  expect(r.stdin.raw.at(-1)).toBe(false);
  expect(r.stdout.out.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
  expect(r.errs.join("\n")).toContain("disk on fire");
});

test("the TTY shell re-renders at the new size on resize", async () => {
  const stdin = new FakeIn();
  const stdout = new FakeOut();
  const done = runInbox([], { stdin, stdout, env: { NO_COLOR: "1" }, deps: fakeDeps({ loadRows: () => [row({ title: "x".repeat(200) })] }), err: () => {}, log: () => {} });
  await Bun.sleep(5);
  stdout.columns = 40;
  stdout.emit("resize");
  await Bun.sleep(5);
  const last = stdout.out.slice(stdout.out.lastIndexOf("\x1b[H"));
  for (const l of last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\r\n")) expect(l.length).toBeLessThanOrEqual(40);
  expect(stdout.out).not.toContain("\x1b[32m");
  stdin.emit("data", "q");
  expect(await done).toBe(0);
});

test("--select opens that bundle's README", async () => {
  const deps = fakeDeps({ loadRows: () => [row({ id: "2026-09-24T120000-new" }), row()] });
  const stdin = new FakeIn();
  const stdout = new FakeOut();
  const done = runInbox(["--select", row().id], { stdin, stdout, env: {}, deps, err: () => {}, log: () => {} });
  await Bun.sleep(10);
  expect(stdout.out).toContain(`README of ${row().id}`);
  stdin.emit("data", "q");
  await Bun.sleep(5);
  stdin.emit("data", "q");
  expect(await done).toBe(0);
});

test("--select of a bundle that is gone opens the list with a one-line message", async () => {
  const r = await tty(["q"], fakeDeps(), ["--select", "2026-01-01T000000-nope"]);
  expect(r.code).toBe(0);
  expect(r.errs).toEqual([]);
  expect(r.stdout.out).toContain('No bundle "2026-01-01T000000-nope" — showing the inbox.');
  expect(r.stdout.out).toContain("A page");
  expect(r.stdin.raw).toEqual([true, false]);
});

test("--plain --select of an unknown bundle still fails", async () => {
  const r = await tty([], fakeDeps(), ["--plain", "--select", "2026-01-01T000000-nope"]);
  expect(r.code).toBe(1);
  expect(r.errs.join("\n")).toContain("no bundle");
  expect(r.stdin.raw).toEqual([]);
});

test("an escape sequence split across reads is a key, not Esc", async () => {
  const rows = [row(), row({ id: "2026-09-24T100000-b", title: "Second" })];
  const deps = fakeDeps({ loadRows: () => rows });
  const stdin = new FakeIn();
  const stdout = new FakeOut();
  let finished = false;
  const done = runInbox([], { stdin, stdout, env: {}, deps, err: () => {}, log: () => {} }).then((c) => { finished = true; return c; });
  await Bun.sleep(5);
  stdin.emit("data", "\x1b");
  await Bun.sleep(10);
  stdin.emit("data", "[B");
  await Bun.sleep(80);
  expect(finished).toBe(false);
  stdin.emit("data", "d");
  await Bun.sleep(5);
  stdin.emit("data", "y");
  await Bun.sleep(5);
  expect(deps.calls).toEqual(["remove 2026-09-24T100000-b false"]);
  stdin.emit("data", "\x1b");
  await Bun.sleep(10);
  expect(finished).toBe(false);
  expect(await done).toBe(0);
});

test("delete asks again when the y arrives in the same read as the d", async () => {
  const deps = fakeDeps();
  const r = await tty(["dy", "n", "q"], deps);
  expect(r.code).toBe(0);
  expect(deps.calls).toEqual([]);
  expect(r.stdout.out).toContain("Kept.");
});

test("a resize during a slow action is kept when the action finishes", async () => {
  let release = () => {};
  const deps = fakeDeps({
    loadRows: () => [row({ title: "x".repeat(200) })],
    deliver: (id, pane) => new Promise((resolve) => { release = () => resolve({ ok: true, line: `delivered ${id} to pane ${pane}` }); }),
  });
  const stdin = new FakeIn();
  const stdout = new FakeOut();
  const done = runInbox([], { stdin, stdout, env: { NO_COLOR: "1" }, deps, err: () => {}, log: () => {} });
  await Bun.sleep(5);
  stdin.emit("data", "s");
  await Bun.sleep(5);
  stdin.emit("data", "\r");
  await Bun.sleep(5);
  stdout.columns = 40;
  stdout.emit("resize");
  release();
  await Bun.sleep(5);
  const last = stdout.out.slice(stdout.out.lastIndexOf("\x1b[H"));
  expect(last).toContain("delivered");
  for (const l of last.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\r\n")) expect(l.length).toBeLessThanOrEqual(40);
  stdin.emit("data", "q");
  expect(await done).toBe(0);
});

type Run = { code: number; out: string; err: string };
async function inbox(args: string[]): Promise<Run> {
  const env: Record<string, string | undefined> = { ...process.env, ANYNOTATE_HOME: home, ANYNOTATE_HERDR: writeHerdrShim(home), HERDR_SHIM_LOG: join(home, "herdr.log") };
  delete env.HERDR_BIN_PATH;
  const proc = Bun.spawn(cliArgv("inbox", ...args), { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

test("anynotate inbox prints the plain list when stdout is not a terminal", async () => {
  const a = writeBundle({ ...sampleInput, title: "Older page" }, {}, at(9));
  const b = writeBundle({ ...sampleInput, title: "Newer page" }, {}, at(10));
  const r = await inbox([]);
  expect(r.code).toBe(0);
  const lines = r.out.trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain(b.id);
  expect(lines[0]).toContain('"Newer page"');
  expect(lines[0]).toContain("queued");
  expect(lines[1]).toContain(a.id);
  expect(existsSync(join(home, "herdr.log"))).toBe(false);
});

test("anynotate inbox --plain --select latest marks the newest bundle", async () => {
  writeBundle({ ...sampleInput, title: "Older page" }, {}, at(9));
  const b = writeBundle({ ...sampleInput, title: "Newer page" }, {}, at(10));
  const r = await inbox(["--plain", "--select", "latest"]);
  expect(r.code).toBe(0);
  const lines = r.out.trim().split("\n");
  expect(lines[0]!.startsWith("›")).toBe(true);
  expect(lines[0]).toContain(b.id);
  expect(lines[1]!.startsWith(" ")).toBe(true);
});

test("anynotate inbox --plain --select of an archived bundle includes the archive", async () => {
  const a = writeBundle(sampleInput, {}, at(9));
  mkdirSync(join(home, "archive"));
  renameSync(join(home, "inbox", a.id), join(home, "archive", a.id));
  const r = await inbox(["--plain", "--select", a.id]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("(archived)");
});

test("anynotate inbox rejects unknown flags and an empty inbox prints a friendly line", async () => {
  expect((await inbox(["--bogus"])).err).toContain("usage: anynotate inbox");
  const empty = await inbox([]);
  expect(empty.code).toBe(0);
  expect(empty.out.trim()).toBe("No browser notes yet.");
});
