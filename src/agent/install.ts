import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { addOrigin, ORIGIN_RE, readOrigins } from "../bridge/origins";
import type { Exec } from "../platform/exec";
import { makePrivateDir, writePrivateFile } from "../platform/files";
import { applyHostSteps, cmdArgv, type HostStep, isRegistryStep, planNativeHost, sourceHostWrapper } from "../platform/nativehost";
import { currentPlatform, type Env, installPaths, pathFor, type Platform } from "../platform/os";
import { LAUNCHD_LABEL, planService, runSteps, type ServiceFile } from "../platform/service";
import { ADD_PATH_ENTRY, runPathEntry } from "../platform/userpath";
import { EMBEDDED_ASSETS } from "./assets";
import { commandArgv, formatInstallRecord, INSTALL_RECORD, type InstallKind, type InstallRecord, quoteArgv } from "./installkind";

export type InstallStep = {
  path: string;
  action:
    | "write"
    | "merge-json"
    | "symlink"
    | "private-dir"
    | "skip"
    | "remove-hook"
    | "remove-file"
    | "origin"
    | "native-host"
    | "record"
    | "run"
    | "path-entry";
  content: string;
  mode?: number;
  encoding?: ServiceFile["encoding"];
  host?: HostStep;
  argv?: string[][];
};

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

// Commands an earlier install wrote for this agent: nothing but our executable followed by ` hook --agent X`. The
// executable is one token naming anynotate or anynotate.exe (the bare command of older versions, a binary or the
// clone's launcher, wherever it lived) or bun followed by cli.ts. Compound commands such as `x && anynotate …` are
// the user's own and never match.
const TOKEN = String.raw`(?:"[^"]*"|[^\s"]+)`;
// Shell syntax inside a token (even a quoted one, where $( and ` still expand) makes it something other than a path.
const SHELL_META = /[;&|`$<>()]/;
const baseName = (token: string) => token.replace(/^"|"$/g, "").split(/[\\/]/).pop() ?? "";

export function isAnynotateHook(command: unknown, agent: string): boolean {
  if (typeof command !== "string" || !/^[\w.-]+$/.test(agent)) return false;
  const m = new RegExp(`^(${TOKEN})(?: (${TOKEN}))? hook --agent ${agent.replace(/\./g, "\\.")}$`).exec(command);
  if (!m) return false;
  const [, first, second] = m as unknown as [string, string, string | undefined];
  if ([first, second].some((t) => t !== undefined && SHELL_META.test(t))) return false;
  if (second === undefined) return /^anynotate(\.exe)?$/.test(baseName(first));
  return /^bun(\.exe)?$/.test(baseName(first)) && baseName(second) === "cli.ts";
}

// A config whose shape we don't recognise is reported as unmergeable rather than rewritten. A stale entry of ours is
// rewritten in place, so a reinstall replaces the old hook instead of adding a second one.
export function addHook(
  config: any,
  event: string,
  command: string,
  isStale: (command: unknown) => boolean = () => false,
): { config: any; changed: boolean; unmergeable?: true } {
  const next = structuredClone(config ?? {});
  if (!isObject(next)) return { config, changed: false, unmergeable: true };
  next.hooks ??= {};
  if (!isObject(next.hooks)) return { config, changed: false, unmergeable: true };
  next.hooks[event] ??= [];
  if (!Array.isArray(next.hooks[event])) return { config, changed: false, unmergeable: true };
  const groups: any[] = next.hooks[event];
  let present = groups.some((g: any) => (g?.hooks ?? []).some?.((h: any) => h?.command === command));
  let changed = false;
  next.hooks[event] = groups.filter((g) => {
    if (!Array.isArray(g?.hooks)) return true;
    const before = g.hooks.length;
    g.hooks = g.hooks.filter((h: any) => {
      if (h?.command === command || !isStale(h?.command)) return true;
      changed = true;
      if (present) return false;
      present = true;
      h.command = command;
      return true;
    });
    return g.hooks.length > 0 || before === 0;
  });
  if (present) return { config: next, changed };
  next.hooks[event].push({ hooks: [{ type: "command", command }] });
  return { config: next, changed: true };
}

// command is either the exact command or a test such as isAnynotateHook for any form an earlier install wrote.
export function removeHook(config: any, command: string | ((command: unknown) => boolean)): { config: any; changed: boolean } {
  if (!isObject(config) || !isObject(config.hooks)) return { config, changed: false };
  const matches = typeof command === "string" ? (c: unknown) => c === command : command;
  const next = structuredClone(config);
  let changed = false;
  for (const [event, groups] of Object.entries<any>(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => {
      if (!Array.isArray(g?.hooks)) return true;
      const hooks = g.hooks.filter((h: any) => !matches(h?.command));
      if (hooks.length === g.hooks.length) return true;
      changed = true;
      g.hooks = hooks;
      return hooks.length > 0;
    });
    if (kept.length) next.hooks[event] = kept;
    else if (groups.length) delete next.hooks[event];
  }
  return { config: changed ? next : config, changed };
}

export { LAUNCHD_LABEL };

export const HOOKED_CLIS = [
  { cli: "claude", settings: ".claude/settings.json", skill: ".claude/skills/annotations/SKILL.md" },
  { cli: "codex", settings: ".codex/hooks.json", skill: ".codex/skills/annotations/SKILL.md" },
] as const;

// Extension ids the installer pre-allows: the pinned dev id now, the Chrome Web Store id once it exists.
// Without a repo the copy embedded at build time is used.
export function extensionOrigins(repo?: string): string[] {
  try {
    const ids: unknown = JSON.parse(readAsset(repo, "assets/extension-ids.json"));
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === "string").map((id) => `chrome-extension://${id}`).filter((o) => ORIGIN_RE.test(o));
  } catch {
    return [];
  }
}

const readAsset = (repo: string | undefined, rel: string): string =>
  repo === undefined ? (EMBEDDED_ASSETS[rel] ?? "") : readFileSync(join(repo, rel), "utf8");

export type InstallOptions = {
  platform?: Platform;
  home: string;
  env?: Env;
  kind: InstallKind;
  version: string;
  uid: number;
  hasUserSystemd: boolean;
  exists?: (path: string) => boolean;
  which?: (cli: string) => string | null;
  installed?: (cli: string) => boolean;
  // Where assets/ is read from; defaults to the clone for a source install and the embedded copies otherwise.
  assets?: string;
  now?: Date;
};

// On Windows the path uses forward slashes, which cmd, PowerShell and Git Bash all accept; backslashes would be
// escapes to the bash some agents run hooks through.
export const hookCommand = (kind: InstallKind, agent: string, platform: Platform) => {
  const argv = commandArgv(kind);
  return `${quoteArgv(platform === "win32" ? argv.map((a) => a.replace(/\\/g, "/")) : argv)} hook --agent ${agent}`;
};

export function planInstall(o: InstallOptions): InstallStep[] {
  const platform = o.platform ?? currentPlatform();
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const which = o.which ?? Bun.which;
  const { home, kind } = o;
  const path = pathFor(platform);
  const assets = o.assets ?? (kind.kind === "source" ? kind.repo : undefined);
  const paths = installPaths(platform, home, env);
  const { dataDir } = paths;
  const isInstalled = o.installed ?? ((cli: string) => which(cli) !== null || exists(path.join(home, `.${cli}`)));
  const read = (rel: string) => (assets === undefined || existsSync(join(assets, rel)) ? readAsset(assets, rel) : "");
  const perCli = HOOKED_CLIS.flatMap(({ cli, settings, skill }): InstallStep[] =>
    isInstalled(cli)
      ? [
          {
            path: path.join(home, ...settings.split("/")),
            action: "merge-json",
            content: JSON.stringify({ event: "UserPromptSubmit", command: hookCommand(kind, cli, platform), agent: cli }),
          },
          { path: path.join(home, ...skill.split("/")), action: "write", content: read("assets/skill/SKILL.md") },
        ]
      : [{ path: cli, action: "skip", content: "not installed" }],
  );
  const service = planService({
    platform,
    home,
    env,
    exe: commandArgv(kind),
    logPath: paths.logPath,
    dataDir,
    uid: o.uid,
    hasUserSystemd: o.hasUserSystemd,
  });
  const record: InstallRecord = {
    kind: kind.kind,
    path: kind.kind === "binary" ? kind.exe : kind.repo,
    version: o.version,
    installedAt: (o.now ?? new Date()).toISOString(),
    platform,
  };
  return [
    { path: dataDir, action: "private-dir", content: "" },
    ...binSteps(platform, kind, paths.binDir, paths.binPath),
    ...perCli,
    { path: path.join(home, ".gemini", "settings.json"), action: "remove-hook", content: "anynotate hook --agent gemini" },
    { path: path.join(home, ".gemini", "commands", "annotations.toml"), action: "remove-file", content: read("assets/gemini/annotations.toml") },
    ...originSteps(path.join(dataDir, "origins"), assets),
    ...nativeHostSteps(platform, home, env, kind, dataDir, assets, exists),
    ...service.files.map((f): InstallStep => ({ path: f.path, action: "write", content: f.content, mode: f.mode, encoding: f.encoding })),
    { path: path.join(dataDir, INSTALL_RECORD), action: "record", content: formatInstallRecord(record) },
    { path: "service", action: "run", content: "start the bridge", argv: service.start },
  ];
}

// A binary install was put in place by the install script; a source install links the clone's launcher onto PATH,
// on Windows through a .cmd shim whose dir install adds to the user PATH the way install.ps1 does.
function binSteps(platform: Platform, kind: InstallKind, binDir: string, binPath: string): InstallStep[] {
  if (kind.kind === "binary") return [];
  if (platform === "win32") {
    return [
      { path: win32.join(binDir, "anynotate.cmd"), action: "write", content: `@${cmdArgv(commandArgv(kind))} %*\r\n` },
      { path: binDir, action: "path-entry", content: "" },
    ];
  }
  return [{ path: binPath, action: "symlink", content: posix.join(kind.repo, "bin", "anynotate") }];
}

function originSteps(originsPath: string, assets: string | undefined): InstallStep[] {
  const origins = extensionOrigins(assets);
  return origins.length > 0
    ? origins.map((origin): InstallStep => ({ path: originsPath, action: "origin", content: origin }))
    : [{ path: "origin", action: "skip", content: `no extension id in ${assets === undefined ? "the embedded assets/extension-ids.json" : join(assets, "assets/extension-ids.json")}` }];
}

// Allows the pinned ids plus any added with `anynotate origin add`, so re-running install picks up a dev id.
// A binary is its own host; a source install needs a wrapper because Chrome only launches an executable path.
function nativeHostSteps(
  platform: Platform,
  home: string,
  env: Env,
  kind: InstallKind,
  dataDir: string,
  assets: string | undefined,
  exists: (path: string) => boolean,
): InstallStep[] {
  const wrapper = kind.kind === "source" ? sourceHostWrapper(platform, kind.bun, kind.repo, dataDir) : null;
  const hostPath = wrapper ? wrapper.path : (kind as { exe: string }).exe;
  const origins = [...new Set([...extensionOrigins(assets), ...readOrigins(pathFor(platform).join(dataDir, "origins"))])];
  const host = planNativeHost({ platform, home, env, hostPath, dataDir, origins, exists });
  const wrapperSteps: InstallStep[] = wrapper
    ? [{ path: wrapper.path, action: "write", content: wrapper.content, mode: platform === "win32" ? undefined : 0o700 }]
    : [];
  return [
    ...wrapperSteps,
    ...host.map((h): InstallStep => {
      const where = h.kind === "reg-add" || h.kind === "reg-delete" ? h.key : h.path;
      return origins.length > 0
        ? { path: where, action: "native-host", content: "", host: h }
        : { path: where, action: "skip", content: "no extension id to allow" };
    }),
  ];
}

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

export type ApplyOptions = {
  exec?: Exec;
  platform?: Platform;
  // Write files but run no external command (service, registry): those steps are only reported.
  externalDryRun?: boolean;
  backupSuffix?: string;
};

const noExec: Exec = (argv) => {
  throw new Error(`anynotate: applyInstall was given no exec to run ${argv.join(" ")}`);
};

const encode = (content: string, encoding: InstallStep["encoding"]) =>
  encoding === "utf16le-bom" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]) : Buffer.from(content);

export function applyInstall(steps: InstallStep[], dryRun: boolean, o: ApplyOptions = {}): string[] {
  const { exec = noExec, platform = currentPlatform(), externalDryRun = false, backupSuffix = ".bak-anynotate" } = o;
  const log: string[] = [];
  // Parse every settings file before touching anything, so one unreadable file can't leave the
  // install half-applied; such a file is skipped and the rest still go ahead.
  const parsed = new Map<string, { ok: true; value: any } | { ok: false }>();
  for (const s of steps) {
    if ((s.action !== "merge-json" && s.action !== "remove-hook") || !existsSync(s.path)) continue;
    try {
      parsed.set(s.path, { ok: true, value: JSON.parse(readFileSync(s.path, "utf8")) });
    } catch {
      parsed.set(s.path, { ok: false });
    }
  }
  for (const s of steps) {
    if (s.action === "skip") {
      log.push(`skip    ${s.path} (${s.content})`);
    } else if (s.action === "remove-hook") {
      const current = parsed.get(s.path);
      if (!current) continue;
      if (!current.ok) {
        if (readFileSync(s.path, "utf8").includes(s.content)) log.push(`skip    ${s.path} (not valid JSON — remove "${s.content}" by hand)`);
        continue;
      }
      const { config, changed } = removeHook(current.value, s.content);
      if (!changed) continue;
      if (dryRun) { log.push(`would remove ${s.content} from ${s.path}`); continue; }
      copyFileSync(s.path, `${s.path}${backupSuffix}`);
      writeFileSync(s.path, `${JSON.stringify(config, null, 2)}\n`);
      log.push(`removed ${s.content} from ${s.path}`);
    } else if (s.action === "remove-file") {
      if (!lstatOrNull(s.path)?.isFile()) continue;
      if (!s.content || readFileSync(s.path, "utf8") !== s.content) { log.push(`skip    ${s.path} (changed since install — left alone)`); continue; }
      if (dryRun) { log.push(`would remove ${s.path}`); continue; }
      rmSync(s.path);
      log.push(`removed ${s.path}`);
    } else if (s.action === "origin") {
      if (readOrigins(s.path).includes(s.content)) { log.push(`ok      origin ${s.content}`); continue; }
      if (dryRun) { log.push(`would add origin ${s.content}`); continue; }
      addOrigin(s.content, s.path);
      log.push(`added   origin ${s.content} → ${s.path}`);
    } else if (s.action === "merge-json") {
      const { event, command, agent } = JSON.parse(s.content) as { event: string; command: string; agent?: string };
      const current = parsed.get(s.path) ?? { ok: true, value: {} };
      if (!current.ok) { log.push(`skip    ${s.path} (not valid JSON — add the hook by hand: ${command})`); continue; }
      const stale = (c: unknown) => agent !== undefined && isAnynotateHook(c, agent);
      const { config, changed, unmergeable } = addHook(current.value, event, command, stale);
      if (unmergeable) { log.push(`skip    ${s.path} (unexpected shape for hooks.${event} — add the hook by hand: ${command})`); continue; }
      const what = event;
      if (!changed) { log.push(`ok      ${s.path} (hook present)`); continue; }
      if (dryRun) { log.push(`would merge ${what} → ${s.path}`); continue; }
      mkdirSync(dirname(s.path), { recursive: true });
      if (existsSync(s.path)) copyFileSync(s.path, `${s.path}${backupSuffix}`);
      writeFileSync(s.path, `${JSON.stringify(config, null, 2)}\n`);
      log.push(`merged  ${what} → ${s.path}`);
    } else if (s.action === "native-host") {
      if (!s.host) continue;
      try {
        log.push(...applyHostSteps([s.host], exec, dryRun || (externalDryRun && isRegistryStep(s.host))));
      } catch (err) {
        log.push(`failed (${(err as Error).message})`);
      }
    } else if (s.action === "record") {
      if (dryRun) { log.push(`would write ${s.path}`); continue; }
      writePrivateFile(s.path, s.content, platform, exec);
      log.push(`wrote   ${s.path}`);
    } else if (s.action === "path-entry") {
      if (dryRun || externalDryRun) { log.push(`would add ${s.path} to the user PATH`); continue; }
      const r = runPathEntry(exec, ADD_PATH_ENTRY, s.path);
      if (r.code !== 0) log.push(`failed (exit ${r.code}): adding ${s.path} to the user PATH${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
      else if (r.stdout.trim() === "present") log.push(`ok      ${s.path} (on the user PATH)`);
      else log.push(`added   ${s.path} to the user PATH (open a new terminal to use anynotate)`);
    } else if (s.action === "run") {
      log.push(...runSteps(s.argv ?? [], exec, dryRun || externalDryRun).log);
    } else if (s.action === "write") {
      const mode = s.mode;
      const bytes = encode(s.content, s.encoding);
      if (existsSync(s.path) && readFileSync(s.path).equals(bytes)) {
        if (mode === undefined || (lstatSync(s.path).mode & 0o777) === mode) { log.push(`ok      ${s.path}`); continue; }
        const octal = mode.toString(8);
        if (dryRun) { log.push(`would chmod ${octal} ${s.path}`); continue; }
        chmodSync(s.path, mode);
        log.push(`chmod   ${octal} ${s.path}`);
        continue;
      }
      if (dryRun) { log.push(`would write ${s.path}`); continue; }
      mkdirSync(dirname(s.path), { recursive: true });
      if (existsSync(s.path)) copyFileSync(s.path, `${s.path}${backupSuffix}`);
      writeFileSync(s.path, bytes, mode === undefined ? undefined : { mode });
      if (mode !== undefined) chmodSync(s.path, mode);
      log.push(`wrote   ${s.path}`);
    } else if (s.action === "private-dir") {
      // launchd opens the plist's log file here and never creates missing parent dirs.
      const existing = lstatOrNull(s.path);
      if (existing && !existing.isDirectory()) { log.push(`skip    ${s.path} (exists and is not a directory)`); continue; }
      if (platform === "win32") {
        if (dryRun) { log.push(existing ? `ok      ${s.path}` : `would mkdir ${s.path}`); continue; }
        makePrivateDir(s.path, platform, exec);
        log.push(existing ? `ok      ${s.path}` : `mkdir   ${s.path}`);
        continue;
      }
      if (existing && (existing.mode & 0o777) === 0o700) { log.push(`ok      ${s.path}`); continue; }
      if (dryRun) { log.push(existing ? `would chmod 700 ${s.path}` : `would mkdir ${s.path}`); continue; }
      makePrivateDir(s.path, platform, exec);
      log.push(existing ? `chmod   700 ${s.path}` : `mkdir   ${s.path}`);
    } else {
      const existing = lstatOrNull(s.path);
      if (existing && !existing.isSymbolicLink()) { log.push(`skip    ${s.path} (exists and is not a symlink)`); continue; }
      if (existing && readlinkSync(s.path) === s.content) { log.push(`ok      ${s.path}`); continue; }
      if (dryRun) { log.push(`would link ${s.path} → ${s.content}`); continue; }
      mkdirSync(dirname(s.path), { recursive: true });
      rmSync(s.path, { force: true });
      symlinkSync(s.content, s.path);
      log.push(`linked  ${s.path} → ${s.content}`);
    }
  }
  return log;
}
