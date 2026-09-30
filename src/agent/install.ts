import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addOrigin, ORIGIN_RE, readOrigins } from "../bridge/origins";

export type InstallStep = {
  path: string;
  action: "write" | "merge-json" | "symlink" | "private-dir" | "skip" | "remove-hook" | "remove-file" | "origin";
  content: string;
  mode?: number;
};

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

// A config whose shape we don't recognise is reported as unmergeable rather than rewritten.
export function addHook(config: any, event: string, command: string): { config: any; changed: boolean; unmergeable?: true } {
  const next = structuredClone(config ?? {});
  if (!isObject(next)) return { config, changed: false, unmergeable: true };
  next.hooks ??= {};
  if (!isObject(next.hooks)) return { config, changed: false, unmergeable: true };
  next.hooks[event] ??= [];
  if (!Array.isArray(next.hooks[event])) return { config, changed: false, unmergeable: true };
  const present = next.hooks[event].some((g: any) => (g?.hooks ?? []).some?.((h: any) => h?.command === command));
  if (present) return { config: next, changed: false };
  next.hooks[event].push({ hooks: [{ type: "command", command }] });
  return { config: next, changed: true };
}

export function removeHook(config: any, command: string): { config: any; changed: boolean } {
  if (!isObject(config) || !isObject(config.hooks)) return { config, changed: false };
  const next = structuredClone(config);
  let changed = false;
  for (const [event, groups] of Object.entries<any>(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => {
      if (!Array.isArray(g?.hooks)) return true;
      const hooks = g.hooks.filter((h: any) => h?.command !== command);
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

export const LAUNCHD_LABEL = "dev.anynotate.bridge";

export const launchdPlist = (anynotateBin: string, home: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${anynotateBin}</string>
    <string>bridge</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>${home}/.anynotate/bridge.log</string>
  <key>StandardErrorPath</key><string>${home}/.anynotate/bridge.log</string>
</dict>
</plist>
`;

export const HOOKED_CLIS = [
  { cli: "claude", settings: ".claude/settings.json", skill: ".claude/skills/annotations/SKILL.md" },
  { cli: "codex", settings: ".codex/hooks.json", skill: ".codex/skills/annotations/SKILL.md" },
] as const;

// Extension ids the installer pre-allows: the pinned dev id now, the Chrome Web Store id once it exists.
export function extensionOrigins(repo: string): string[] {
  try {
    const ids: unknown = JSON.parse(readFileSync(join(repo, "assets/extension-ids.json"), "utf8"));
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === "string").map((id) => `chrome-extension://${id}`).filter((o) => ORIGIN_RE.test(o));
  } catch {
    return [];
  }
}

export const NATIVE_HOST_NAME = "dev.anynotate.host";

// Chrome starts native hosts with a minimal PATH, so the wrapper names bun by absolute path.
export const nativeHostWrapper = (bunPath: string, repo: string) => `#!/bin/sh
exec "${bunPath}" "${join(repo, "src/cli.ts")}" native-host "$@"
`;

export const nativeHostManifest = (wrapperPath: string, origins: string[]) =>
  `${JSON.stringify({ name: NATIVE_HOST_NAME, description: "Anynotate bridge helper", path: wrapperPath, type: "stdio", allowed_origins: origins.map((o) => `${o}/`) }, null, 2)}\n`;

export type InstallPlan = {
  home: string;
  anynotateBin: string;
  repo: string;
  bunPath?: string;
  which?: (cli: string) => string | null;
  installed?: (cli: string) => boolean;
};

export function planInstall({ home, anynotateBin, repo, bunPath = process.execPath, which = Bun.which, installed }: InstallPlan): InstallStep[] {
  const isInstalled = installed ?? ((cli: string) => which(cli) !== null || existsSync(join(home, `.${cli}`)));
  const hook = (agent: string, event: string) => JSON.stringify({ event, command: `anynotate hook --agent ${agent}` });
  const read = (rel: string) => (existsSync(join(repo, rel)) ? readFileSync(join(repo, rel), "utf8") : "");
  const perCli = HOOKED_CLIS.flatMap(({ cli, settings, skill }): InstallStep[] =>
    isInstalled(cli)
      ? [
          { path: join(home, settings), action: "merge-json", content: hook(cli, "UserPromptSubmit") },
          { path: join(home, skill), action: "write", content: read("assets/skill/SKILL.md") },
        ]
      : [{ path: cli, action: "skip", content: "not installed" }],
  );
  return [
    { path: join(home, ".local/bin/anynotate"), action: "symlink", content: anynotateBin },
    ...perCli,
    { path: join(home, ".gemini/settings.json"), action: "remove-hook", content: "anynotate hook --agent gemini" },
    { path: join(home, ".gemini/commands/annotations.toml"), action: "remove-file", content: read("assets/gemini/annotations.toml") },
    { path: join(home, ".anynotate"), action: "private-dir", content: "" },
    ...originSteps(home, repo),
    ...nativeHostSteps(home, repo, bunPath),
    { path: join(home, `Library/LaunchAgents/${LAUNCHD_LABEL}.plist`), action: "write", content: launchdPlist(anynotateBin, home) },
  ];
}

function originSteps(home: string, repo: string): InstallStep[] {
  const origins = extensionOrigins(repo);
  return origins.length > 0
    ? origins.map((origin): InstallStep => ({ path: join(home, ".anynotate/origins"), action: "origin", content: origin }))
    : [{ path: "origin", action: "skip", content: `no extension id in ${join(repo, "assets/extension-ids.json")}` }];
}

// Allows the pinned ids plus any added with `anynotate origin add`, so re-running install picks up a dev id.
function nativeHostSteps(home: string, repo: string, bunPath: string): InstallStep[] {
  const wrapper = join(home, ".anynotate/native-host");
  const manifest = join(home, `Library/Application Support/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`);
  const origins = [...new Set([...extensionOrigins(repo), ...readOrigins(join(home, ".anynotate/origins"))])];
  return [
    { path: wrapper, action: "write", content: nativeHostWrapper(bunPath, repo), mode: 0o700 },
    origins.length > 0
      ? { path: manifest, action: "write", content: nativeHostManifest(wrapper, origins) }
      : { path: manifest, action: "skip", content: "no extension id to allow" },
  ];
}

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

export function applyInstall(steps: InstallStep[], dryRun: boolean, backupSuffix = ".bak-anynotate"): string[] {
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
      const { event, command } = JSON.parse(s.content) as { event: string; command: string };
      const current = parsed.get(s.path) ?? { ok: true, value: {} };
      if (!current.ok) { log.push(`skip    ${s.path} (not valid JSON — add the hook by hand: ${command})`); continue; }
      const { config, changed, unmergeable } = addHook(current.value, event, command);
      if (unmergeable) { log.push(`skip    ${s.path} (unexpected shape for hooks.${event} — add the hook by hand: ${command})`); continue; }
      const what = event;
      if (!changed) { log.push(`ok      ${s.path} (hook present)`); continue; }
      if (dryRun) { log.push(`would merge ${what} → ${s.path}`); continue; }
      mkdirSync(dirname(s.path), { recursive: true });
      if (existsSync(s.path)) copyFileSync(s.path, `${s.path}${backupSuffix}`);
      writeFileSync(s.path, `${JSON.stringify(config, null, 2)}\n`);
      log.push(`merged  ${what} → ${s.path}`);
    } else if (s.action === "write") {
      const mode = s.mode;
      if (existsSync(s.path) && readFileSync(s.path, "utf8") === s.content) {
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
      writeFileSync(s.path, s.content, mode === undefined ? undefined : { mode });
      if (mode !== undefined) chmodSync(s.path, mode);
      log.push(`wrote   ${s.path}`);
    } else if (s.action === "private-dir") {
      // launchd opens the plist's log file here and never creates missing parent dirs.
      const existing = lstatOrNull(s.path);
      if (existing?.isDirectory() && (existing.mode & 0o777) === 0o700) { log.push(`ok      ${s.path}`); continue; }
      if (existing && !existing.isDirectory()) { log.push(`skip    ${s.path} (exists and is not a directory)`); continue; }
      if (dryRun) { log.push(existing ? `would chmod 700 ${s.path}` : `would mkdir ${s.path}`); continue; }
      mkdirSync(s.path, { recursive: true, mode: 0o700 });
      chmodSync(s.path, 0o700);
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
