import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runAnnotations } from "./agent/annotations";
import { runHook } from "./agent/hook";
import { applyInstall, planInstall } from "./agent/install";
import { addOrigin, readOrigins, removeOrigin } from "./bridge/origins";
import { createBridge } from "./bridge/server";
import { loadOrCreateToken } from "./bridge/token";
import { archiveOlderThan } from "./inbox/store";
import { Agent } from "@anynotate/protocol";

function writeAll(text: string) {
  const buf = Buffer.from(text);
  for (let off = 0; off < buf.length; ) {
    try {
      off += writeSync(1, buf, off);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const repo = resolve(import.meta.dir, "..");

switch (cmd) {
  case "bridge": {
    const token = loadOrCreateToken();
    const fromEnv = (process.env.ANYNOTATE_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const origins = [...new Set([...fromEnv, ...readOrigins()])];
    const { server } = createBridge({ token, port: Number(process.env.ANYNOTATE_PORT ?? 47291), allowedOrigins: origins });
    const sweep = () => {
      try {
        for (const id of archiveOlderThan(30)) console.log(`archived ${id}`);
      } catch (err) {
        console.error("anynotate: archive sweep failed:", err);
      }
    };
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
  case "annotations":
    console.log(runAnnotations(rest));
    break;
  case "token":
    console.log(loadOrCreateToken());
    break;
  case "install": {
    const dry = rest.includes("--dry-run");
    const steps = planInstall({ home: homedir(), anynotateBin: join(repo, "bin/anynotate"), repo });
    const log = applyInstall(steps, dry);
    for (const line of log) console.log(line);
    if (!dry) console.log("Next: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.anynotate.bridge.plist");
    if (!dry && log.some((l) => l.startsWith("added   origin"))) {
      console.log("If the bridge was already running: launchctl kickstart -k gui/$(id -u)/dev.anynotate.bridge");
    }
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
        console.log("Restart the bridge: launchctl kickstart -k gui/$(id -u)/dev.anynotate.bridge");
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
    console.log("usage: anynotate <bridge|hook --agent <name>|annotations [id|latest]|token|install [--dry-run]|origin <add <o>|list|remove <o>>>");
    process.exit(cmd ? 1 : 0);
}
