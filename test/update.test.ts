import { expect, test } from "bun:test";
import { type Exec, runUpdate, spawnExec } from "../src/agent/update";

const repo = "/home/me/anynotate";
const bun = "/home/me/.bun/bin/bun";
type Call = { argv: string[]; cwd?: string };
type Result = { code: number; stdout: string; stderr: string };

function fake(script: (argv: string[]) => Partial<Result> | undefined = () => undefined) {
  const calls: Call[] = [];
  const exec: Exec = (argv, cwd) => {
    calls.push({ argv, cwd });
    const scripted = script(argv) ?? {};
    const defaults: Result = argv.includes("rev-parse")
      ? { code: 0, stdout: "main\n", stderr: "" }
      : { code: 0, stdout: "", stderr: "" };
    return { ...defaults, ...scripted };
  };
  return { calls, exec };
}

function run(f: { calls: Call[]; exec: Exec }, opts: { dryRun?: boolean; before?: string; after?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const pulled = () => f.calls.some((c) => c.argv.includes("pull"));
  const code = runUpdate({
    kind: { kind: "source", repo, bun },
    exec: f.exec,
    dryRun: opts.dryRun ?? false,
    log: (l) => out.push(l),
    err: (l) => err.push(l),
    readVersion: () => (pulled() ? (opts.after ?? "0.3.0") : (opts.before ?? "0.3.0")),
  });
  return { code, out, err };
}

const branchCheck = ["git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD"];
const statusCheck = ["git", "-C", repo, "status", "--porcelain", "--untracked-files=normal"];

test("refuses when the clone is not on main", () => {
  const f = fake((argv) => (argv.includes("rev-parse") ? { stdout: "feature/x\n" } : undefined));
  const { code, out, err } = run(f);
  expect(code).toBe(1);
  expect(f.calls.map((c) => c.argv)).toEqual([branchCheck]);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("feature/x");
  expect(err.join("\n")).toContain("main");
});

test("refuses when the working tree is not clean", () => {
  const f = fake((argv) => (argv.includes("status") ? { stdout: " M src/cli.ts\n?? notes.txt\n" } : undefined));
  const { code, out, err } = run(f);
  expect(code).toBe(1);
  expect(f.calls.map((c) => c.argv)).toEqual([branchCheck, statusCheck]);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("src/cli.ts");
  expect(err.join("\n")).toContain("notes.txt");
});

test("refuses when git cannot read the branch", () => {
  const f = fake((argv) => (argv.includes("rev-parse") ? { code: 128, stdout: "", stderr: "not a git repository" } : undefined));
  const { code, err } = run(f);
  expect(code).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect(err.join("\n")).toContain("not a git repository");
});

test("refuses when git status fails", () => {
  const f = fake((argv) => (argv.includes("status") ? { code: 128, stderr: "index file corrupt" } : undefined));
  const { code, out, err } = run(f);
  expect(code).toBe(1);
  expect(f.calls.map((c) => c.argv)).toEqual([branchCheck, statusCheck]);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("index file corrupt");
});

test("happy path pulls, installs, re-runs the installer (which restarts the bridge) and prints the versions", () => {
  const f = fake();
  const { code, out, err } = run(f, { before: "0.2.0", after: "0.3.0" });
  expect(code).toBe(0);
  expect(f.calls).toEqual([
    { argv: branchCheck, cwd: undefined },
    { argv: statusCheck, cwd: undefined },
    { argv: ["git", "-C", repo, "pull", "--ff-only"], cwd: undefined },
    { argv: [bun, "install"], cwd: repo },
    { argv: [bun, `${repo}/src/cli.ts`, "install", "--no-hints"], cwd: repo },
  ]);
  expect(f.calls.some((c) => c.argv[0] === "launchctl")).toBe(false);
  expect(err).toEqual([]);
  expect(out.at(-1)).toBe("anynotate 0.2.0 → 0.3.0");
});

test("stops at the first failing step and reports its stderr on the error stream", () => {
  const f = fake((argv) => (argv[0] === bun ? { code: 1, stderr: "lockfile had changes" } : undefined));
  const { code, out, err } = run(f, { before: "0.2.0", after: "0.3.0" });
  expect(code).toBe(1);
  expect(f.calls.map((c) => c.argv[0])).toEqual(["git", "git", "git", bun]);
  expect(err.join("\n")).toContain("lockfile had changes");
  expect(err.join("\n")).toContain(`'${bun} install' failed (exit 1)`);
  expect(out.join("\n")).not.toContain("lockfile had changes");
  expect(out.join("\n")).not.toContain("→");
});

test("dry run logs every step and calls only the read-only checks", () => {
  const f = fake();
  const { code, out, err } = run(f, { dryRun: true });
  expect(code).toBe(0);
  expect(err).toEqual([]);
  expect(f.calls.map((c) => c.argv)).toEqual([branchCheck, statusCheck]);
  const would = out.filter((l) => l.startsWith("would run "));
  expect(would).toHaveLength(3);
  expect(would[0]).toContain("git -C /home/me/anynotate pull --ff-only");
  expect(would[1]).toContain(`${bun} install`);
  expect(would[2]).toContain(`${bun} /home/me/anynotate/src/cli.ts install --no-hints`);
});

test("dry run still refuses off main", () => {
  const f = fake((argv) => (argv.includes("rev-parse") ? { stdout: "feature/x\n" } : undefined));
  const { code, out, err } = run(f, { dryRun: true });
  expect(code).toBe(1);
  expect(f.calls).toHaveLength(1);
  expect(out.some((l) => l.startsWith("would run"))).toBe(false);
  expect(err).toHaveLength(1);
});

test("spawnExec reports a missing binary as exit 127 instead of throwing", () => {
  const r = spawnExec(["anynotate-no-such-binary-xyz", "--version"]);
  expect(r.code).toBe(127);
  expect(r.stdout).toBe("");
  expect(r.stderr.length).toBeGreaterThan(0);
});

test("spawnExec returns the exit code and output of a real command", () => {
  const r = spawnExec(["sh", "-c", "echo hi; echo oops >&2; exit 3"]);
  expect(r).toEqual({ code: 3, stdout: "hi\n", stderr: "oops\n" });
});
