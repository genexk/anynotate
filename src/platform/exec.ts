export type ExecResult = { code: number; stdout: string; stderr: string };
// The `reg query` for what a `reg delete` argv would remove. reg.exe localizes its messages, so whether a key or value
// exists is judged by this command's exit code (1 when it is absent), never by its text.
export const regQueryFor = (deleteArgv: string[]) => ["reg", "query", ...deleteArgv.slice(2).filter((a) => a.toLowerCase() !== "/f")];

// env adds to (never replaces) this process's environment.
export type ExecLimits = { timeoutMs?: number };
export type Exec = (argv: string[], cwd?: string, env?: Record<string, string>, limits?: ExecLimits) => ExecResult;

export const TIMED_OUT = 124;

// A missing binary surfaces as exit code 127, like a shell would report it; this never throws.
export const spawnExec: Exec = (argv, cwd, env, limits) => {
  try {
    const timeout = limits?.timeoutMs;
    const proc = Bun.spawnSync(argv, { cwd, env: env ? { ...process.env, ...env } : undefined, stdout: "pipe", stderr: "pipe", timeout });
    if (timeout !== undefined && (proc.exitedDueToTimeout || (proc.exitCode === null && proc.signalCode))) {
      return { code: TIMED_OUT, stdout: proc.stdout.toString(), stderr: `timed out after ${Math.round(timeout / 1000)} s` };
    }
    return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
};

// Runs nothing and reports success; the command goes to stderr so callers' own output stays intact.
export const dryRunExec: Exec = (argv) => {
  console.error(`would run: ${argv.join(" ")}`);
  return { code: 0, stdout: "", stderr: "" };
};
