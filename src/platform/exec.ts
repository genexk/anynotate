export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (argv: string[], cwd?: string) => ExecResult;

// A missing binary surfaces as exit code 127, like a shell would report it; this never throws.
export const spawnExec: Exec = (argv, cwd) => {
  try {
    const proc = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
};
