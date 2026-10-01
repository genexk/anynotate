import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import pkg from "../package.json";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBundle } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

test("hook writes its full output to a pipe, well past 64 KB", async () => {
  const ids = [1, 2, 3].map((n) => writeBundle({ ...sampleInput, overall: `${n}`.repeat(300_000) }, {}).id);
  const proc = Bun.spawn([join(import.meta.dir, "../bin/anynotate"), "hook", "--agent", "claude"], {
    env: { ...process.env, ANYNOTATE_HOME: home },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-1", cwd: "/tmp/repo" })),
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out.length).toBeGreaterThan(900_000);
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
  for (const id of ids) expect(ctx).toContain(id);
});

test("hook --agent accepts any valid agent name and ignores an invalid one", async () => {
  const run = async (agent: string) => {
    const proc = Bun.spawn([join(import.meta.dir, "../bin/anynotate"), "hook", "--agent", agent], {
      env: { ...process.env, ANYNOTATE_HOME: home },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-1", cwd: "/a" })),
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out;
  };
  const id = writeBundle({ ...sampleInput, target: { agent: "agy", cwd: "/a" } }, {}).id;
  expect(await run("Bad/Name")).toBe("");
  const out = JSON.parse(await run("agy"));
  expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  expect(out.hookSpecificOutput.additionalContext).toContain(id);
});

const cli = async (args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn([join(import.meta.dir, "../bin/anynotate"), ...args], {
    env: { ...process.env, ANYNOTATE_HOME: home, ANYNOTATE_RETENTION_DAYS: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
};

test("retention prints the effective setting and its source, and sets it in settings.json", async () => {
  expect((await cli(["retention"])).out).toBe("retention 30 days (default)\n");
  expect((await cli(["retention"], { ANYNOTATE_RETENTION_DAYS: "5" })).out).toBe("retention 5 days (env)\n");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ other: 1 }));
  expect((await cli(["retention", "7"])).out).toBe("retention set to 7 days (settings.json)\n");
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ other: 1, retentionDays: 7 });
  expect(statSync(join(home, "settings.json")).mode & 0o777).toBe(0o600);
  expect((await cli(["retention"])).out).toBe("retention 7 days (settings.json)\n");
  expect((await cli(["retention", "off"])).out).toBe("retention set to off (settings.json)\n");
  const bad = await cli(["retention", "soon"]);
  expect(bad.code).toBe(1);
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).retentionDays).toBe("off");
});

test("prune --dry-run lists old bundles without deleting them; prune deletes them", async () => {
  const old = writeBundle({ ...sampleInput, title: "old" }, {}, new Date(2000, 0, 1)).id;
  const fresh = writeBundle({ ...sampleInput, title: "fresh" }, {}).id;
  const dry = await cli(["prune", "--dry-run"]);
  expect(dry.out).toBe(`would prune ${old}\nwould prune 1 bundle(s) older than 30 days\n`);
  expect(existsSync(join(home, "inbox", old))).toBe(true);
  expect((await cli(["prune"])).out).toBe(`pruned ${old}\npruned 1 bundle(s) older than 30 days\n`);
  expect(existsSync(join(home, "inbox", old))).toBe(false);
  expect(existsSync(join(home, "inbox", fresh))).toBe(true);
});

test("prune rejects unknown arguments", async () => {
  const old = writeBundle({ ...sampleInput, title: "old" }, {}, new Date(2000, 0, 1)).id;
  for (const args of [["prune", "--dryrun"], ["prune", "now"], ["prune", "--dry-run", "x"]]) {
    expect((await cli(args)).code).toBe(1);
  }
  expect(existsSync(join(home, "inbox", old))).toBe(true);
});

test("retention <days> mentions the env override only when the env value is non-blank", async () => {
  expect((await cli(["retention", "7"], { ANYNOTATE_RETENTION_DAYS: "  " })).out).not.toContain("takes precedence");
  expect((await cli(["retention", "7"], { ANYNOTATE_RETENTION_DAYS: "3" })).out).toContain("takes precedence");
});

const CLI = join(import.meta.dir, "../src/cli.ts");
const run = async (args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ANYNOTATE_HOME: join(home, "data"), HOME: home, USERPROFILE: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
};

test("install --dry-run lists the service start and prints no launchctl hints", async () => {
  const r = await run(["install", "--dry-run"]);
  expect(r.code).toBe(0);
  const lines = r.out.trimEnd().split("\n");
  expect(lines.some((l) => l.startsWith("would run: "))).toBe(true);
  expect(lines).toContain(`would write ${join(home, "data", "install.json")}`);
  expect(r.out).not.toMatch(/Next:|\$\(id -u\)|If the bridge was already running/);
  expect(existsSync(join(home, "data"))).toBe(false);
});

test("install records the install kind and writes the service without starting it under ANYNOTATE_SERVICE_DRYRUN", async () => {
  const r = await run(["install"], { ANYNOTATE_SERVICE_DRYRUN: "1" });
  expect(r.code).toBe(0);
  const record = JSON.parse(readFileSync(join(home, "data", "install.json"), "utf8"));
  expect(record).toMatchObject({ kind: "source", path: join(import.meta.dir, ".."), version: pkg.version, platform: process.platform });
  expect(r.out).toContain("would run: ");
  expect(r.out).not.toMatch(/^ran: /m);
});

test("uninstall --dry-run lists the removals and changes nothing", async () => {
  await run(["install"], { ANYNOTATE_SERVICE_DRYRUN: "1" });
  const r = await run(["uninstall", "--dry-run", "--purge"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`would remove ${join(home, "data", "install.json")}`);
  expect(r.out.trimEnd().split("\n").at(-1)).toBe("Dry run: nothing was changed.");
  expect(existsSync(join(home, "data", "install.json"))).toBe(true);
});

// Not on Windows: the native-host step deletes real HKCU registry keys there.
test.skipIf(process.platform === "win32")("uninstall removes what install wrote and keeps the data dir", async () => {
  await run(["install"], { ANYNOTATE_SERVICE_DRYRUN: "1" });
  const r = await run(["uninstall"], { ANYNOTATE_SERVICE_DRYRUN: "1" });
  expect(r.code).toBe(0);
  expect(existsSync(join(home, "data", "install.json"))).toBe(false);
  expect(existsSync(join(home, "data"))).toBe(true);
  expect(r.out).not.toMatch(/^ran: /m);
  expect(r.out.trimEnd().split("\n").at(-1)).toBe(`Anynotate removed. Your notes are still in ${join(home, "data")} (use --purge to delete them).`);
});

test("uninstall rejects unknown flags", async () => {
  const r = await run(["uninstall", "--force"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: anynotate uninstall [--purge] [--dry-run]");
});

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  return String(port);
};

test.skipIf(process.platform === "win32")("bridge --detach starts a bridge with a pid file; --status and --stop control it", async () => {
  const env = { ANYNOTATE_PORT: freePort() };
  const pidFile = join(home, "data", "bridge.pid");
  try {
    const started = await run(["bridge", "--detach"], env);
    expect(started.code).toBe(0);
    expect(started.out).toContain(`bridge started on http://127.0.0.1:${env.ANYNOTATE_PORT}`);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${env.ANYNOTATE_PORT}/health`)).ok).toBe(true);
    expect((await run(["bridge", "--detach"], env)).out).toContain("bridge already running");
    const status = await run(["bridge", "--status"], env);
    expect(status.code).toBe(0);
    expect(status.out).toContain(`(pid ${pid})`);
    const stopped = await run(["bridge", "--stop"], env);
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain(`bridge stopped (pid ${pid})`);
    expect(existsSync(pidFile)).toBe(false);
    expect((await run(["bridge", "--status"], env)).code).toBe(1);
    expect((await run(["bridge", "--stop"], env)).out).toContain("not running");
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8").trim()));
    } catch {}
  }
}, 30_000);

test("bridge --stop leaves a pid alone when no bridge answers, and drops the stale pid file", async () => {
  const env = { ANYNOTATE_PORT: freePort() };
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data", "bridge.pid"), `${process.pid}\n`);
  const r = await run(["bridge", "--stop"], env);
  expect(r.code).toBe(0);
  expect(r.out).toContain("removed a stale pid file");
  expect(existsSync(join(home, "data", "bridge.pid"))).toBe(false);
});
