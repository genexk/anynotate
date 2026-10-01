// Post-install smoke test for a release binary, run after install.sh / install.ps1 on each OS.
// usage: bun scripts/smoke.ts
//
// Checks the bridge answers /health, the Chrome native host is registered and answers a token request, the Claude
// Code and Codex hooks are written with the absolute binary path and run cleanly through the shells agents use,
// `doctor` passes, and `uninstall` removes the service, native-host registrations and hooks again.
// ~/.claude and ~/.codex must exist before the install so that it hooks both.
//
// Environment:
//   SMOKE_LOCAL=1  the install ran with ANYNOTATE_EXTERNAL_DRYRUN=1 into a temporary HOME, so no service manager or
//                  registry was touched: the smoke test starts and stops the bridge itself and skips registry checks.
//   ANYNOTATE_PORT the bridge port (default 47291).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { PROTOCOL_VERSION } from "@anynotate/protocol";
import pkg from "../package.json";
import { HOOKED_CLIS, hookCommand, isAnynotateHook } from "../src/agent/install";
import { decodeMessage, encodeMessage } from "../src/agent/native-host";
import { bridgePort, readHealth } from "../src/bridge/control";
import { tokenPath } from "../src/inbox/paths";
import { spawnExec } from "../src/platform/exec";
import { HOST_NAME } from "../src/platform/nativehost";
import { BROWSERS, browserConfigRoot, browserRegistryKey, currentPlatform, installPaths, pathFor } from "../src/platform/os";
import { detectUserSystemd, planService, WINDOWS_TASK } from "../src/platform/service";

const EXTENSION_ORIGIN = "chrome-extension://epdjidoapjkdefnpaibacfepphipdioh/";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const local = process.env.SMOKE_LOCAL === "1";
const platform = currentPlatform();
const home = homedir();
const env = process.env;
const path = pathFor(platform);
const paths = installPaths(platform, home, env);
const bin = paths.binPath;
const port = bridgePort(env);

class SmokeFailure extends Error {}
const fail = (message: string): never => {
  throw new SmokeFailure(message);
};
const check = (cond: unknown, message: string) => {
  if (!cond) fail(message);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function step(name: string, fn: () => unknown | Promise<unknown>) {
  console.log(`\n== ${name}`);
  await fn();
  console.log(`ok   ${name}`);
}

function run(argv: string[]): { code: number; out: string } {
  console.log(`$ ${argv.join(" ")}`);
  const r = spawnExec(argv);
  const out = `${r.stdout}${r.stderr}`;
  if (out.trim()) console.log(out.trimEnd());
  return { code: r.code, out };
}

const reg = (argv: string[]) => spawnExec(["reg", "query", ...argv]).code;

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(250);
  }
  if (!(await cond())) fail(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
}

// selfupdate follows GitHub's release redirects by hand; that needs fetch to hand back the 3xx and its Location.
async function checkManualRedirect() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/relative") return new Response(null, { status: 302, headers: { Location: "/asset" } });
      if (url.pathname === "/absolute") return new Response(null, { status: 302, headers: { Location: `http://localhost:${srv.port}/asset` } });
      if (url.pathname === "/asset") return new Response("asset-bytes");
      return new Response("not found", { status: 404 });
    },
  });
  try {
    for (const [route, expected] of [
      ["/relative", "/asset"],
      ["/absolute", `http://localhost:${server.port}/asset`],
    ] as const) {
      const start = `http://127.0.0.1:${server.port}${route}`;
      const res = await fetch(start, { redirect: "manual" });
      const location = res.headers.get("location");
      check(res.status === 302, `${route}: expected 302 with redirect: "manual", got ${res.status}`);
      check(location === expected, `${route}: expected Location ${expected}, got ${location}`);
      const final = await fetch(new URL(location!, start), { redirect: "manual" });
      check(final.status === 200 && (await final.text()) === "asset-bytes", `${route}: following Location did not reach the asset`);
    }
  } finally {
    server.stop(true);
  }
}

const servicePlan = (hasUserSystemd: boolean) =>
  planService({ platform, home, env, exe: [bin], logPath: paths.logPath, dataDir: paths.dataDir, uid: process.getuid?.() ?? 0, hasUserSystemd });

const manifestPaths = () =>
  platform === "win32"
    ? [path.join(paths.dataDir, `${HOST_NAME}.json`)]
    : BROWSERS.map((b) => path.join(browserConfigRoot(platform, b, home, env), "NativeMessagingHosts", `${HOST_NAME}.json`));

const chromeManifest = () =>
  platform === "win32" ? path.join(paths.dataDir, `${HOST_NAME}.json`) : path.join(browserConfigRoot(platform, "chrome", home, env), "NativeMessagingHosts", `${HOST_NAME}.json`);

// Spawns the host the way Chrome does: the caller's origin as the first argument (plus --parent-window on Windows).
async function nativeRoundTrip(hostPath: string): Promise<unknown> {
  const argv = [hostPath, EXTENSION_ORIGIN, ...(platform === "win32" ? ["--parent-window=0"] : [])];
  console.log(`$ ${argv.join(" ")} <<< {"type":"token"}`);
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(encodeMessage({ type: "token" }));
  await proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (err.trim()) console.log(err.trimEnd());
  check(code === 0, `native host exited ${code}`);
  const decoded = decodeMessage(out);
  check(decoded !== null, `native host reply is not a complete frame (${out.length} bytes)`);
  return decoded!.value;
}

function anynotateHooks(): string[] {
  return HOOKED_CLIS.flatMap(({ cli, settings }) => {
    const file = path.join(home, ...settings.split("/"));
    if (!existsSync(file)) return [];
    const config = JSON.parse(readFileSync(file, "utf8"));
    const groups = Object.values<any>(config?.hooks ?? {}).flat();
    return groups.flatMap((g: any) => (g?.hooks ?? []).map((h: any) => h?.command)).filter((c) => isAnynotateHook(c, cli)).map((c) => `${file}: ${c}`);
  });
}

// Runs a hook command line the way an agent would: through sh, or on Windows through both cmd and Git Bash.
function hookShells(): { name: string; argv: string[]; verbatim?: boolean }[] {
  if (platform !== "win32") return [{ name: "sh", argv: ["sh", "-c"] }];
  const gitBash = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find((b) => existsSync(b));
  check(gitBash, "Git Bash was not found under C:\\Program Files\\Git");
  return [
    { name: "cmd", argv: ["cmd.exe", "/d", "/s", "/c"], verbatim: true },
    { name: "Git Bash", argv: [gitBash!, "-c"] },
  ];
}

function runHookCommand(command: string) {
  for (const shell of hookShells()) {
    const argv = [...shell.argv, shell.verbatim ? `"${command}"` : command];
    console.log(`$ ${argv.join(" ")} <<< {}`);
    const proc = Bun.spawnSync(argv, { stdin: Buffer.from("{}"), stdout: "pipe", stderr: "pipe", windowsVerbatimArguments: shell.verbatim });
    const out = proc.stdout.toString();
    const err = proc.stderr.toString();
    if (err.trim()) console.log(err.trimEnd());
    check(proc.exitCode === 0, `${shell.name}: hook exited ${proc.exitCode}`);
    check(out.trim() === "", `${shell.name}: hook delivered output with an empty inbox: ${out.trim()}`);
  }
}

async function main() {
  console.log(`smoke: ${platform}/${process.arch}, ${local ? "local (external commands dry-run)" : "real install"}, home ${home}, port ${port}`);
  const hasUserSystemd = platform === "linux" && !local && detectUserSystemd(spawnExec);
  const service = servicePlan(hasUserSystemd);
  let hooks: string[] = [];

  await step("fetch with redirect: \"manual\" returns the 3xx and its Location", checkManualRedirect);

  await step(`binary installed at ${bin} reports ${pkg.version}`, () => {
    check(existsSync(bin), `${bin} does not exist`);
    const r = run([bin, "--version"]);
    check(r.code === 0 && r.out.trim() === pkg.version, `expected version ${pkg.version}, got exit ${r.code}: ${r.out.trim()}`);
  });

  if (local) await step("start the bridge (local mode)", () => check(run([bin, "bridge", "--detach"]).code === 0, "bridge --detach failed"));

  await step(`GET /health on port ${port} answers protocol ${PROTOCOL_VERSION}`, async () => {
    await waitFor("/health", async () => (await readHealth(port))?.protocol.version === PROTOCOL_VERSION, 20_000);
    const h = (await readHealth(port))!;
    check(h.bridgeVersion === pkg.version, `bridge reports ${h.bridgeVersion}, expected ${pkg.version}`);
  });

  await step("bridge service is registered", () => {
    for (const f of service.files) check(existsSync(f.path), `${f.path} was not written`);
    if (platform === "linux") console.log(hasUserSystemd ? "user systemd: unit installed" : "no user systemd: fell back to autostart + bridge --detach");
    if (platform === "win32" && !local) check(reg([RUN_KEY, "/v", WINDOWS_TASK]) === 0, `no Run value "${WINDOWS_TASK}"`);
    // Without a service manager the bridge owns a pid file, and --status finds the process behind it.
    if (platform === "win32" || (platform === "linux" && !hasUserSystemd) || local) check(run([bin, "bridge", "--status"]).code === 0, "bridge --status failed");
  });

  let hostPath = "";
  await step("Chrome native host is registered", () => {
    const manifest = chromeManifest();
    check(existsSync(manifest), `${manifest} does not exist`);
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    check(m.name === HOST_NAME, `manifest name is ${m.name}`);
    check(m.path === bin, `manifest path is ${m.path}, expected ${bin}`);
    check(Array.isArray(m.allowed_origins) && m.allowed_origins.includes(EXTENSION_ORIGIN), `manifest does not allow ${EXTENSION_ORIGIN}`);
    if (platform === "win32" && !local) {
      const q = spawnExec(["reg", "query", browserRegistryKey("chrome"), "/ve"]);
      check(q.code === 0 && q.stdout.includes(manifest), `${browserRegistryKey("chrome")} does not point at ${manifest}`);
    }
    hostPath = m.path;
  });

  await step("native messaging round trip returns the token", async () => {
    const reply = (await nativeRoundTrip(hostPath)) as { ok?: boolean; token?: string; error?: string };
    const token = readFileSync(tokenPath(), "utf8").trim();
    check(reply?.ok === true, `native host refused: ${JSON.stringify(reply)}`);
    check(reply.token === token, "native host returned a token that differs from the token file");
  });

  await step("Claude Code and Codex hooks call the installed binary and run cleanly", () => {
    for (const { cli, settings } of HOOKED_CLIS) {
      const file = path.join(home, ...settings.split("/"));
      check(existsSync(file), `${file} was not written (create ~/.${cli} before installing)`);
      const expected = hookCommand({ kind: "binary", exe: bin }, cli, platform);
      check(path.isAbsolute(bin), `binary path ${bin} is not absolute`);
      const found = anynotateHooks().some((h) => h === `${file}: ${expected}`);
      check(found, `${file} has no hook "${expected}"`);
      runHookCommand(expected);
    }
  });

  await step("anynotate doctor passes", () => {
    hooks = anynotateHooks();
    check(run([bin, "doctor"]).code === 0, "doctor reported a failed check");
  });

  if (local) await step("stop the bridge (local mode)", () => check(run([bin, "bridge", "--stop"]).code === 0, "bridge --stop failed"));

  await step("anynotate uninstall removes what install wrote", async () => {
    check(run([bin, "uninstall"]).code === 0, "uninstall failed");
    for (const s of platform === "linux" ? [servicePlan(true), servicePlan(false)] : [service]) {
      for (const f of s.files) check(!existsSync(f.path), `${f.path} is still there`);
    }
    for (const m of manifestPaths()) check(!existsSync(m), `${m} is still there`);
    if (platform === "win32" && !local) {
      check(reg([RUN_KEY, "/v", WINDOWS_TASK]) === 1, `Run value "${WINDOWS_TASK}" is still there`);
      for (const b of BROWSERS) check(reg([browserRegistryKey(b)]) === 1, `${browserRegistryKey(b)} is still there`);
    }
    check(hooks.length === HOOKED_CLIS.length, `expected ${HOOKED_CLIS.length} hooks before uninstall, found ${hooks.length}`);
    console.log(`hooks before uninstall:\n  ${hooks.join("\n  ")}`);
    const left = anynotateHooks();
    check(left.length === 0, `hooks still present:\n  ${left.join("\n  ")}`);
    check(!existsSync(bin), `${bin} is still there`);
    await waitFor("the bridge to stop", async () => (await readHealth(port, 300)) === null, 10_000);
  });

  console.log("\nsmoke test passed");
}

try {
  await main();
} catch (err) {
  console.error(`\nsmoke test FAILED: ${err instanceof SmokeFailure ? err.message : (err as Error).stack}`);
  process.exit(1);
}
