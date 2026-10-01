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
  expect(c).toContain("<key>PATH</key><string>/Users/me/.local/bin:/usr/local/bin:/usr/bin:/bin</string>");
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
  expect(c).toContain("<string>/opt/bun/bin:/usr/local/bin:/usr/bin:/bin</string>");
  expect(c).not.toContain("R&D");
});

test("linux with user systemd: a user unit and systemctl --user", () => {
  const plan = planService({ ...base, platform: "linux", home: "/home/me" });
  const unit = "/home/me/.config/systemd/user/anynotate-bridge.service";
  expect(plan.files.map((f) => f.path)).toEqual([unit]);
  const c = plan.files[0]!.content;
  expect(c).toContain("[Unit]\nDescription=Anynotate bridge");
  expect(c).toContain(`[Service]\nExecStart=${BIN} bridge`);
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
  expect(c).toContain(`Exec=${BIN} bridge\n`);
  expect(c).toContain("X-GNOME-Autostart-enabled=true");
  expect(plan.start).toEqual([[BIN, "bridge", "--detach"]]);
  expect(plan.stop).toEqual([[BIN, "bridge", "--stop"]]);
  expect(plan.remove).toEqual([[BIN, "bridge", "--stop"]]);
  expect(plan.status).toEqual([BIN, "bridge", "--status"]);
});

test("linux autostart: Exec quotes arguments per the desktop-entry spec", () => {
  const plan = planService({ ...base, platform: "linux", home: "/home/me", hasUserSystemd: false, exe: ["/home/me/my bun/bun", "/src/50%/a$b/cli.ts"] });
  expect(plan.files[0]!.content).toContain('Exec="/home/me/my bun/bun" "/src/50%%/a\\\\$b/cli.ts" bridge\n');
});

const WIN = { ...base, platform: "win32" as const, home: "C:\\Users\\me", dataDir: "C:\\Users\\me\\.anynotate", logPath: "C:\\Users\\me\\.anynotate\\bridge.log" };

test("win32: a hidden vbs launcher and a Task Scheduler logon task", () => {
  const exe = "C:\\Users\\me\\AppData\\Local\\anynotate\\bin\\anynotate.exe";
  const plan = planService({ ...WIN, exe: [exe] });
  const vbs = "C:\\Users\\me\\.anynotate\\bridge.vbs";
  expect(plan.files.map((f) => f.path)).toEqual([vbs]);
  expect(plan.files[0]!.content).toContain(`CreateObject("WScript.Shell").Run """${exe}"" bridge", 0, False`);
  expect(plan.start).toEqual([
    ["schtasks", "/Create", "/F", "/TN", "Anynotate Bridge", "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", `wscript.exe "${vbs}"`],
    ["schtasks", "/Run", "/TN", "Anynotate Bridge"],
  ]);
  expect(plan.stop).toEqual([["schtasks", "/End", "/TN", "Anynotate Bridge"]]);
  expect(plan.remove).toEqual([
    ["schtasks", "/End", "/TN", "Anynotate Bridge"],
    ["schtasks", "/Delete", "/F", "/TN", "Anynotate Bridge"],
  ]);
  expect(plan.status).toEqual(["schtasks", "/Query", "/TN", "Anynotate Bridge"]);
});

test("win32: a source install quotes each exe element in the vbs", () => {
  const plan = planService({ ...WIN, exe: ["C:\\Program Files\\bun\\bun.exe", "C:\\src\\cli.ts"] });
  expect(plan.files[0]!.content).toContain(
    'CreateObject("WScript.Shell").Run """C:\\Program Files\\bun\\bun.exe"" ""C:\\src\\cli.ts"" bridge", 0, False',
  );
});

test("detectUserSystemd asks systemctl --user show-environment", () => {
  const ok = fakeExec();
  expect(detectUserSystemd(ok.exec)).toBe(true);
  expect(ok.calls).toEqual([["systemctl", "--user", "show-environment"]]);
  expect(detectUserSystemd(fakeExec({ "systemctl --user show-environment": 1 }).exec)).toBe(false);
});

const darwinPlan = (): ServicePlan => planService({ ...base, platform: "darwin", home: "/Users/me" });

test("runSteps tolerates a failed bootout and stops at the first other failure", () => {
  const { start } = darwinPlan();
  const bootout = start[0]!.join(" ");
  const bootstrap = start[1]!.join(" ");
  const f = fakeExec({ [bootout]: 3, [bootstrap]: 5 });
  const r = runSteps(start, f.exec, false);
  expect(r.ok).toBe(false);
  expect(f.calls).toEqual([start[0]!, start[1]!]);
  expect(r.log.join("\n")).toContain("bootstrap");
});

test("runSteps runs everything when all succeed, and tolerates schtasks /End", () => {
  const plan = planService({ ...WIN, exe: ["C:\\a\\anynotate.exe"] });
  const f = fakeExec({ [plan.remove[0]!.join(" ")]: 1 });
  const r = runSteps(plan.remove, f.exec, false);
  expect(r.ok).toBe(true);
  expect(f.calls).toEqual(plan.remove);
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
