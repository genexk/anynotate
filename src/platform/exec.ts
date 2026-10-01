export type ExecResult = { code: number; stdout: string; stderr: string };
// env adds to (never replaces) this process's environment.
export type Exec = (argv: string[], cwd?: string, env?: Record<string, string>) => ExecResult;

// A missing binary surfaces as exit code 127, like a shell would report it; this never throws.
export const spawnExec: Exec = (argv, cwd, env) => {
  try {
    const proc = Bun.spawnSync(argv, { cwd, env: env ? { ...process.env, ...env } : undefined, stdout: "pipe", stderr: "pipe" });
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
