export type Exec = (argv: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const spawnPiped = (argv: string[]) => Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });

export const bunExec: Exec = async (argv, timeoutMs) => {
  let proc: ReturnType<typeof spawnPiped>;
  try {
    proc = spawnPiped(argv);
  } catch (err) {
    // Bun.spawn throws synchronously (e.g. ENOENT) when the binary is missing.
    return { code: 127, stdout: "", stderr: String(err) };
  }
  const timer = timeoutMs ? setTimeout(() => proc.kill(), timeoutMs) : undefined;
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
};
