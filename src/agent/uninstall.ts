import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";
import type { Exec, ExecResult } from "../platform/exec";
import { applyHostSteps, cmdArgv, type HostStep, isRegistryStep, planNativeHostRemoval, sourceHostWrapper } from "../platform/nativehost";
import { type Env, exeName, installPaths, pathFor, type Platform } from "../platform/os";
import { planService, runSteps, tolerateNotRunning } from "../platform/service";
import { HOOKED_CLIS, isAnynotateHook, removeHook } from "./install";
import { commandArgv, INSTALL_RECORD, type InstallKind, type InstallRecord } from "./installkind";

export type UninstallStep =
  | { action: "run"; path: string; argv: string[][] }
  | { action: "remove-file"; path: string }
  | { action: "remove-hook"; path: string; agent: string }
  | { action: "remove-dir"; path: string }
  | { action: "native-host"; path: string; host: HostStep }
  | { action: "remove-symlink"; path: string; into: string }
  | { action: "remove-shim"; path: string; content: string }
  | { action: "remove-binary"; path: string }
  | { action: "rename-binary"; path: string; to: string }
  | { action: "remove-path-entry"; path: string }
  | { action: "purge"; path: string; home: string }
  | { action: "keep-data"; path: string };

export type UninstallOptions = {
  platform: Platform;
  home: string;
  env: Env;
  // What install.json says was installed; null when it is missing or unreadable, and kind (this process) stands in.
  record: InstallRecord | null;
  kind: InstallKind;
  purge: boolean;
  uid: number;
  hasUserSystemd: boolean;
};

// The install that is being removed: install.json's when there is one, otherwise the one running this command.
function installedKind(record: InstallRecord | null, kind: InstallKind): InstallKind {
  if (!record) return kind;
  if (record.kind === "binary") return { kind: "binary", exe: record.path };
  return { kind: "source", repo: record.path, bun: kind.kind === "source" ? kind.bun : "" };
}

export function planUninstall(o: UninstallOptions): UninstallStep[] {
  const { platform, home, env } = o;
  const path = pathFor(platform);
  const paths = installPaths(platform, home, env);
  const { dataDir } = paths;
  const installed = installedKind(o.record, o.kind);

  // The running command stops the bridge, whichever kind of install this is.
  const serviceFor = (hasUserSystemd: boolean) =>
    planService({ platform, home, env, exe: commandArgv(o.kind), logPath: paths.logPath, dataDir, uid: o.uid, hasUserSystemd });
  // On Linux an earlier install may have used the other mechanism, so both sets of files go. Without user systemd
  // there is no systemctl to run; with it, a bridge an autostart entry detached is stopped as well.
  const systemd = platform === "linux" && o.hasUserSystemd;
  const primary = serviceFor(o.hasUserSystemd);
  const services = platform === "linux" ? [primary, serviceFor(!o.hasUserSystemd)] : [primary];
  const serviceSteps: UninstallStep[] = [
    { action: "run", path: "service", argv: systemd ? services.flatMap((s) => s.remove) : primary.remove },
    ...services.flatMap((s) => s.files.map((f): UninstallStep => ({ action: "remove-file", path: f.path }))),
    ...(systemd ? [{ action: "run", path: "service", argv: [["systemctl", "--user", "daemon-reload"]] } satisfies UninstallStep] : []),
  ];

  const hooks = HOOKED_CLIS.flatMap(({ cli, settings, skill }): UninstallStep[] => [
    { action: "remove-hook", path: path.join(home, ...settings.split("/")), agent: cli },
    { action: "remove-dir", path: path.dirname(path.join(home, ...skill.split("/"))) },
  ]);

  const host = planNativeHostRemoval({ platform, home, env, hostPath: "", dataDir, exists: existsSync }).map(
    (h): UninstallStep => ({ action: "native-host", path: "key" in h ? h.key : h.path, host: h }),
  );
  const wrapper: UninstallStep[] =
    installed.kind === "source" ? [{ action: "remove-file", path: sourceHostWrapper(platform, installed.bun, installed.repo, dataDir).path }] : [];

  return [
    ...serviceSteps,
    ...hooks,
    ...host,
    ...wrapper,
    { action: "remove-file", path: path.join(dataDir, INSTALL_RECORD) },
    ...binarySteps(platform, installed, paths.binDir, paths.binPath),
    o.purge ? { action: "purge", path: dataDir, home } : { action: "keep-data", path: dataDir },
  ];
}

// A running Windows program can't be deleted, so the binary is renamed aside (its dir stays) and the next install
// or a manual delete clears it. A source install never touches the clone, only what links it onto PATH.
function binarySteps(platform: Platform, k: InstallKind, binDir: string, binPath: string): UninstallStep[] {
  const path = pathFor(platform);
  if (k.kind === "binary") {
    if (path.basename(k.exe) !== exeName(platform)) return [];
    if (platform !== "win32") return [{ action: "remove-binary", path: k.exe }];
    return [
      { action: "rename-binary", path: k.exe, to: `${k.exe}.old` },
      { action: "remove-path-entry", path: path.dirname(k.exe) },
    ];
  }
  if (platform === "win32") {
    return [{ action: "remove-shim", path: path.join(binDir, "anynotate.cmd"), content: `@${cmdArgv(commandArgv(k))} %*\r\n` }];
  }
  return [{ action: "remove-symlink", path: binPath, into: k.repo }];
}

// Reads the bin dir from the environment so no path is ever spliced into the script text. Comparison is
// case-insensitive (PowerShell's -ne) and ignores a trailing backslash; the value is only written when it changes.
const REMOVE_PATH_ENTRY = [
  "$d = $env:ANYNOTATE_BIN_DIR.TrimEnd('\\')",
  "$p = [Environment]::GetEnvironmentVariable('Path', 'User')",
  "if ($p) {",
  "  $parts = @($p -split ';' | Where-Object { $_ })",
  "  $kept = @($parts | Where-Object { $_.TrimEnd('\\') -ne $d })",
  "  if ($kept.Count -ne $parts.Count) { [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User') }",
  "}",
].join("\n");

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

// Service removal is best effort: a unit or Run value that is already gone is the state we want.
const tolerate = (argv: string[], r: ExecResult) => tolerateNotRunning(argv, r) || argv[0] === "systemctl";

function purgeRefusal(dir: string, home: string): string | null {
  if (!isAbsolute(dir)) return "it is not an absolute path";
  const stat = lstatOrNull(dir);
  if (!stat) return "it does not exist";
  if (stat.isSymbolicLink()) return "it is a symlink";
  if (!stat.isDirectory()) return "it is not a directory";
  if (resolve(dir) === resolve(home) || parse(resolve(dir)).root === resolve(dir)) return "it is your home or a root directory";
  if (!lstatOrNull(`${dir}${sep}token`)?.isFile()) return "it holds no token, so it does not look like an anynotate data dir";
  return null;
}

export type UninstallApplyOptions = {
  // Remove files but run no external command (service, registry, user PATH): those steps are only reported.
  externalDryRun?: boolean;
  backupSuffix?: string;
};

export function applyUninstall(steps: UninstallStep[], exec: Exec, dryRun: boolean, o: UninstallApplyOptions = {}): string[] {
  const { externalDryRun = false, backupSuffix = ".bak-anynotate" } = o;
  const log: string[] = [];
  let failed = false;
  let dataLine = "";
  const fail = (line: string) => {
    failed = true;
    log.push(line);
  };
  for (const s of steps) {
    try {
      switch (s.action) {
        case "run": {
          const r = runSteps(s.argv, exec, dryRun || externalDryRun, tolerate);
          log.push(...r.log);
          if (!r.ok) failed = true;
          break;
        }
        case "remove-file": {
          if (!lstatOrNull(s.path)) break;
          if (dryRun) { log.push(`would remove ${s.path}`); break; }
          rmSync(s.path, { force: true });
          log.push(`removed ${s.path}`);
          break;
        }
        case "remove-dir": {
          if (!lstatOrNull(s.path)) break;
          if (dryRun) { log.push(`would remove ${s.path}`); break; }
          rmSync(s.path, { recursive: true, force: true });
          log.push(`removed ${s.path}`);
          break;
        }
        case "remove-hook": {
          if (!existsSync(s.path)) break;
          let config: unknown;
          try {
            config = JSON.parse(readFileSync(s.path, "utf8"));
          } catch {
            if (readFileSync(s.path, "utf8").includes(`hook --agent ${s.agent}`)) log.push(`skip    ${s.path} (not valid JSON — remove the anynotate hook by hand)`);
            break;
          }
          const r = removeHook(config, (c) => isAnynotateHook(c, s.agent));
          if (!r.changed) break;
          if (dryRun) { log.push(`would remove the ${s.agent} hook from ${s.path}`); break; }
          copyFileSync(s.path, `${s.path}${backupSuffix}`);
          writeFileSync(s.path, `${JSON.stringify(r.config, null, 2)}\n`);
          log.push(`removed the ${s.agent} hook from ${s.path}`);
          break;
        }
        case "native-host":
          log.push(...applyHostSteps([s.host], exec, dryRun || (externalDryRun && isRegistryStep(s.host))));
          break;
        case "remove-symlink": {
          const stat = lstatOrNull(s.path);
          if (!stat) break;
          const target = stat.isSymbolicLink() ? resolve(dirname(s.path), readlinkSync(s.path)) : null;
          if (!target || !(target === s.into || target.startsWith(`${s.into}${sep}`))) {
            log.push(`skip    ${s.path} (not a link into ${s.into} — left alone)`);
            break;
          }
          if (dryRun) { log.push(`would remove ${s.path}`); break; }
          rmSync(s.path);
          log.push(`removed ${s.path}`);
          break;
        }
        case "remove-shim": {
          if (!lstatOrNull(s.path)?.isFile()) break;
          if (readFileSync(s.path, "utf8") !== s.content) { log.push(`skip    ${s.path} (changed since install — left alone)`); break; }
          if (dryRun) { log.push(`would remove ${s.path}`); break; }
          rmSync(s.path);
          log.push(`removed ${s.path}`);
          break;
        }
        case "remove-binary": {
          const stat = lstatOrNull(s.path);
          if (!stat) break;
          if (!stat.isFile() && !stat.isSymbolicLink()) { log.push(`skip    ${s.path} (not a file — left alone)`); break; }
          if (dryRun) { log.push(`would remove ${s.path}`); break; }
          rmSync(s.path);
          log.push(`removed ${s.path}`);
          break;
        }
        case "rename-binary": {
          if (!lstatOrNull(s.path)?.isFile()) break;
          if (dryRun) { log.push(`would rename ${s.path} → ${s.to}`); break; }
          rmSync(s.to, { force: true });
          renameSync(s.path, s.to);
          log.push(`renamed ${s.path} → ${s.to} (Windows can't delete a running program; delete it once this command exits)`);
          break;
        }
        case "remove-path-entry": {
          if (dryRun || externalDryRun) { log.push(`would remove ${s.path} from the user PATH`); break; }
          const r = exec(["powershell", "-NoProfile", "-NonInteractive", "-Command", REMOVE_PATH_ENTRY], undefined, { ANYNOTATE_BIN_DIR: s.path });
          if (r.code === 0) log.push(`removed ${s.path} from the user PATH`);
          else fail(`failed (exit ${r.code}): removing ${s.path} from the user PATH${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
          break;
        }
        case "purge": {
          const why = purgeRefusal(s.path, s.home);
          if (why) {
            log.push(`refused to delete ${s.path}: ${why}`);
            dataLine = `Anynotate removed. ${s.path} was left in place (see above).`;
            break;
          }
          if (dryRun) { log.push(`would delete ${s.path}`); break; }
          rmSync(s.path, { recursive: true, force: true });
          log.push(`deleted ${s.path}`);
          dataLine = `Anynotate removed, including ${s.path}.`;
          break;
        }
        case "keep-data":
          dataLine = `Anynotate removed. Your notes are still in ${s.path} (use --purge to delete them).`;
          break;
      }
    } catch (err) {
      fail(`failed: ${s.action} ${s.path}: ${(err as Error).message}`);
    }
  }
  if (dryRun) log.push("Dry run: nothing was changed.");
  else if (failed) log.push("Anynotate uninstall finished with errors (see above).");
  else if (dataLine) log.push(dataLine);
  return log;
}
