import { posix, win32 } from "node:path";
import type { Exec } from "./exec";
import type { Env, Platform } from "./os";

export const LAUNCHD_LABEL = "dev.anynotate.bridge";
export const SYSTEMD_UNIT = "anynotate-bridge.service";
export const WINDOWS_TASK = "Anynotate Bridge";

export type ServiceFile = { path: string; content: string; mode?: number };
// start/stop/remove are command sequences for runSteps; status is a single command whose exit code answers "running?".
export type ServicePlan = { files: ServiceFile[]; start: string[][]; stop: string[][]; remove: string[][]; status: string[] };

export type ServiceOptions = {
  platform: Platform;
  home: string;
  env: Env;
  exe: string[];
  logPath: string;
  dataDir: string;
  uid: number;
  hasUserSystemd: boolean;
};

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// systemd command lines: % starts a specifier and $ a variable everywhere; quoting follows its C-style rules.
function systemdArg(a: string): string {
  const s = a.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /[\s"'\\]/.test(s) || s === "" ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;
}

// Desktop-entry Exec: reserved characters force double quotes, inside which " ` $ \ are backslash-escaped;
// the value is then a desktop-file string, where a literal backslash is itself written \\, and % is a field code.
function desktopArg(a: string): string {
  const quoted = /[\s"'\\><~|&;$*?#()`]/.test(a) || a === "" ? `"${a.replace(/["`$\\]/g, "\\$&")}"` : a;
  return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

const xdgConfigHome = (home: string, env: Env) => {
  const v = env.XDG_CONFIG_HOME?.trim();
  return v && posix.isAbsolute(v) ? v : posix.join(home, ".config");
};

function launchd(o: ServiceOptions): ServicePlan {
  const path = posix.join(o.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const args = [...o.exe, "bridge"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(`${posix.dirname(o.exe[0]!)}:/usr/local/bin:/usr/bin:/bin`)}</string></dict>
  <key>StandardOutPath</key><string>${xml(o.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(o.logPath)}</string>
</dict>
</plist>
`;
  const target = `gui/${o.uid}/${LAUNCHD_LABEL}`;
  const bootout = ["launchctl", "bootout", target];
  return {
    files: [{ path, content }],
    start: [bootout, ["launchctl", "bootstrap", `gui/${o.uid}`, path], ["launchctl", "kickstart", "-k", target]],
    stop: [bootout],
    remove: [bootout],
    status: ["launchctl", "print", target],
  };
}

function systemd(o: ServiceOptions): ServicePlan {
  const path = posix.join(xdgConfigHome(o.home, o.env), "systemd", "user", SYSTEMD_UNIT);
  const log = o.logPath.replace(/%/g, "%%");
  const content = `[Unit]
Description=Anynotate bridge

[Service]
ExecStart=${[...o.exe, "bridge"].map(systemdArg).join(" ")}
Restart=on-failure
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
  const disable = ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT];
  return {
    files: [{ path, content }],
    start: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
      ["systemctl", "--user", "restart", SYSTEMD_UNIT],
    ],
    stop: [disable],
    remove: [disable],
    status: ["systemctl", "--user", "is-active", SYSTEMD_UNIT],
  };
}

// No user systemd (containers, some WSL setups, non-systemd distros): the desktop session starts the bridge at
// login, and the bridge manages its own detached process for start/stop/status.
function autostart(o: ServiceOptions): ServicePlan {
  const path = posix.join(xdgConfigHome(o.home, o.env), "autostart", "anynotate-bridge.desktop");
  const content = `[Desktop Entry]
Type=Application
Name=Anynotate bridge
Exec=${[...o.exe, "bridge"].map(desktopArg).join(" ")}
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
  const stop = [...o.exe, "bridge", "--stop"];
  return {
    files: [{ path, content }],
    start: [[...o.exe, "bridge", "--detach"]],
    stop: [stop],
    remove: [stop],
    status: [...o.exe, "bridge", "--status"],
  };
}

// Task Scheduler starts a console program in a visible window; wscript running Run(..., 0) hides it.
function windows(o: ServiceOptions): ServicePlan {
  const path = win32.join(o.dataDir, "bridge.vbs");
  const command = `${o.exe.map((a) => `"${a}"`).join(" ")} bridge`;
  const content = `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
  const end = ["schtasks", "/End", "/TN", WINDOWS_TASK];
  return {
    files: [{ path, content }],
    start: [
      ["schtasks", "/Create", "/F", "/TN", WINDOWS_TASK, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", `wscript.exe "${path}"`],
      ["schtasks", "/Run", "/TN", WINDOWS_TASK],
    ],
    stop: [end],
    remove: [end, ["schtasks", "/Delete", "/F", "/TN", WINDOWS_TASK]],
    status: ["schtasks", "/Query", "/TN", WINDOWS_TASK],
  };
}

export function planService(o: ServiceOptions): ServicePlan {
  if (o.exe.length === 0) throw new Error("anynotate: service needs an executable");
  switch (o.platform) {
    case "darwin":
      return launchd(o);
    case "linux":
      return o.hasUserSystemd ? systemd(o) : autostart(o);
    case "win32":
      return windows(o);
  }
}

export const detectUserSystemd = (exec: Exec): boolean => exec(["systemctl", "--user", "show-environment"]).code === 0;

// Unloading a service that isn't loaded, or ending a task that isn't running, fails harmlessly.
export const tolerateNotRunning = (argv: string[]): boolean =>
  (argv[0] === "launchctl" && argv[1] === "bootout") || (argv[0] === "schtasks" && argv[1] === "/End");

export function runSteps(
  steps: string[][],
  exec: Exec,
  dryRun: boolean,
  tolerate: (argv: string[]) => boolean = tolerateNotRunning,
): { log: string[]; ok: boolean } {
  const log: string[] = [];
  for (const argv of steps) {
    const line = argv.join(" ");
    if (dryRun) {
      log.push(`would run: ${line}`);
      continue;
    }
    const r = exec(argv);
    if (r.code === 0) {
      log.push(`ran: ${line}`);
    } else if (tolerate(argv)) {
      log.push(`ignored failure (exit ${r.code}): ${line}`);
    } else {
      log.push(`failed (exit ${r.code}): ${line}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
      return { log, ok: false };
    }
  }
  return { log, ok: true };
}
