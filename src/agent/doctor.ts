import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "@anynotate/protocol";
import { bridgePort, type Health } from "../bridge/control";
import { describeRetention, resolveRetention, type Retention } from "../inbox/retention";
import type { Exec } from "../platform/exec";
import { isPrivate as fileIsPrivate } from "../platform/files";
import { HOST_NAME } from "../platform/nativehost";
import { BROWSERS, browserConfigRoot, browserRegistryKey, type Browser, type Env, installPaths, pathFor, type Platform } from "../platform/os";
import { LAUNCHD_LABEL, planService, SYSTEMD_UNIT, WINDOWS_TASK } from "../platform/service";
import { HOOKED_CLIS, isAnynotateHook } from "./install";
import { INSTALL_RECORD, type InstallRecord } from "./installkind";
import { mcpChecks } from "../mcp/install";
import { EXPECTED_EXTENSION, EXTENSION_FILE, EXTENSION_UPDATE_HINT, extensionIsOlder, parseSender, UNKNOWN_EXTENSION } from "../bridge/extension-version";

// ok is false for a failed required check, "warn" for something worth fixing that doesn't stop Anynotate working.
// skipped marks a check an external dry run did not perform; it shows as a warning and is counted separately.
// extension is the version the bridge last saw an extension report (UNKNOWN_EXTENSION for one too old to say).
export type Check = { name: string; ok: boolean | "warn"; detail: string; skipped?: true; mcp?: "configured" | "missing" | "off"; extension?: string };

export type DoctorOptions = {
  platform: Platform;
  home: string;
  env: Env;
  uid: number;
  // The version of this CLI, compared with install.json and the running bridge.
  version: string;
  exec: Exec;
  fetchHealth: () => Promise<Health | null>;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  isExecutable?: (path: string) => boolean;
  isPrivate?: (path: string) => boolean | "unknown";
  which?: (cmd: string) => string | null;
  retention?: () => Retention;
  port?: number;
  // Report the checks that run external commands (service, registry) as skipped instead of running them.
  externalDryRun?: boolean;
  // The anynotate command line apps should run as their MCP server; without it the MCP checks are left out.
  mcpEntry?: string[];
};

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const SKIPPED = "skipped (dry run)";
const TOKEN_RE = /^[0-9a-f]{64}$/;

// reg.exe writes in the console's OEM/ANSI code page, so only an ASCII path can be found in its output reliably.
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);
const regValue = (stdout: string) => /REG_\w+\s+(.*?)\s*$/m.exec(stdout)?.[1] ?? stdout.trim();
const why = (r: { code: number; stderr: string }) => {
  const line = r.stderr.split(/\r?\n/).find((l) => l.trim())?.trim();
  return ` (exit ${r.code}${line ? `: ${line}` : ""})`;
};
const skipped = (name: string, detail: string): Check => ({ name, ok: "warn", detail, skipped: true });

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export async function runDoctor(o: DoctorOptions): Promise<Check[]> {
  const { platform, home, env, exec } = o;
  const exists = o.exists ?? existsSync;
  const readFile = o.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const isExecutable = o.isExecutable ?? (platform === "win32" ? exists : executable);
  const which = o.which ?? ((cmd: string) => Bun.which(cmd));
  const path = pathFor(platform);
  const paths = installPaths(platform, home, env);
  const { dataDir } = paths;
  const port = o.port ?? bridgePort(env);
  const read = (p: string) => {
    try {
      return readFile(p);
    } catch {
      return null;
    }
  };
  const parse = (p: string): unknown => {
    const text = read(p);
    if (text === null) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const r = parse(path.join(dataDir, INSTALL_RECORD)) as Partial<InstallRecord> | null | undefined;
  const record = r && (r.kind === "binary" || r.kind === "source") && typeof r.path === "string" && typeof r.version === "string" ? (r as InstallRecord) : null;

  const install = (): Check => {
    const name = "install";
    if (r === undefined) return { name, ok: false, detail: `no ${path.join(dataDir, INSTALL_RECORD)} — run \`anynotate install\`` };
    if (!record) return { name, ok: false, detail: `${path.join(dataDir, INSTALL_RECORD)} is unreadable — run \`anynotate install\`` };
    const { kind, version, path: at } = record;
    if (!exists(at)) return { name, ok: false, detail: `${kind} ${version} at ${at}, which is missing — reinstall` };
    if (version !== o.version) return { name, ok: "warn", detail: `${kind} ${version} at ${at}; this is ${o.version} — run \`anynotate install\`` };
    return { name, ok: true, detail: `${kind} ${version} at ${at}` };
  };

  const onPath = (): Check => {
    const name = "on PATH";
    const found = which("anynotate");
    if (!found) return { name, ok: "warn", detail: `anynotate is not on PATH — add ${paths.binDir}` };
    const same = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (record?.kind === "binary" && !same(found, record.path)) return { name, ok: "warn", detail: `${found} runs, but the install is ${record.path}` };
    return { name, ok: true, detail: found };
  };

  const service = (): Check => {
    const name = "service";
    const plan = (hasUserSystemd: boolean) =>
      planService({ platform, home, env, exe: ["anynotate"], logPath: paths.logPath, dataDir, uid: o.uid, hasUserSystemd });
    if (platform === "linux") {
      const unit = plan(true).files[0]!.path;
      const desktop = plan(false).files[0]!.path;
      if (exists(unit)) {
        if (o.externalDryRun) return skipped(name, SKIPPED);
        const res = exec(["systemctl", "--user", "is-enabled", SYSTEMD_UNIT]);
        return res.code === 0
          ? { name, ok: true, detail: `${SYSTEMD_UNIT} enabled (systemd)` }
          : { name, ok: false, detail: `${unit} exists but ${SYSTEMD_UNIT} is not enabled${why(res)} — run \`anynotate install\`` };
      }
      if (exists(desktop)) return { name, ok: true, detail: `autostart entry ${desktop}` };
      return { name, ok: false, detail: `no ${unit} or ${desktop} — run \`anynotate install\`` };
    }
    const file = plan(false).files[0]!.path;
    if (!exists(file)) return { name, ok: false, detail: `no ${file} — run \`anynotate install\`` };
    if (o.externalDryRun) return skipped(name, SKIPPED);
    if (platform === "darwin") {
      const res = exec(["launchctl", "print", `gui/${o.uid}/${LAUNCHD_LABEL}`]);
      return res.code === 0
        ? { name, ok: true, detail: `${LAUNCHD_LABEL} loaded` }
        : { name, ok: false, detail: `${file} exists but ${LAUNCHD_LABEL} is not loaded${why(res)} — run \`anynotate install\`` };
    }
    const res = exec(["reg", "query", RUN_KEY, "/v", WINDOWS_TASK]);
    if (res.code !== 0) return { name, ok: false, detail: `no Run value "${WINDOWS_TASK}" in ${RUN_KEY}${why(res)} — run \`anynotate install\`` };
    if (res.stdout.toLowerCase().includes(file.toLowerCase())) return { name, ok: true, detail: `Run value "${WINDOWS_TASK}" starts ${file}` };
    if (!isAscii(file)) return { name, ok: true, detail: `Run value "${WINDOWS_TASK}" present` };
    return { name, ok: "warn", detail: `Run value "${WINDOWS_TASK}" is ${regValue(res.stdout)}, not ${file} — run \`anynotate install\`` };
  };

  const bridge = async (): Promise<Check> => {
    const name = "bridge";
    const url = `http://127.0.0.1:${port}/health`;
    const h = await o.fetchHealth();
    if (!h) return { name, ok: false, detail: `not answering on ${url} — see ${paths.logPath}` };
    const detail = `running on ${url}, version ${h.bridgeVersion}, protocol ${h.protocol.version}`;
    if (h.protocol.version !== PROTOCOL_VERSION) return { name, ok: false, detail: `${detail}; this CLI speaks protocol ${PROTOCOL_VERSION}` };
    if (h.bridgeVersion !== o.version) return { name, ok: "warn", detail: `${detail}; this is ${o.version} — restart the bridge` };
    return { name, ok: true, detail };
  };

  const token = (): Check => {
    const name = "token";
    const file = path.join(dataDir, "token");
    const text = read(file);
    if (text === null) return { name, ok: false, detail: `no ${file} — start the bridge or run \`anynotate token\`` };
    if (!TOKEN_RE.test(text.trim())) return { name, ok: false, detail: `${file} is malformed — run \`anynotate token\` to replace it` };
    let priv: boolean | "unknown";
    try {
      priv = (o.isPrivate ?? ((p: string) => fileIsPrivate(p, platform)))(file);
    } catch {
      priv = "unknown";
    }
    if (priv === false) return { name, ok: "warn", detail: `${file} is readable by other users — chmod 600 it` };
    return { name, ok: true, detail: priv === "unknown" ? `${file} (permissions not checked)` : `${file} (private)` };
  };

  const manifestProblem = (file: string): string | null => {
    const m = parse(file) as { path?: unknown } | null | undefined;
    if (m === undefined) return `no manifest at ${file}`;
    if (typeof m?.path !== "string") return `${file} is not a valid manifest`;
    if (!exists(m.path)) return `${file} points at ${m.path}, which is missing`;
    if (!isExecutable(m.path)) return `${file} points at ${m.path}, which is not executable`;
    return null;
  };

  const nativeHost = (b: Browser): Check => {
    const name = `native host (${b})`;
    const fail = b === "chrome" ? false : "warn";
    const fix = " — run `anynotate install`";
    if (platform !== "win32") {
      const file = path.join(browserConfigRoot(platform, b, home, env), "NativeMessagingHosts", `${HOST_NAME}.json`);
      const problem = manifestProblem(file);
      return problem ? { name, ok: fail, detail: problem + fix } : { name, ok: true, detail: file };
    }
    const file = path.join(dataDir, `${HOST_NAME}.json`);
    const problem = manifestProblem(file);
    if (problem) return { name, ok: fail, detail: problem + fix };
    const key = browserRegistryKey(b);
    if (o.externalDryRun) return skipped(name, `${file}; registry ${SKIPPED}`);
    const res = exec(["reg", "query", key, "/ve"]);
    if (res.code !== 0) return { name, ok: fail, detail: `${key} is not registered${why(res)}${fix}` };
    if (!res.stdout.toLowerCase().includes(file.toLowerCase())) {
      const detail = `${key} is ${regValue(res.stdout)}, expected ${file}`;
      return isAscii(file) ? { name, ok: fail, detail: detail + fix } : { name, ok: "warn", detail: `${detail} (non-ASCII path, compared as reg.exe printed it)` };
    }
    return { name, ok: true, detail: `${key} → ${file}` };
  };

  const hooks = (cli: string, settings: string): Check => {
    const name = `hooks (${cli})`;
    if (which(cli) === null && !exists(path.join(home, `.${cli}`))) return { name, ok: true, detail: `${cli} not installed (skipped)` };
    const file = path.join(home, ...settings.split("/"));
    const config = parse(file) as { hooks?: Record<string, unknown> } | null | undefined;
    if (config === null) return { name, ok: "warn", detail: `${file} is not valid JSON` };
    const commands = Object.values(config?.hooks ?? {})
      .flatMap((groups) => (Array.isArray(groups) ? groups : []))
      .flatMap((g: any) => (Array.isArray(g?.hooks) ? g.hooks : []))
      .map((h: any) => h?.command)
      .filter((c): c is string => isAnynotateHook(c, cli));
    if (commands.length === 0) return { name, ok: "warn", detail: `no anynotate hook in ${file} — run \`anynotate install\`` };
    for (const command of commands) {
      const tokens = command.slice(0, command.lastIndexOf(" hook --agent ")).match(/"[^"]*"|\S+/g) ?? [];
      for (const t of tokens.map((t) => t.replace(/^"|"$/g, ""))) {
        if (!/[\\/]/.test(t)) return { name, ok: "warn", detail: `hook runs a bare \`${t}\` — run \`anynotate install\`` };
        if (!exists(t)) return { name, ok: "warn", detail: `hook runs ${t}, which is missing — run \`anynotate install\`` };
      }
    }
    return { name, ok: true, detail: `${commands[0]} in ${file}` };
  };

  const extension = (): Check => {
    const name = "extension";
    const seen = parseSender(read(path.join(dataDir, EXTENSION_FILE)));
    if (!seen) return { name, ok: true, detail: "none has connected to the bridge yet" };
    if (!extensionIsOlder(seen)) return { name, ok: true, detail: `${seen} last seen`, extension: seen };
    const what = seen === UNKNOWN_EXTENSION ? "an older extension (no version reported)" : seen;
    return { name, ok: "warn", detail: `${what} last seen; ${EXPECTED_EXTENSION} or later is expected — ${EXTENSION_UPDATE_HINT}`, extension: seen };
  };

  const retention = (): Check => {
    const r = (o.retention ?? (() => resolveRetention(env)))();
    return r.warning ? { name: "retention", ok: "warn", detail: r.warning } : { name: "retention", ok: true, detail: describeRetention(r) };
  };

  const present = BROWSERS.filter((b) => b === "chrome" || exists(browserConfigRoot(platform, b, home, env)));
  return [
    install(),
    onPath(),
    service(),
    await bridge(),
    token(),
    extension(),
    ...present.map(nativeHost),
    ...HOOKED_CLIS.map(({ cli, settings }) => hooks(cli, settings)),
    ...(o.mcpEntry ? mcpChecks({ platform, home, env, entry: o.mcpEntry, which, exec, log: () => {}, exists, readFile }) : []),
    retention(),
  ];
}

const SYMBOL = (ok: Check["ok"]) => (ok === true ? "✓" : ok === false ? "✗" : "!");

// Exit 1 only when a required check failed; warnings and skipped checks are listed but leave the exit code at 0.
export function formatChecks(checks: Check[]): { text: string; code: number } {
  const lines = checks.map((c) => `${SYMBOL(c.ok)} ${c.name}  ${c.detail}`);
  const failed = checks.filter((c) => c.ok === false).length;
  const warnings = checks.filter((c) => c.ok === "warn" && !c.skipped).length;
  const skippedCount = checks.filter((c) => c.skipped).length;
  const parts = [
    failed ? `${failed} failed` : "",
    warnings ? `${warnings} warning(s)` : "",
    skippedCount ? `${skippedCount} skipped` : "",
  ].filter(Boolean);
  lines.push(parts.length === 0 ? "All checks passed." : `${parts.join(", ")} — see above.`);
  return { text: `${lines.join("\n")}\n`, code: failed > 0 ? 1 : 0 };
}
