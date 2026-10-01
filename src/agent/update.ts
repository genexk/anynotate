import { join } from "node:path";
import { LAUNCHD_LABEL } from "./install";

export type Exec = (argv: string[], cwd?: string) => { code: number; stdout: string; stderr: string };

export type UpdateOptions = {
  repo: string;
  uid: number;
  exec: Exec;
  dryRun: boolean;
  log: (line: string) => void;
  err: (line: string) => void;
  readVersion: () => string;
};

export const spawnExec: Exec = (argv, cwd) => {
  try {
    const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
};

export function runUpdate(o: UpdateOptions): number {
  const { repo, exec, log, err } = o;
  const refuse = (why: string) => {
    err(`anynotate update: ${why}`);
    return 1;
  };

  const branch = exec(["git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.code !== 0) return refuse(`cannot read the branch of ${repo}: ${branch.stderr.trim()}`);
  const name = branch.stdout.trim();
  if (name !== "main") return refuse(`${repo} is on '${name}', not 'main'; switch to main to update`);

  const status = exec(["git", "-C", repo, "status", "--porcelain", "--untracked-files=normal"]);
  if (status.code !== 0) return refuse(`cannot read the status of ${repo}: ${status.stderr.trim()}`);
  if (status.stdout.trim()) return refuse(`${repo} has uncommitted changes; commit or discard them first:\n${status.stdout.trimEnd()}`);

  const steps: { argv: string[]; cwd?: string }[] = [
    { argv: ["git", "-C", repo, "pull", "--ff-only"] },
    { argv: ["bun", "install"], cwd: repo },
    { argv: [join(repo, "bin/anynotate"), "install", "--no-hints"], cwd: repo },
    { argv: ["launchctl", "kickstart", "-k", `gui/${o.uid}/${LAUNCHD_LABEL}`] },
  ];
  const show = (s: { argv: string[]; cwd?: string }) => s.argv.join(" ") + (s.cwd ? ` (in ${s.cwd})` : "");

  const before = o.readVersion();
  if (o.dryRun) {
    log(`anynotate ${before}`);
    for (const s of steps) log(`would run ${show(s)}`);
    return 0;
  }

  for (const s of steps) {
    log(`run ${show(s)}`);
    const r = exec(s.argv, s.cwd);
    if (r.stdout.trim()) log(r.stdout.trimEnd());
    if (r.code !== 0) {
      if (r.stderr.trim()) err(r.stderr.trimEnd());
      return refuse(`'${s.argv.join(" ")}' failed (exit ${r.code})`);
    }
  }
  log(`anynotate ${before} → ${o.readVersion()}`);
  return 0;
}
