import type { Exec } from "../platform/exec";
import { commandArgv, type InstallKind } from "./installkind";

export { type Exec, spawnExec } from "../platform/exec";

export type UpdateOptions = {
  kind: Extract<InstallKind, { kind: "source" }>;
  exec: Exec;
  dryRun: boolean;
  log: (line: string) => void;
  err: (line: string) => void;
  readVersion: () => string;
};

export function runUpdate(o: UpdateOptions): number {
  const { exec, log, err } = o;
  const { repo, bun } = o.kind;
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

  // install rewrites the service definition and restarts the bridge, so it is the last step.
  const steps: { argv: string[]; cwd?: string }[] = [
    { argv: ["git", "-C", repo, "pull", "--ff-only"] },
    { argv: [bun, "install"], cwd: repo },
    { argv: [...commandArgv(o.kind), "install", "--no-hints"], cwd: repo },
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
