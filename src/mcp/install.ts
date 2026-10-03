import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Check } from "../agent/doctor";
import { quoteArgv } from "../agent/installkind";
import type { Exec } from "../platform/exec";
import { type Env, pathFor, type Platform } from "../platform/os";

export const MCP_APPS = ["claude-desktop", "codex", "cursor", "claude-code"] as const;
export type McpApp = (typeof MCP_APPS)[number];
export const SERVER_NAME = "anynotate";

const LABEL: Record<McpApp, string> = { "claude-desktop": "Claude Desktop", codex: "Codex", cursor: "Cursor", "claude-code": "Claude Code" };

export const MCP_SETUP_USAGE = "usage: anynotate mcp [install|uninstall [--claude-desktop] [--codex] [--cursor] [--claude-code] [--dry-run]]";

export type McpTarget = { kind: "json" | "toml" | "cli"; path: string } | { kind: "unsupported"; reason: string };

type Lookup = { platform: Platform; home: string; env: Env; exists?: (path: string) => boolean; listDir?: (path: string) => string[] };

const listDirOrEmpty = (path: string) => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

// The Microsoft Store (MSIX) build of Claude Desktop keeps its settings in a virtualised AppData under its package
// folder; an existing one wins over the regular %APPDATA%\Claude.
function windowsClaudeDir(o: Lookup): string {
  const path = pathFor("win32");
  const exists = o.exists ?? existsSync;
  const local = o.env.LOCALAPPDATA?.trim();
  const localAppData = local && path.isAbsolute(local) ? local : path.join(o.home, "AppData", "Local");
  const packages = path.join(localAppData, "Packages");
  for (const name of (o.listDir ?? listDirOrEmpty)(packages).filter((n) => n.startsWith("Claude_")).sort()) {
    const dir = path.join(packages, name, "LocalCache", "Roaming", "Claude");
    if (exists(dir)) return dir;
  }
  const appData = o.env.APPDATA?.trim();
  return path.join(appData && path.isAbsolute(appData) ? appData : path.join(o.home, "AppData", "Roaming"), "Claude");
}

// Where each app reads its MCP servers: Claude Desktop's claude_desktop_config.json (macOS and Windows only), Cursor's
// ~/.cursor/mcp.json, Codex's ~/.codex/config.toml, and for Claude Code the `claude mcp` CLI, which keeps user-scope
// servers in ~/.claude.json.
export function mcpTarget(app: McpApp, o: Lookup): McpTarget {
  const path = pathFor(o.platform);
  switch (app) {
    case "claude-desktop": {
      if (o.platform === "darwin") return { kind: "json", path: path.join(o.home, "Library", "Application Support", "Claude", "claude_desktop_config.json") };
      if (o.platform === "win32") return { kind: "json", path: path.join(windowsClaudeDir(o), "claude_desktop_config.json") };
      return { kind: "unsupported", reason: "there is no Claude Desktop for Linux" };
    }
    case "cursor":
      return { kind: "json", path: path.join(o.home, ".cursor", "mcp.json") };
    case "codex":
      return { kind: "toml", path: path.join(o.home, ".codex", "config.toml") };
    case "claude-code":
      return { kind: "cli", path: path.join(o.home, ".claude.json") };
  }
}

export type McpOptions = {
  platform: Platform;
  home: string;
  env: Env;
  // The anynotate command line, without the "mcp" argument.
  entry: string[];
  which: (cmd: string) => string | null;
  exec: Exec;
  log: (line: string) => void;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  listDir?: (path: string) => string[];
  now?: Date;
};

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const serverArgs = (entry: string[]) => [...entry.slice(1), "mcp"];
const sameEntry = (e: unknown, entry: string[]) =>
  isObject(e) && e.command === entry[0] && Bun.deepEquals(e.args ?? [], serverArgs(entry));

export type Edit = { text: string } | { unchanged: true } | { error: string };

function parseJson(text: string): { value: Record<string, any> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "not valid JSON" };
  }
  if (!isObject(value)) return { error: "not a JSON object" };
  if (value.mcpServers !== undefined && !isObject(value.mcpServers)) return { error: "mcpServers is not an object" };
  return { value };
}

const formatJson = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export function setJsonServer(text: string, entry: string[]): Edit {
  const parsed = parseJson(text.trim() ? text : "{}");
  if ("error" in parsed) return parsed;
  const config = parsed.value;
  const current = config.mcpServers?.[SERVER_NAME];
  if (sameEntry(current, entry)) return { unchanged: true };
  const servers = { ...(config.mcpServers ?? {}) };
  servers[SERVER_NAME] = { ...(isObject(current) ? current : {}), command: entry[0], args: serverArgs(entry) };
  return { text: formatJson({ ...config, mcpServers: servers }) };
}

export function removeJsonServer(text: string): Edit {
  const parsed = parseJson(text);
  if ("error" in parsed) return parsed;
  const config = parsed.value;
  if (config.mcpServers?.[SERVER_NAME] === undefined) return { unchanged: true };
  const { [SERVER_NAME]: _, ...servers } = config.mcpServers;
  return { text: formatJson({ ...config, mcpServers: servers }) };
}

const parseToml = (text: string): Record<string, any> | null => {
  try {
    return Bun.TOML.parse(text) as Record<string, any>;
  } catch {
    return null;
  }
};

// The key path of a [table] or [[array]] header line, or null for any other line.
function headerPath(line: string): string[] | null {
  const m = /^\s*\[{1,2}([^\[\]]*(?:"[^"]*"[^\[\]]*)*)\]{1,2}\s*(?:#.*)?\r?$/.exec(line);
  if (!m) return null;
  const parts: string[] = [];
  const re = /\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(\.|$)/y;
  const key = m[1]!;
  let at = 0;
  while (at < key.length) {
    re.lastIndex = at;
    const k = re.exec(key);
    if (!k) return null;
    parts.push(k[1] ?? (k[2] !== undefined ? JSON.parse(`"${k[2]}"`) : k[3]!));
    at = re.lastIndex;
    if (!k[4]) break;
  }
  return parts;
}

const isOurs = (path: string[] | null) => path !== null && path[0] === "mcp_servers" && path[1] === SERVER_NAME;
const isTrivia = (line: string) => /^\s*(#.*)?\r?$/.test(line);

// Drops our [mcp_servers.anynotate] table and its subtables, keeping comments and blank lines that close each block
// (they usually introduce the next table). insertAt is where the first dropped table stood.
function stripOurTables(text: string): { lines: string[]; insertAt: number } {
  const lines = text.split("\n");
  const out: string[] = [];
  let insertAt = -1;
  for (let i = 0; i < lines.length; ) {
    if (!isOurs(headerPath(lines[i]!))) {
      out.push(lines[i++]!);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && headerPath(lines[end]!) === null) end++;
    let keepFrom = end;
    while (keepFrom > i + 1 && isTrivia(lines[keepFrom - 1]!)) keepFrom--;
    if (insertAt < 0) insertAt = out.length;
    out.push(...lines.slice(keepFrom, end));
    i = end;
  }
  return { lines: out, insertAt };
}

const withoutOurs = (config: Record<string, any>) => {
  const copy = structuredClone(config);
  if (isObject(copy.mcp_servers)) {
    delete copy.mcp_servers[SERVER_NAME];
    if (Object.keys(copy.mcp_servers).length === 0) delete copy.mcp_servers;
  }
  return copy;
};

const CANT_EDIT = `defines mcp_servers.${SERVER_NAME} in a form this installer does not edit — change it by hand`;

function verifyToml(before: Record<string, any>, text: string, expected: unknown): Edit {
  const after = parseToml(text);
  if (!after) return { error: CANT_EDIT };
  if (!Bun.deepEquals(after.mcp_servers?.[SERVER_NAME], expected) || !Bun.deepEquals(withoutOurs(before), withoutOurs(after))) return { error: CANT_EDIT };
  return { text };
}

const isExactlyOurs = (path: string[] | null) => isOurs(path) && path!.length === 2;
const bracketDepth = (line: string) => [...line].reduce((d, c) => d + (c === "[" ? 1 : c === "]" ? -1 : 0), 0);

// Sets command and args inside an existing [mcp_servers.anynotate] table, leaving its other keys, comments and
// subtables alone. null when there is no such table header.
function setInOurTable(text: string, command: string, args: string): string | null {
  const lines = text.split("\n");
  const header = lines.findIndex((l) => isExactlyOurs(headerPath(l)));
  if (header < 0) return null;
  let end = header + 1;
  while (end < lines.length && headerPath(lines[end]!) === null) end++;
  const body = lines.slice(header + 1, end);
  const out: string[] = [];
  let sawCommand = false;
  let sawArgs = false;
  for (let i = 0; i < body.length; i++) {
    const line = body[i]!;
    if (/^\s*command\s*=/.test(line)) {
      out.push(command);
      sawCommand = true;
    } else if (/^\s*args\s*=/.test(line)) {
      let depth = bracketDepth(line);
      while (depth > 0 && i + 1 < body.length) depth += bracketDepth(body[++i]!);
      out.push(args);
      sawArgs = true;
    } else out.push(line);
  }
  const added = [...(sawCommand ? [] : [command]), ...(sawArgs ? [] : [args])];
  return [...lines.slice(0, header + 1), ...added, ...out, ...lines.slice(end)].join("\n");
}

export function setTomlServer(text: string, entry: string[]): Edit {
  const before = parseToml(text);
  if (!before) return { error: "not valid TOML" };
  const current = before.mcp_servers?.[SERVER_NAME];
  if (sameEntry(current, entry)) return { unchanged: true };
  const command = `command = ${JSON.stringify(entry[0])}`;
  const args = `args = [${serverArgs(entry).map((a) => JSON.stringify(a)).join(", ")}]`;
  let next = setInOurTable(text, command, args);
  if (next === null) {
    const sep = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    next = `${text}${sep}[mcp_servers.${SERVER_NAME}]\n${command}\n${args}\n`;
  }
  return verifyToml(before, next, { ...(isObject(current) ? current : {}), command: entry[0], args: serverArgs(entry) });
}

export function removeTomlServer(text: string): Edit {
  const before = parseToml(text);
  if (!before) return { error: "not valid TOML" };
  if (before.mcp_servers?.[SERVER_NAME] === undefined) return { unchanged: true };
  const { lines, insertAt } = stripOurTables(text);
  if (insertAt < 0) return { error: CANT_EDIT };
  return verifyToml(before, lines.join("\n"), undefined);
}

type AppState =
  | { state: "unsupported"; reason: string }
  | { state: "app not found" }
  | { state: "not configured" | "configured"; path: string }
  | { state: "stale"; path: string; command: string }
  | { state: "unreadable"; path: string; error: string };

const readText = (path: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): string | null => {
  try {
    return read(path);
  } catch {
    return null;
  }
};

function present(app: McpApp, target: McpTarget, o: McpOptions): boolean {
  const exists = o.exists ?? existsSync;
  const path = pathFor(o.platform);
  switch (app) {
    case "claude-desktop":
      return target.kind !== "unsupported" && exists(dirname(target.path));
    case "cursor":
      return exists(path.join(o.home, ".cursor")) || o.which("cursor") !== null;
    case "codex":
      return exists(path.join(o.home, ".codex")) || o.which("codex") !== null;
    case "claude-code":
      return o.which("claude") !== null || exists(path.join(o.home, ".claude")) || exists(path.join(o.home, ".claude.json"));
  }
}

function appState(app: McpApp, o: McpOptions): AppState {
  const target = mcpTarget(app, o);
  if (target.kind === "unsupported") return { state: "unsupported", reason: target.reason };
  if (!present(app, target, o)) return { state: "app not found" };
  const { path } = target;
  const text = readText(path, o.readFile);
  if (text === null) return { state: "not configured", path };
  let current: unknown;
  if (target.kind === "toml") {
    const parsed = parseToml(text);
    if (!parsed) return { state: "unreadable", path, error: "not valid TOML" };
    current = parsed.mcp_servers?.[SERVER_NAME];
  } else {
    const parsed = parseJson(text);
    if ("error" in parsed) return { state: "unreadable", path, error: parsed.error };
    current = parsed.value.mcpServers?.[SERVER_NAME];
  }
  if (current === undefined) return { state: "not configured", path };
  if (sameEntry(current, o.entry)) return { state: "configured", path };
  return { state: "stale", path, command: [isObject(current) ? current.command : undefined, ...(isObject(current) && Array.isArray(current.args) ? current.args : [])].filter(Boolean).join(" ") };
}

export function mcpChecks(o: McpOptions): Check[] {
  return MCP_APPS.map((app): Check => {
    const name = `mcp (${app})`;
    const s = appState(app, o);
    switch (s.state) {
      case "unsupported":
        return { name, ok: true, detail: `${s.reason} (skipped)` };
      case "app not found":
        return { name, ok: true, detail: "app not found (skipped)" };
      case "not configured":
        return { name, ok: true, detail: `not configured (optional: \`anynotate mcp install --${app}\`)` };
      case "configured":
        return { name, ok: true, detail: `configured in ${s.path}`, mcp: "configured" };
      case "stale":
        return { name, ok: "warn", detail: `${s.path} runs ${s.command} — run \`anynotate mcp install --${app}\`` };
      case "unreadable":
        return { name, ok: "warn", detail: `${s.path} is ${s.error}` };
    }
  });
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

type Outcome = { failed: boolean; changed: boolean };

// Owner-only from creation, and never over an existing file.
const PRIVATE_NEW = { mode: 0o600, flag: "wx" } as const;

function writeBackup(path: string, bytes: Uint8Array, at: string): string {
  for (let n = 1; ; n++) {
    const backup = `${path}.bak-anynotate-${at}${n > 1 ? `-${n}` : ""}`;
    try {
      writeFileSync(backup, bytes, PRIVATE_NEW);
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

// Written beside the target and renamed over it, so the app never reads a half-written file; an existing file's
// permission bits carry over, and a new one stays owner-only.
function writeAtomic(path: string, text: string, existed: boolean, platform: Platform): void {
  const tmp = `${path}.tmp-anynotate-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, text, PRIVATE_NEW);
    if (existed && platform !== "win32") chmodSync(tmp, statSync(path).mode & 0o777);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function editFile(path: string, edit: (text: string) => Edit, verb: "add" | "remove", dryRun: boolean, o: McpOptions): Outcome {
  const existing = readText(path);
  if (existing === null && verb === "remove") {
    o.log(`ok      ${path} (anynotate not configured)`);
    return { failed: false, changed: false };
  }
  const r = edit(existing ?? "");
  if ("error" in r) {
    o.log(`refused ${path} (${r.error}; left unchanged)`);
    return { failed: true, changed: false };
  }
  if ("unchanged" in r) {
    o.log(verb === "add" ? `ok      ${path} (anynotate already configured)` : `ok      ${path} (anynotate not configured)`);
    return { failed: false, changed: false };
  }
  const prep = verb === "add" ? "to" : "from";
  if (dryRun) {
    o.log(`would ${verb} anynotate ${prep} ${path}`);
    return { failed: false, changed: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  // A config that is a link (dotfiles) stays one: the file it points at is backed up and replaced.
  const real = existing !== null ? realpathSync(path) : path;
  let backup = "";
  if (existing !== null) backup = writeBackup(real, readFileSync(real), stamp(o.now ?? new Date()));
  writeAtomic(real, r.text, existing !== null, o.platform);
  o.log(`${verb === "add" ? "added  " : "removed"} anynotate ${prep} ${path}${backup ? ` (backup ${backup})` : ""}`);
  return { failed: false, changed: true };
}

function runClaude(argv: string[], dryRun: boolean, o: McpOptions): Outcome {
  const shown = quoteArgv(argv, o.platform);
  if (dryRun) {
    o.log(`would run ${shown}`);
    return { failed: false, changed: false };
  }
  const r = o.exec(argv);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).split(/\r?\n/).find((l) => l.trim())?.trim();
    o.log(`failed (exit ${r.code}): ${shown}${why ? `: ${why}` : ""}`);
    return { failed: true, changed: false };
  }
  o.log(`ran     ${shown}`);
  return { failed: false, changed: true };
}

function claudeCode(verb: "add" | "remove", s: AppState, dryRun: boolean, o: McpOptions): Outcome {
  const configured = s.state === "configured" || s.state === "stale";
  if (verb === "add" && s.state === "configured") {
    o.log(`ok      claude-code (anynotate already configured)`);
    return { failed: false, changed: false };
  }
  if (verb === "remove" && !configured) {
    o.log(`ok      claude-code (anynotate not configured)`);
    return { failed: false, changed: false };
  }
  const bin = o.which("claude");
  const remove = [bin ?? "claude", "mcp", "remove", "--scope", "user", SERVER_NAME];
  const add = [bin ?? "claude", "mcp", "add", "--scope", "user", SERVER_NAME, "--", ...o.entry, "mcp"];
  const steps = verb === "remove" ? [remove] : configured ? [remove, add] : [add];
  if (!bin) {
    for (const argv of steps) o.log(`manual  claude is not on PATH; run: ${quoteArgv(argv, o.platform)}`);
    return { failed: false, changed: false };
  }
  let changed = false;
  for (const argv of steps) {
    const r = runClaude(argv, dryRun, o);
    if (r.failed) return { failed: true, changed };
    changed ||= r.changed;
  }
  return { failed: false, changed };
}

function describe(verb: "install" | "uninstall", o: McpOptions): void {
  o.log(`Apps that can run the anynotate MCP server (${verb} adds nothing until you pick one):`);
  for (const app of MCP_APPS) {
    const s = appState(app, o);
    const target = mcpTarget(app, o);
    const where = target.kind === "cli" ? `\`claude mcp ${verb === "install" ? "add" : "remove"} --scope user\`` : target.kind === "unsupported" ? "" : target.path;
    const flag = `--${app} ${verb === "install" ? "adds anynotate via" : "removes anynotate via"} ${where}`;
    const what = s.state === "unsupported" ? s.reason : `${s.state}${s.state === "unreadable" ? ` (${s.error})` : ""}; ${flag}`;
    o.log(`  ${LABEL[app].padEnd(15)} ${what}`);
  }
  o.log(`Run \`anynotate mcp ${verb} --<app> [--<app> …] [--dry-run]\`.`);
}

export function runMcpSetup(args: string[], o: McpOptions): number {
  const [verb, ...rest] = args;
  const apps: McpApp[] = [];
  let dryRun = false;
  for (const a of rest) {
    const app = MCP_APPS.find((x) => a === `--${x}`);
    if (app) apps.push(app);
    else if (a === "--dry-run") dryRun = true;
    else {
      o.log(MCP_SETUP_USAGE);
      return 1;
    }
  }
  if (verb !== "install" && verb !== "uninstall") {
    o.log(MCP_SETUP_USAGE);
    return 1;
  }
  if (!apps.length) {
    describe(verb, o);
    return 0;
  }
  const action = verb === "install" ? "add" : "remove";
  let failed = false;
  const changed: McpApp[] = [];
  for (const app of [...new Set(apps)]) {
    const s = appState(app, o);
    const target = mcpTarget(app, o);
    let r: Outcome;
    if (s.state === "unsupported") {
      o.log(`skip    ${app}: ${s.reason}`);
      continue;
    }
    if (s.state === "app not found") {
      o.log(`skip    ${app}: app not found`);
      continue;
    }
    if (target.kind === "cli") r = claudeCode(action, s, dryRun, o);
    else {
      const edit = target.kind === "json" ? (action === "add" ? (t: string) => setJsonServer(t, o.entry) : removeJsonServer) : action === "add" ? (t: string) => setTomlServer(t, o.entry) : removeTomlServer;
      r = editFile((target as { path: string }).path, edit, action, dryRun, o);
    }
    failed ||= r.failed;
    if (r.changed) changed.push(app);
  }
  for (const app of changed) {
    if (app === "claude-code") o.log(`Start a new Claude Code session to ${action === "add" ? "load" : "drop"} it.`);
    else o.log(`Restart ${LABEL[app]} to ${action === "add" ? "load" : "drop"} the anynotate server.`);
  }
  return failed ? 1 : 0;
}
