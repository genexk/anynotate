import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";
import { type Exec, regQueryFor } from "./exec";
import { BROWSERS, browserConfigRoot, browserRegistryKey, type Env, type Platform } from "./os";

export const HOST_NAME = "dev.anynotate.host";

// Chrome launches a host as `<host> <origin>` (plus `--parent-window=N` on Windows). Bun's argv always starts with
// the runtime and the entry point, under bun ["bun", "/…/cli.ts", origin] and compiled ["bun", "/$bunfs/root/…",
// origin], so the origin is argv[2]; argv[1] is accepted too, for a runtime that reports no entry point.
export function isNativeHostInvocation(argv: string[]): boolean {
  return argv.slice(1).some((a, i) => i < 2 && a.startsWith("chrome-extension://"));
}

export const callerOrigin = (argv: string[]) => argv.slice(1, 3).find((a) => a.startsWith("chrome-extension://"));

// Chrome only matches allowed_origins written as `chrome-extension://<id>/`.
export function hostManifest(hostPath: string, origins: string[]) {
  return {
    name: HOST_NAME,
    description: "Anynotate helper",
    path: hostPath,
    type: "stdio",
    allowed_origins: origins.map((o) => (o.endsWith("/") ? o : `${o}/`)),
  };
}

export type HostStep =
  | { kind: "write-manifest"; path: string; json: string }
  | { kind: "reg-add"; key: string; manifestPath: string }
  | { kind: "remove-manifest"; path: string }
  | { kind: "reg-delete"; key: string };

export type HostTarget = { platform: Platform; home: string; env: Env; hostPath: string; dataDir: string; exists: (path: string) => boolean };

const manifestName = `${HOST_NAME}.json`;
const winManifest = (dataDir: string) => win32.join(dataDir, manifestName);
const unixManifest = (o: HostTarget, b: (typeof BROWSERS)[number]) =>
  posix.join(browserConfigRoot(o.platform, b, o.home, o.env), "NativeMessagingHosts", manifestName);

// Unix browsers each read their own NativeMessagingHosts dir; Windows browsers find the one manifest via the registry.
export function planNativeHost(o: HostTarget & { origins: string[] }): HostStep[] {
  const json = `${JSON.stringify(hostManifest(o.hostPath, o.origins), null, 2)}\n`;
  if (o.platform === "win32") {
    const manifestPath = winManifest(o.dataDir);
    return [{ kind: "write-manifest", path: manifestPath, json }, ...BROWSERS.map((b): HostStep => ({ kind: "reg-add", key: browserRegistryKey(b), manifestPath }))];
  }
  return BROWSERS.filter((b) => b === "chrome" || o.exists(browserConfigRoot(o.platform, b, o.home, o.env))).map((b) => ({
    kind: "write-manifest",
    path: unixManifest(o, b),
    json,
  }));
}

export function planNativeHostRemoval(o: HostTarget): HostStep[] {
  if (o.platform === "win32") {
    return [{ kind: "remove-manifest", path: winManifest(o.dataDir) }, ...BROWSERS.map((b): HostStep => ({ kind: "reg-delete", key: browserRegistryKey(b) }))];
  }
  return BROWSERS.map((b) => ({ kind: "remove-manifest", path: unixManifest(o, b) }));
}

// Quoted for a .cmd file, where % would otherwise start a variable expansion.
export const cmdArgv = (argv: string[]) => argv.map((a) => `"${a.replace(/%/g, "%%")}"`).join(" ");

// A source install has no binary for Chrome to launch, so a wrapper runs the CLI under bun.
// Chrome starts hosts with a minimal PATH, so bun is named by absolute path.
export function sourceHostWrapper(platform: Platform, bun: string, repo: string, dataDir: string): { path: string; content: string } {
  if (platform === "win32") {
    return { path: win32.join(dataDir, "native-host.cmd"), content: `@${cmdArgv([bun, win32.join(repo, "src", "cli.ts")])} native-host %*\r\n` };
  }
  return { path: posix.join(dataDir, "native-host"), content: `#!/bin/sh\nexec "${bun}" "${posix.join(repo, "src/cli.ts")}" native-host "$@"\n` };
}

export const isRegistryStep = (h: HostStep) => h.kind === "reg-add" || h.kind === "reg-delete";

function reg(exec: Exec, argv: string[]) {
  const r = exec(argv);
  if (r.code !== 0) throw new Error(`${argv.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
}

export function applyHostSteps(steps: HostStep[], exec: Exec, dryRun: boolean): string[] {
  const log: string[] = [];
  for (const s of steps) {
    switch (s.kind) {
      case "write-manifest": {
        if (existsSync(s.path) && readFileSync(s.path, "utf8") === s.json) { log.push(`ok      ${s.path}`); break; }
        if (dryRun) { log.push(`would write ${s.path}`); break; }
        mkdirSync(dirname(s.path), { recursive: true });
        writeFileSync(s.path, s.json);
        log.push(`wrote   ${s.path}`);
        break;
      }
      case "remove-manifest": {
        if (!existsSync(s.path)) break;
        if (dryRun) { log.push(`would remove ${s.path}`); break; }
        rmSync(s.path, { force: true });
        log.push(`removed ${s.path}`);
        break;
      }
      case "reg-add": {
        if (dryRun) { log.push(`would register ${s.key} → ${s.manifestPath}`); break; }
        reg(exec, ["reg", "add", s.key, "/ve", "/t", "REG_SZ", "/d", s.manifestPath, "/f"]);
        log.push(`registered ${s.key} → ${s.manifestPath}`);
        break;
      }
      case "reg-delete": {
        if (dryRun) { log.push(`would unregister ${s.key}`); break; }
        const argv = ["reg", "delete", s.key, "/f"];
        if (exec(regQueryFor(argv)).code === 1) { log.push(`ok      ${s.key} (already gone)`); break; }
        reg(exec, argv);
        log.push(`unregistered ${s.key}`);
        break;
      }
    }
  }
  return log;
}
