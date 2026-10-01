import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeStatus, type Control, detachBridge, isBridgeProcess, SERVICE_MANAGED, stopBridge } from "../src/bridge/control";
import type { Exec } from "../src/platform/exec";

let dir: string;
let out: string[];
let errs: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anynotate-control-"));
  out = [];
  errs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const commandLine = (stdout: string, code = 0) => {
  const calls: string[][] = [];
  const exec: Exec = (argv) => {
    calls.push(argv);
    return { code, stdout, stderr: "" };
  };
  return { exec, calls };
};

const control = (o: Partial<Control> = {}): Control => ({
  dataDir: dir,
  logPath: join(dir, "bridge.log"),
  port: 1,
  log: (l) => out.push(l),
  err: (l) => errs.push(l),
  platform: "linux",
  answers: async () => true,
  ...o,
});

test("isBridgeProcess reads the command line with ps, or CIM on Windows", () => {
  const yes = commandLine("/opt/bun/bin/bun /home/me/anynotate/src/cli.ts bridge --pid-file\n");
  expect(isBridgeProcess(42, "linux", yes.exec)).toBe(true);
  expect(yes.calls).toEqual([["ps", "-o", "command=", "-p", "42"]]);
  expect(isBridgeProcess(42, "darwin", commandLine("sleep 30\n").exec)).toBe(false);
  expect(isBridgeProcess(42, "linux", commandLine("", 1).exec)).toBe(false);
  const win = commandLine('"C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe" bridge --pid-file\r\n');
  expect(isBridgeProcess(7, "win32", win.exec)).toBe(true);
  expect(win.calls[0]!.at(-1)).toBe('(Get-CimInstance Win32_Process -Filter "ProcessId=7").CommandLine');
  expect(isBridgeProcess(Number.NaN, "win32", win.exec)).toBe(false);
  expect(win.calls).toHaveLength(1);
});

test("stop does not kill a recycled pid whose command is not a bridge, and drops the pid file", async () => {
  const sleeper = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"]);
  try {
    writeFileSync(join(dir, "bridge.pid"), `${sleeper.pid}\n`);
    expect(await stopBridge(control({ exec: commandLine("bun -e setTimeout").exec }))).toBe(0);
    expect(out).toEqual(["bridge not running (removed a stale pid file)"]);
    expect(existsSync(join(dir, "bridge.pid"))).toBe(false);
    expect(sleeper.exitCode).toBeNull();
    expect(sleeper.killed).toBe(false);
  } finally {
    sleeper.kill();
  }
});

test("without a pid file, a bridge that answers belongs to the service: stop refuses, status reports it", async () => {
  expect(await stopBridge(control())).toBe(1);
  expect(errs).toEqual([`anynotate: ${SERVICE_MANAGED}`]);
  expect(await bridgeStatus(control())).toBe(0);
  expect(out.at(-1)).toContain(SERVICE_MANAGED);
  expect(await stopBridge(control({ answers: async () => false }))).toBe(0);
  expect(out.at(-1)).toBe("bridge not running (no pid file)");
});

test("detach succeeds when its child loses the port to a bridge that started at the same time", async () => {
  const marker = join(dir, "child-ran");
  let first = true;
  const answers = async () => {
    if (first) {
      first = false;
      return false;
    }
    if (!existsSync(marker)) return false;
    await Bun.sleep(300);
    return true;
  };
  const child = [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, ""); process.exit(3)`];
  expect(await detachBridge(control({ answers }), child, 5000)).toBe(0);
  expect(out).toEqual(["bridge already running on http://127.0.0.1:1"]);
  expect(errs).toEqual([]);
});

test("detach reports a child that exits while nothing answers", async () => {
  const child = [process.execPath, "-e", "process.exit(3)"];
  expect(await detachBridge(control({ answers: async () => false }), child, 5000)).toBe(1);
  expect(errs[0]).toBe(`anynotate: the bridge did not start (exit 3); see ${join(dir, "bridge.log")}`);
});
