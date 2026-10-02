import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Exec, spawnExec } from "../platform/exec";
import { makePrivateDir, writePrivateFile } from "../platform/files";
import { currentPlatform, type Platform } from "../platform/os";

export const PID_FILE = "bridge.pid";
export const DEFAULT_PORT = 47291;

export const bridgePort = (env: Record<string, string | undefined> = process.env) => Number(env.ANYNOTATE_PORT ?? DEFAULT_PORT);

export type Control = {
  dataDir: string;
  logPath: string;
  port: number;
  log: (line: string) => void;
  err: (line: string) => void;
  exec?: Exec;
  platform?: Platform;
  // Injected by tests; defaults to bridgeAnswers.
  answers?: (port: number, timeoutMs?: number) => Promise<boolean>;
};

const answersOf = (c: Control) => c.answers ?? bridgeAnswers;

export const SERVICE_MANAGED =
  "the bridge is managed by the system service; use `anynotate uninstall` or your service manager to stop it";

// Whether pid is running an anynotate bridge, judged from its command line: our executable (anynotate, anynotate.exe
// or cli.ts under bun) with the bridge subcommand.
export function isBridgeProcess(pid: number, platform: Platform = currentPlatform(), exec: Exec = spawnExec): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const r =
    platform === "win32"
      ? exec(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`])
      : exec(["ps", "-o", "command=", "-p", String(pid)]);
  const line = r.stdout.trim();
  return r.code === 0 && /(anynotate(\.exe)?|cli\.ts)"?\s/i.test(line) && /\sbridge(\s|$)/.test(line);
}

export type Health = { bridgeVersion: string; protocol: { version: number } };

// The bridge's /health reply, or null when nothing answers there as an anynotate bridge.
export async function readHealth(port: number, timeoutMs = 1000): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = res.ok ? await res.json() : null;
    return body?.ok === true ? { bridgeVersion: String(body.bridgeVersion), protocol: { version: Number(body.protocol?.version) } } : null;
  } catch {
    return null;
  }
}

export const bridgeAnswers = async (port: number, timeoutMs = 1000): Promise<boolean> => (await readHealth(port, timeoutMs)) !== null;

export function readPid(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(join(dataDir, PID_FILE), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const removePidFile = (dataDir: string) => rmSync(join(dataDir, PID_FILE), { force: true });

// The detached bridge owns its pid file: it writes it once listening and removes it on the way out,
// unless a newer bridge has already claimed the file.
export function claimPidFile(dataDir: string): void {
  makePrivateDir(dataDir);
  writePrivateFile(join(dataDir, PID_FILE), `${process.pid}\n`);
  process.on("exit", () => {
    if (readPid(dataDir) === process.pid) removePidFile(dataDir);
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(100);
  }
  return check();
}

// Starts `argv` (the bridge command plus `bridge --pid-file`) in its own session with output appended to the log,
// for hosts without a service manager that keeps it running: Windows logon and Linux desktops without user systemd.
export async function detachBridge(c: Control, argv: string[], startTimeoutMs = 10_000): Promise<number> {
  const answers = answersOf(c);
  if (await answers(c.port)) {
    c.log(`bridge already running on http://127.0.0.1:${c.port}`);
    return 0;
  }
  makePrivateDir(c.dataDir);
  const fd = openSync(c.logPath, "a", 0o600);
  let exited: number | null = null;
  try {
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
    child.on("exit", (code) => { exited = code ?? 1; });
    child.on("error", () => { exited = 127; });
    child.unref();
    const up = await until(async () => exited !== null || (await answers(c.port)), startTimeoutMs);
    if (up && exited === null) {
      c.log(`bridge started on http://127.0.0.1:${c.port} (pid ${child.pid})`);
      return 0;
    }
    // Our child lost the port to a bridge started at the same moment: one is running, which is what was asked.
    if (exited !== null && (await answers(c.port))) {
      c.log(`bridge already running on http://127.0.0.1:${c.port}`);
      return 0;
    }
  } finally {
    closeSync(fd);
  }
  c.err(`anynotate: the bridge did not start${exited !== null ? ` (exit ${exited})` : ""}; see ${c.logPath}`);
  return 1;
}

// For callers that run on every start of something else (herdr's startup hook): a no-op when a bridge answers or an
// installed service owns the bridge, so a second bridge is never started next to the service's.
export async function ensureBridge(c: Control, argv: string[], serviceFile: string | null): Promise<number> {
  if (await answersOf(c)(c.port)) {
    c.log(`bridge already running on http://127.0.0.1:${c.port}`);
    return 0;
  }
  if (serviceFile !== null) {
    c.log(`bridge not answering, but it is managed by the service in ${serviceFile}; not starting another`);
    return 0;
  }
  return detachBridge(c, argv);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// A pid file can outlive its bridge and the pid be reused, so nothing is killed unless a bridge answers on the port
// and the pid's command line is an anynotate bridge.
export async function stopBridge(c: Control, stopTimeoutMs = 5000): Promise<number> {
  const answers = answersOf(c);
  const pid = readPid(c.dataDir);
  if (pid === null) {
    if (await answers(c.port)) {
      c.err(`anynotate: ${SERVICE_MANAGED}`);
      return 1;
    }
    c.log("bridge not running (no pid file)");
    return 0;
  }
  const up = await answers(c.port);
  if (!up || !alive(pid) || !isBridgeProcess(pid, c.platform, c.exec)) {
    removePidFile(c.dataDir);
    if (up) {
      c.err(`anynotate: removed a stale pid file; ${SERVICE_MANAGED}`);
      return 1;
    }
    c.log("bridge not running (removed a stale pid file)");
    return 0;
  }
  try {
    process.kill(pid);
  } catch (e) {
    c.err(`anynotate: could not stop pid ${pid}: ${(e as Error).message}`);
    return 1;
  }
  if (!(await until(async () => !alive(pid) && !(await answers(c.port, 300)), stopTimeoutMs))) {
    c.err(`anynotate: pid ${pid} is still running`);
    return 1;
  }
  removePidFile(c.dataDir);
  c.log(`bridge stopped (pid ${pid})`);
  return 0;
}

export async function bridgeStatus(c: Control): Promise<number> {
  if (!(await answersOf(c)(c.port))) {
    c.log("bridge not running");
    return 1;
  }
  const pid = readPid(c.dataDir);
  if (pid !== null && alive(pid) && isBridgeProcess(pid, c.platform, c.exec)) c.log(`bridge running on http://127.0.0.1:${c.port} (pid ${pid})`);
  else c.log(`bridge running on http://127.0.0.1:${c.port}; ${SERVICE_MANAGED}`);
  return 0;
}
