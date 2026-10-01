import { readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { runAnnotations } from "./agent/annotations";
import { runHook } from "./agent/hook";
import { applyInstall, planInstall } from "./agent/install";
import { commandArgv, detectInstallKind, readInstallRecord } from "./agent/installkind";
import { applyUninstall, planUninstall } from "./agent/uninstall";
import { bridgePort, bridgeStatus, claimPidFile, type Control, detachBridge, stopBridge } from "./bridge/control";
import { anynotateHome } from "./inbox/paths";
import { dryRunExec, spawnExec as platformExec } from "./platform/exec";
import { currentPlatform, installPaths } from "./platform/os";
import { detectUserSystemd } from "./platform/service";
import { runNativeHost } from "./agent/native-host";
import { callerOrigin, isNativeHostInvocation } from "./platform/nativehost";
import { runUpdate, spawnExec } from "./agent/update";
import { addOrigin, ORIGIN_RE, readOrigins, removeOrigin } from "./bridge/origins";
import { createBridge } from "./bridge/server";
import { loadOrCreateToken } from "./bridge/token";
import { describeRetention, pruneBundles, resolveRetention, startRetentionSweeps, writeRetentionSetting } from "./inbox/retention";
import { archiveOlderThan } from "./inbox/store";
import { Agent } from "@anynotate/protocol";

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
const repo = resolve(import.meta.dir, "..");

switch (cmd) {
  case "bridge": {
    const control: Control = {
      dataDir: anynotateHome(),
      logPath: join(anynotateHome(), "bridge.log"),
      port: bridgePort(),
      log: (line) => console.log(line),
      err: (line) => console.error(line),
    };
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
  case "token":
    console.log(loadOrCreateToken());
    break;
  case "install": {
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
    const code = runUpdate({
      repo,
      uid: process.getuid?.() ?? 501,
      exec: spawnExec,
      dryRun: rest.includes("--dry-run"),
      log: (line) => console.log(line),
      err: (line) => console.error(line),
      readVersion: () => JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version,
    });
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
    console.log("usage: anynotate <bridge [--detach|--stop|--status]|hook --agent <name>|annotations [id|latest]|token|install [--dry-run]|uninstall [--purge] [--dry-run]|update [--dry-run]|native-host <origin>|origin <add <o>|list|remove <o>>|retention [<days>|off]|prune [--dry-run]>");
    process.exit(cmd ? 1 : 0);
}
