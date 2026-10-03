import { existsSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { runAnnotations } from "./agent/annotations";
import { runDeliver } from "./agent/deliver";
import { runInbox } from "./agent/inbox";
import { notifyArgv, STATUS_USAGE, summarizeChecks } from "./agent/status";
import { bunExec } from "./bridge/exec";
import { herdrBin } from "./bridge/herdr";
import { runHook } from "./agent/hook";
import { applyInstall, planInstall } from "./agent/install";
import { commandArgv, detectInstallKind, readInstallRecord } from "./agent/installkind";
import { applyUninstall, planUninstall } from "./agent/uninstall";
import { bridgePort, bridgeStatus, claimPidFile, type Control, detachBridge, ensureBridge, readHealth, stopBridge } from "./bridge/control";
import { formatChecks, runDoctor } from "./agent/doctor";
import { anynotateHome } from "./inbox/paths";
import { dryRunExec, spawnExec as platformExec } from "./platform/exec";
import { currentPlatform, installPaths } from "./platform/os";
import { detectUserSystemd, installedServiceFile, planService, runSteps } from "./platform/service";
import { runNativeHost } from "./agent/native-host";
import { callerOrigin, isNativeHostInvocation } from "./platform/nativehost";
import { selfUpdate } from "./agent/selfupdate";
import { runUpdate } from "./agent/update";
import { addOrigin, ORIGIN_RE, readOrigins, removeOrigin } from "./bridge/origins";
import { createBridge } from "./bridge/server";
import { loadOrCreateToken } from "./bridge/token";
import { describeRetention, pruneBundles, resolveRetention, startRetentionSweeps, writeRetentionSetting } from "./inbox/retention";
import { archiveOlderThan } from "./inbox/store";
import { Agent } from "@anynotate/protocol";
import { createMcpServer, serveStdio } from "./mcp/server";
import { anynotatePrompts, anynotateTools, MCP_INSTRUCTIONS } from "./mcp/tools";
import { MCP_SETUP_USAGE, runMcpSetup } from "./mcp/install";

function writeAll(data: string | Uint8Array) {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  for (let off = 0; off < buf.length; ) {
    try {
      off += writeSync(1, buf, off);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
    }
  }
}

async function nativeHost(argv: string[]): Promise<never> {
  // stdout is Chrome's protocol channel here: only the reply frame goes to it, everything else to stderr.
  try {
    await runNativeHost(argv, Bun.stdin.stream(), writeAll);
  } catch (err) {
    console.error(`anynotate native-host: ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

// Chrome launches the installed binary directly, with the caller's origin as the first argument.
if (isNativeHostInvocation(process.argv)) await nativeHost([callerOrigin(process.argv)!]);

const [cmd, ...rest] = process.argv.slice(2);
// Test-only: report external commands (service, registry, PATH, ACLs) instead of running them.
const externalDryRun = process.env.ANYNOTATE_EXTERNAL_DRYRUN === "1";
const exec = externalDryRun ? dryRunExec : platformExec;

function doctorChecks() {
  const port = bridgePort();
  return runDoctor({
    platform: currentPlatform(),
    home: homedir(),
    env: process.env,
    uid: process.getuid?.() ?? 0,
    version: pkg.version,
    exec,
    fetchHealth: () => readHealth(port),
    port,
    externalDryRun,
    mcpEntry: commandArgv(detectInstallKind()),
  });
}

switch (cmd) {
  case "--version":
  case "version":
    console.log(pkg.version);
    break;
  case "bridge": {
    const control: Control = {
      dataDir: anynotateHome(),
      logPath: join(anynotateHome(), "bridge.log"),
      port: bridgePort(),
      log: (line) => console.log(line),
      err: (line) => console.error(line),
    };
    if (rest.includes("--ensure")) {
      const serviceFile = installedServiceFile({ platform: currentPlatform(), home: homedir(), env: process.env, dataDir: control.dataDir }, existsSync);
      process.exit(await ensureBridge(control, [...commandArgv(detectInstallKind()), "bridge", "--pid-file"], serviceFile));
    }
    if (rest.includes("--detach")) process.exit(await detachBridge(control, [...commandArgv(detectInstallKind()), "bridge", "--pid-file"]));
    if (rest.includes("--stop")) process.exit(await stopBridge(control));
    if (rest.includes("--status")) process.exit(await bridgeStatus(control));
    const token = loadOrCreateToken();
    const fromEnv = (process.env.ANYNOTATE_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter((s) => ORIGIN_RE.test(s));
    const origins = [...new Set([...fromEnv, ...readOrigins()])];
    const { server } = createBridge({ token, port: control.port, allowedOrigins: origins });
    if (rest.includes("--pid-file")) claimPidFile(control.dataDir);
    const sweep = () => {
      try {
        for (const id of archiveOlderThan(30)) console.log(`archived ${id}`);
      } catch (err) {
        console.error("anynotate: archive sweep failed:", err);
      }
    };
    startRetentionSweeps();
    sweep();
    setInterval(sweep, 86_400_000);
    console.log(`anynotate bridge on http://127.0.0.1:${server.port} (origins: ${origins.join(", ") || "none"})`);
    break;
  }
  case "hook": {
    // A hook must never break the host CLI's prompt: any failure means "nothing to inject".
    try {
      const i = rest.indexOf("--agent");
      const agent = Agent.safeParse(i >= 0 ? rest[i + 1] : undefined);
      const out = agent.success ? runHook(agent.data, await Bun.stdin.text()) : "";
      // Synchronous: process.exit would drop whatever an async pipe write had not flushed.
      if (out) writeAll(out);
    } catch {}
    process.exit(0);
  }
  case "native-host":
    await nativeHost(rest);
  case "annotations":
    console.log(runAnnotations(rest));
    break;
  case "inbox":
    process.exit(
      await runInbox(rest, { stdin: process.stdin, stdout: process.stdout, env: process.env, log: (line) => console.log(line), err: (line) => console.error(line) }),
    );
  case "mcp": {
    if (rest[0] === "install" || rest[0] === "uninstall") {
      process.exit(
        runMcpSetup(rest, {
          platform: currentPlatform(),
          home: homedir(),
          env: process.env,
          entry: commandArgv(detectInstallKind()),
          which: (c) => Bun.which(c),
          exec,
          log: (line) => console.log(line),
        }),
      );
    }
    if (rest.length) {
      console.error(MCP_SETUP_USAGE);
      process.exit(1);
    }
    const server = createMcpServer({
      name: "anynotate",
      version: pkg.version,
      instructions: MCP_INSTRUCTIONS,
      tools: anynotateTools(),
      prompts: anynotatePrompts,
    });
    await serveStdio(server, Bun.stdin.stream(), writeAll);
    process.exit(0);
  }
  case "token":
    console.log(loadOrCreateToken());
    break;
  case "deliver":
    process.exit(await runDeliver(rest, { log: (line) => console.log(line), err: (line) => console.error(line) }));
  case "install": {
    if (rest.some((a) => a !== "--dry-run" && a !== "--no-hints")) {
      console.error("usage: anynotate install [--dry-run] [--no-hints]");
      process.exit(1);
    }
    const dry = rest.includes("--dry-run");
    const platform = currentPlatform();
    const steps = planInstall({
      platform,
      home: homedir(),
      env: process.env,
      kind: detectInstallKind(),
      version: pkg.version,
      uid: process.getuid?.() ?? 0,
      hasUserSystemd: platform === "linux" && detectUserSystemd(exec),
    });
    const log = applyInstall(steps, dry, { exec, platform, externalDryRun });
    for (const line of log) console.log(line);
    if (log.some((l) => l.startsWith("failed ("))) {
      console.error("anynotate install: some steps failed (see above)");
      process.exit(1);
    }
    break;
  }
  case "uninstall": {
    if (rest.some((a) => a !== "--purge" && a !== "--dry-run")) {
      console.error("usage: anynotate uninstall [--purge] [--dry-run]");
      process.exit(1);
    }
    const platform = currentPlatform();
    const home = homedir();
    const steps = planUninstall({
      platform,
      home,
      env: process.env,
      record: readInstallRecord(installPaths(platform, home, process.env).dataDir),
      kind: detectInstallKind(),
      purge: rest.includes("--purge"),
      uid: process.getuid?.() ?? 0,
      hasUserSystemd: platform === "linux" && detectUserSystemd(exec),
    });
    const log = applyUninstall(steps, exec, rest.includes("--dry-run"), { externalDryRun });
    for (const line of log) console.log(line);
    process.exit(log.some((l) => l.startsWith("failed") || l.startsWith("refused")) ? 1 : 0);
  }
  case "update": {
    if (rest.some((a) => a !== "--dry-run")) {
      console.error("usage: anynotate update [--dry-run]");
      process.exit(1);
    }
    const dryRun = rest.includes("--dry-run");
    const kind = detectInstallKind();
    const log = (line: string) => console.log(line);
    const err = (line: string) => console.error(line);
    if (kind.kind === "source") {
      process.exit(
        runUpdate({
          kind,
          exec,
          dryRun,
          log,
          err,
          readVersion: () => JSON.parse(readFileSync(join(kind.repo, "package.json"), "utf8")).version,
        }),
      );
    }
    const platform = currentPlatform();
    const home = homedir();
    const paths = installPaths(platform, home, process.env);
    const code = await selfUpdate({
      platform,
      arch: process.arch,
      current: pkg.version,
      exe: kind.exe,
      recordedPath: readInstallRecord(paths.dataDir)?.path,
      fetch,
      dryRun,
      log,
      err,
      stop: () => {
        const plan = planService({
          platform,
          home,
          env: process.env,
          exe: commandArgv(kind),
          logPath: paths.logPath,
          dataDir: paths.dataDir,
          uid: process.getuid?.() ?? 0,
          hasUserSystemd: platform === "linux" && detectUserSystemd(exec),
        });
        const r = runSteps(plan.stop, exec, false);
        for (const line of r.log) log(line);
        return r.ok;
      },
      reinstall: (exe) => {
        const r = exec([exe, "install", "--no-hints"]);
        if (r.stdout.trim()) log(r.stdout.trimEnd());
        if (r.stderr.trim()) err(r.stderr.trimEnd());
        return r.code;
      },
    });
    process.exit(code);
  }
  case "doctor": {
    const { text, code } = formatChecks(await doctorChecks());
    process.stdout.write(text);
    process.exit(code);
  }
  case "status": {
    if (rest.some((a) => a !== "--notify")) {
      console.error(STATUS_USAGE);
      process.exit(1);
    }
    const { line, code } = summarizeChecks(await doctorChecks(), pkg.version);
    console.log(line);
    if (rest.includes("--notify")) {
      const r = await bunExec(notifyArgv(herdrBin(), line), 5000);
      if (r.code !== 0) {
        const why = (r.stderr || r.stdout).split(/\r?\n/).find((l) => l.trim())?.trim();
        console.error(`anynotate: could not send the herdr notification (exit ${r.code}${why ? `: ${why}` : ""})`);
      }
    }
    process.exit(code);
  }
  case "retention": {
    try {
      if (rest[0] !== undefined) {
        writeRetentionSetting(rest[0]);
        console.log(`retention set to ${describeRetention(resolveRetention({}))}`);
        if (process.env.ANYNOTATE_RETENTION_DAYS?.trim()) console.log("Note: ANYNOTATE_RETENTION_DAYS is set and takes precedence.");
        break;
      }
      const r = resolveRetention();
      if (r.warning) console.error(`anynotate: ${r.warning}`);
      console.log(`retention ${describeRetention(r)}`);
    } catch (err) {
      console.error(`anynotate: ${(err as Error).message}`);
      console.log("usage: anynotate retention [<days>|off]");
      process.exit(1);
    }
    break;
  }
  case "prune": {
    if (rest.some((a) => a !== "--dry-run")) {
      console.error("usage: anynotate prune [--dry-run]");
      process.exit(1);
    }
    const dryRun = rest.includes("--dry-run");
    const r = resolveRetention();
    if (r.warning) console.error(`anynotate: ${r.warning}`);
    if (r.days === null) {
      console.log("retention is off; nothing pruned");
      break;
    }
    const { pruned } = pruneBundles(r.days, { dryRun });
    for (const id of pruned) console.log(`${dryRun ? "would prune" : "pruned"} ${id}`);
    console.log(`${dryRun ? "would prune" : "pruned"} ${pruned.length} bundle(s) older than ${r.days} days`);
    break;
  }
  case "origin": {
    const [sub, value] = rest;
    try {
      if (sub === "list") {
        for (const o of readOrigins()) console.log(o);
        break;
      }
      if (sub === "add" && value) {
        console.log(addOrigin(value).added ? `added ${value}` : `already present ${value}`);
        console.log("Re-run `anynotate install` so the bridge and the Chrome helper allow it.");
        break;
      }
      if (sub === "remove" && value) {
        console.log(removeOrigin(value).removed ? `removed ${value}` : `not present ${value}`);
        break;
      }
    } catch (err) {
      console.error(`anynotate: ${(err as Error).message}`);
      process.exit(1);
    }
    console.log("usage: anynotate origin <add <origin>|list|remove <origin>>");
    process.exit(1);
  }
  default:
    console.log("usage: anynotate <--version|bridge [--ensure|--detach|--stop|--status]|hook --agent <name>|annotations [id|latest]|deliver <id|latest> --pane <pane-id> [--dry-run]|inbox [--select <id|latest>] [--plain]|mcp [install|uninstall [--<app>] [--dry-run]]|token|install [--dry-run] [--no-hints]|doctor|status [--notify]|uninstall [--purge] [--dry-run]|update [--dry-run]|native-host <origin>|origin <add <o>|list|remove <o>>|retention [<days>|off]|prune [--dry-run]>");
    process.exit(cmd ? 1 : 0);
}
