import { expect, test } from "bun:test";
import { LAUNCHD_LABEL as INSTALL_LABEL } from "../src/agent/install";
import type { Exec, ExecResult } from "../src/platform/exec";
import {
  detectUserSystemd,
  LAUNCHD_LABEL,
  planService,
  runSteps,
  SYSTEMD_UNIT,
  WINDOWS_TASK,
  type ServicePlan,
} from "../src/platform/service";

const BIN = "/home/me/.local/bin/anynotate";
const base = { env: {}, exe: [BIN], logPath: "/home/me/.anynotate/bridge.log", dataDir: "/home/me/.anynotate", uid: 501, hasUserSystemd: true };

const fakeExec = (codes: Record<string, number> = {}) => {
  const calls: string[][] = [];
  const exec: Exec = (argv): ExecResult => {
    calls.push(argv);
    return { code: codes[argv.join(" ")] ?? 0, stdout: "", stderr: "boom" };
  };
  return { exec, calls };
};

test("names are fixed and install.ts re-exports the launchd label", () => {
  expect(LAUNCHD_LABEL).toBe("dev.anynotate.bridge");
  expect(INSTALL_LABEL).toBe(LAUNCHD_LABEL);
  expect(SYSTEMD_UNIT).toBe("anynotate-bridge.service");
  expect(WINDOWS_TASK).toBe("Anynotate Bridge");
});

test("darwin: a LaunchAgent plist and launchctl bootstrap", () => {
  const exe = ["/Users/me/.local/bin/anynotate"];
  const plan = planService({ ...base, platform: "darwin", home: "/Users/me", exe, logPath: "/Users/me/.anynotate/bridge.log" });
  const plist = "/Users/me/Library/LaunchAgents/dev.anynotate.bridge.plist";
  expect(plan.files.map((f) => f.path)).toEqual([plist]);
  const c = plan.files[0]!.content;
  expect(c).toContain("<key>Label</key><string>dev.anynotate.bridge</string>");
  expect(c).toContain("<string>/Users/me/.local/bin/anynotate</string>\n    <string>bridge</string>");
  expect(c).toContain("<key>RunAtLoad</key><true/>");
  expect(c).toContain("<key>KeepAlive</key><true/>");
  expect(c).toContain("<key>StandardOutPath</key><string>/Users/me/.anynotate/bridge.log</string>");
  expect(c).toContain("<key>StandardErrorPath</key><string>/Users/me/.anynotate/bridge.log</string>");
  expect(c).toContain("<key>PATH</key><string>/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>");
  expect(plan.start).toEqual([
    ["launchctl", "bootout", "gui/501/dev.anynotate.bridge"],
    ["launchctl", "bootstrap", "gui/501", plist],
    ["launchctl", "kickstart", "-k", "gui/501/dev.anynotate.bridge"],
  ]);
  expect(plan.stop).toEqual([["launchctl", "bootout", "gui/501/dev.anynotate.bridge"]]);
  expect(plan.remove).toEqual([["launchctl", "bootout", "gui/501/dev.anynotate.bridge"]]);
  expect(plan.status).toEqual(["launchctl", "print", "gui/501/dev.anynotate.bridge"]);
});

test("darwin: a source install runs bun with cli.ts, and values are XML-escaped", () => {
  const plan = planService({ ...base, platform: "darwin", home: "/Users/me", exe: ["/opt/bun/bin/bun", "/src/R&D <x>/cli.ts"] });
  const c = plan.files[0]!.content;
  expect(c).toContain("<string>/opt/bun/bin/bun</string>\n    <string>/src/R&amp;D &lt;x&gt;/cli.ts</string>\n    <string>bridge</string>");
  expect(c).toContain("<string>/opt/bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>");
  expect(c).not.toContain("R&D");
});

test("linux with user systemd: a user unit and systemctl --user", () => {
  const plan = planService({ ...base, platform: "linux", home: "/home/me" });
  const unit = "/home/me/.config/systemd/user/anynotate-bridge.service";
  expect(plan.files.map((f) => f.path)).toEqual([unit]);
  const c = plan.files[0]!.content;
  expect(c).toContain("[Unit]\nDescription=Anynotate bridge");
  expect(c).toContain(`[Service]\nExecStart=${BIN} bridge`);
  expect(c).toContain("Environment=PATH=/home/me/.local/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin\n");
  expect(c).toContain("Restart=on-failure");
  expect(c).toContain("StandardOutput=append:/home/me/.anynotate/bridge.log");
  expect(c).toContain("StandardError=append:/home/me/.anynotate/bridge.log");
  expect(c).toContain("[Install]\nWantedBy=default.target");
  expect(plan.start).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
    ["systemctl", "--user", "restart", SYSTEMD_UNIT],
  ]);
  expect(plan.stop).toEqual([["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]]);
  expect(plan.remove).toEqual([["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]]);
  expect(plan.status).toEqual(["systemctl", "--user", "is-active", SYSTEMD_UNIT]);
});

test("linux: ExecStart quotes arguments with spaces and escapes specifiers", () => {
  const plan = planService({ ...base, platform: "linux", home: "/home/me", exe: ["/home/me/my bun/bun", '/src/a"b/100%/cli.ts'] });
  expect(plan.files[0]!.content).toContain('ExecStart="/home/me/my bun/bun" "/src/a\\"b/100%%/cli.ts" bridge\n');
});

test("linux: the unit's PATH starts with the executable's directory, quoted and escaped for systemd", () => {
  const plan = planService({ ...base, platform: "linux", home: "/home/me", exe: ['/home/me/my "bun"/100%/bun', "/src/cli.ts"] });
  expect(plan.files[0]!.content).toContain(
    'Environment="PATH=/home/me/my \\"bun\\"/100%%:%h/.local/bin:/usr/local/bin:/usr/bin:/bin"\n',
  );
});

test("linux: XDG_CONFIG_HOME is honoured only when absolute and non-blank", () => {
  const at = (XDG_CONFIG_HOME: string) =>
    planService({ ...base, platform: "linux", home: "/home/me", env: { XDG_CONFIG_HOME } }).files[0]!.path;
  expect(at("/xdg")).toBe("/xdg/systemd/user/anynotate-bridge.service");
  expect(at("  ")).toBe("/home/me/.config/systemd/user/anynotate-bridge.service");
  expect(at("rel/xdg")).toBe("/home/me/.config/systemd/user/anynotate-bridge.service");
});

test("linux without user systemd: an XDG autostart entry and the bridge's own detach/stop/status", () => {
  const plan = planService({ ...base, platform: "linux", home: "/home/me", hasUserSystemd: false, env: { XDG_CONFIG_HOME: "/xdg" } });
  expect(plan.files.map((f) => f.path)).toEqual(["/xdg/autostart/anynotate-bridge.desktop"]);
  const c = plan.files[0]!.content;
  expect(c).toContain("[Desktop Entry]");
  expect(c).toContain(`Exec=${BIN} bridge --detach\n`);
  expect(c).toContain("X-GNOME-Autostart-enabled=true");
  expect(plan.start).toEqual([
    [BIN, "bridge", "--stop"],
    [BIN, "bridge", "--detach"],
  ]);
  expect(plan.stop).toEqual([[BIN, "bridge", "--stop"]]);
  expect(plan.remove).toEqual([[BIN, "bridge", "--stop"]]);
  expect(plan.status).toEqual([BIN, "bridge", "--status"]);
});

test("linux autostart: Exec quotes arguments per the desktop-entry spec", () => {
  const plan = planService({ ...base, platform: "linux", home: "/home/me", hasUserSystemd: false, exe: ["/home/me/my bun/bun", "/src/50%/a$b/cli.ts"] });
  expect(plan.files[0]!.content).toContain('Exec="/home/me/my bun/bun" "/src/50%%/a\\\\$b/cli.ts" bridge --detach\n');
});

const WIN = { ...base, platform: "win32" as const, home: "C:\\Users\\me", dataDir: "C:\\Users\\me\\.anynotate", logPath: "C:\\Users\\me\\.anynotate\\bridge.log" };

const RUN = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

test("win32: a hidden UTF-16 vbs launcher registered under the per-user Run key", () => {
  const exe = "C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe";
  const plan = planService({ ...WIN, exe: [exe], env: { SystemRoot: "D:\\Win" } });
  const vbs = "C:\\Users\\me\\.anynotate\\bridge.vbs";
  expect(plan.files.map((f) => [f.path, f.encoding])).toEqual([[vbs, "utf16le-bom"]]);
  expect(plan.files[0]!.content).toContain(`CreateObject("WScript.Shell").Run """${exe}"" bridge --detach", 0, False`);
  const wscript = "D:\\Win\\System32\\wscript.exe";
  expect(plan.start).toEqual([
    [exe, "bridge", "--stop"],
    ["reg", "add", RUN, "/v", "Anynotate Bridge", "/t", "REG_SZ", "/d", `"${wscript}" "${vbs}"`, "/f"],
    [wscript, vbs],
  ]);
  expect(plan.stop).toEqual([[exe, "bridge", "--stop"]]);
  expect(plan.remove).toEqual([
    [exe, "bridge", "--stop"],
    ["reg", "delete", RUN, "/v", "Anynotate Bridge", "/f"],
  ]);
  expect(plan.status).toEqual([exe, "bridge", "--status"]);
});

test("win32: wscript comes from SYSTEMROOT, then C:\\Windows", () => {
  const wscript = (env: Record<string, string>) => planService({ ...WIN, env }).start.at(-1)![0];
  expect(wscript({ SYSTEMROOT: "E:\\W" })).toBe("E:\\W\\System32\\wscript.exe");
  expect(wscript({})).toBe("C:\\Windows\\System32\\wscript.exe");
});

test("win32: a source install quotes each exe element in the vbs", () => {
  const plan = planService({ ...WIN, exe: ["C:\\Program Files\\bun\\bun.exe", "C:\\src\\cli.ts"] });
  expect(plan.files[0]!.content).toContain(
    'CreateObject("WScript.Shell").Run """C:\\Program Files\\bun\\bun.exe"" ""C:\\src\\cli.ts"" bridge --detach", 0, False',
  );
});

test("detectUserSystemd asks systemctl --user show-environment", () => {
  const ok = fakeExec();
  expect(detectUserSystemd(ok.exec)).toBe(true);
  expect(ok.calls).toEqual([["systemctl", "--user", "show-environment"]]);
  expect(detectUserSystemd(fakeExec({ "systemctl --user show-environment": 1 }).exec)).toBe(false);
});

const darwinPlan = (): ServicePlan => planService({ ...base, platform: "darwin", home: "/Users/me" });

test("runSteps tolerates a failed bootout and bootstrap when kickstart succeeds", () => {
  const { start } = darwinPlan();
  const f = fakeExec({ [start[0]!.join(" ")]: 3, [start[1]!.join(" ")]: 5 });
  const pauses: number[] = [];
  const r = runSteps(start, f.exec, false, undefined, { pause: (ms) => pauses.push(ms) });
  expect(r.ok).toBe(true);
  expect(f.calls).toEqual([start[0]!, start[1]!, start[1]!, start[1]!, start[1]!, start[2]!]);
  expect(pauses).toEqual([500, 500, 500]);
  expect(r.log.filter((l) => l.startsWith("retrying (exit 5): launchctl bootstrap"))).toHaveLength(3);
  expect(r.log).toContain(`ignored failure (exit 5): ${start[1]!.join(" ")}`);
});

test("runSteps retries bootstrap until it succeeds and retries nothing else", () => {
  const { start } = darwinPlan();
  const calls: string[][] = [];
  let bootstraps = 0;
  const exec: Exec = (argv) => {
    calls.push(argv);
    if (argv[1] === "bootstrap") return { code: ++bootstraps < 3 ? 5 : 0, stdout: "", stderr: "" };
    return { code: argv[1] === "bootout" ? 3 : 0, stdout: "", stderr: "" };
  };
  const pauses: number[] = [];
  const r = runSteps(start, exec, false, undefined, { pause: (ms) => pauses.push(ms), delayMs: 7 });
  expect(r.ok).toBe(true);
  expect(calls).toEqual([start[0]!, start[1]!, start[1]!, start[1]!, start[2]!]);
  expect(pauses).toEqual([7, 7]);
  expect(r.log).toContain(`ran: ${start[1]!.join(" ")}`);
});

test("runSteps fails when kickstart fails, even as the last step", () => {
  const { start } = darwinPlan();
  const f = fakeExec({ [start[2]!.join(" ")]: 1 });
  const r = runSteps(start, f.exec, false);
  expect(r.ok).toBe(false);
  expect(r.log.at(-1)).toContain("kickstart");
});

test("runSteps stops at the first intolerable failure", () => {
  const plan = planService({ ...base, platform: "linux", home: "/home/me" });
  const f = fakeExec({ [plan.start[0]!.join(" ")]: 1 });
  expect(runSteps(plan.start, f.exec, false).ok).toBe(false);
  expect(f.calls).toEqual([plan.start[0]!]);
});

test("runSteps on win32 remove tolerates a stopped bridge, skips a Run value reg query says is gone, and fails any delete error", () => {
  const plan = planService({ ...WIN, exe: ["C:\\a\\anynotate.exe"] });
  const [stop, del] = plan.remove;
  const query = ["reg", "query", RUN, "/v", "Anynotate Bridge"];
  const run = (queryCode: number, deleteCode: number) => {
    const calls: string[][] = [];
    const exec: Exec = (argv) => {
      calls.push(argv);
      const code = argv[1] === "query" ? queryCode : argv[1] === "delete" ? deleteCode : 1;
      return { code, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
    };
    const r = runSteps(plan.remove, exec, false);
    return { ok: r.ok, calls, log: r.log };
  };
  const gone = run(1, 0);
  expect(gone.ok).toBe(true);
  expect(gone.calls).toEqual([stop!, query]);
  expect(gone.log.at(-1)).toBe(`already gone: ${del!.join(" ")}`);
  expect(run(0, 0)).toMatchObject({ ok: true, calls: [stop!, query, del!] });
  expect(run(0, 1).ok).toBe(false);
  expect(stop!.join(" ")).toContain("--stop");
});

test("pid-managed starts replace a running bridge and tolerate one that is not running", () => {
  for (const plan of [planService({ ...base, platform: "linux", home: "/home/me", hasUserSystemd: false }), planService({ ...WIN, exe: ["C:\\a\\anynotate.exe"] })]) {
    expect(plan.start[0]!.slice(-2)).toEqual(["bridge", "--stop"]);
    const f = fakeExec({ [plan.start[0]!.join(" ")]: 1 });
    const r = runSteps(plan.start, f.exec, false);
    expect(r.ok).toBe(true);
    expect(f.calls).toEqual(plan.start);
  }
});

test("runSteps in dry-run mode only logs", () => {
  const { start } = darwinPlan();
  const f = fakeExec();
  const r = runSteps(start, f.exec, true);
  expect(r.ok).toBe(true);
  expect(f.calls).toEqual([]);
  expect(r.log).toHaveLength(3);
});

test("runSteps honours a custom tolerate predicate", () => {
  const f = fakeExec({ "x 1": 1 });
  expect(runSteps([["x", "1"], ["x", "2"]], f.exec, false, () => true).ok).toBe(true);
  expect(f.calls).toHaveLength(2);
});
