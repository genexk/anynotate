import { posix, win32 } from "node:path";
import { type Exec, type ExecResult, regQueryFor } from "./exec";
import type { Env, Platform } from "./os";

export const LAUNCHD_LABEL = "dev.anynotate.bridge";
export const SYSTEMD_UNIT = "anynotate-bridge.service";
export const WINDOWS_TASK = "Anynotate Bridge";

export type ServiceFile = { path: string; content: string; mode?: number; encoding?: "utf8" | "utf16le-bom" };
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

// launchd starts agents with a bare PATH; Homebrew's bin on Apple silicon holds tools the bridge drives, such as herdr.
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
  <dict><key>PATH</key><string>${xml(`${posix.dirname(o.exe[0]!)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string></dict>
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
Exec=${[...o.exe, "bridge", "--detach"].map(desktopArg).join(" ")}
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

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// The per-user Run key starts the bridge at logon without elevation; wscript running Run(..., 0) keeps the console
// window hidden, and the bridge detaches and manages its own pid file for stop/status. The script is written as
// UTF-16LE with a BOM, the encoding wscript reads non-ASCII profile paths correctly from.
function windows(o: ServiceOptions): ServicePlan {
  const path = win32.join(o.dataDir, "bridge.vbs");
  const wscript = win32.join(o.env.SystemRoot ?? o.env.SYSTEMROOT ?? "C:\\Windows", "System32", "wscript.exe");
  const command = `${o.exe.map((a) => `"${a}"`).join(" ")} bridge --detach`;
  const content = `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
  const stop = [...o.exe, "bridge", "--stop"];
  return {
    files: [{ path, content, encoding: "utf16le-bom" }],
    start: [["reg", "add", RUN_KEY, "/v", WINDOWS_TASK, "/t", "REG_SZ", "/d", `"${wscript}" "${path}"`, "/f"], [wscript, path]],
    stop: [stop],
    remove: [stop, ["reg", "delete", RUN_KEY, "/v", WINDOWS_TASK, "/f"]],
    status: [...o.exe, "bridge", "--status"],
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

// Failures that leave the system in the state the step was after: unloading a service or stopping a bridge that
// isn't running. A bootstrap straight after bootout can fail with an I/O
// error while launchd finishes tearing down; the kickstart that follows is the step that must succeed.
export const tolerateNotRunning = (argv: string[], r: ExecResult): boolean =>
  (argv[0] === "launchctl" && (argv[1] === "bootout" || argv[1] === "bootstrap")) ||
  (argv.at(-2) === "bridge" && argv.at(-1) === "--stop");

export function runSteps(
  steps: string[][],
  exec: Exec,
  dryRun: boolean,
  tolerate: (argv: string[], r: ExecResult) => boolean = tolerateNotRunning,
): { log: string[]; ok: boolean } {
  const log: string[] = [];
  for (const argv of steps) {
    const line = argv.join(" ");
    if (dryRun) {
      log.push(`would run: ${line}`);
      continue;
    }
    // A registry value that is already gone is skipped; once it is known to exist, any delete failure is a failure.
    if (argv[0] === "reg" && argv[1] === "delete" && exec(regQueryFor(argv)).code === 1) {
      log.push(`already gone: ${line}`);
      continue;
    }
    const r = exec(argv);
    if (r.code === 0) {
      log.push(`ran: ${line}`);
    } else if (tolerate(argv, r)) {
      log.push(`ignored failure (exit ${r.code}): ${line}`);
    } else {
      log.push(`failed (exit ${r.code}): ${line}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
      return { log, ok: false };
    }
  }
  return { log, ok: true };
}
