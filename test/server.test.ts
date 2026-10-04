import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthResponse, Session } from "@anynotate/protocol";
import pkg from "../package.json";
import { createBridge } from "../src/bridge/server";
import { loadOrCreateToken } from "../src/bridge/token";
import { touchSeen } from "../src/inbox/seen";
import { readStatus } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";

let home: string;
let bridge: ReturnType<typeof createBridge>;
let base: string;
const H = { "X-Anynotate-Token": "tok" };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anynotate-"));
  process.env.ANYNOTATE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  process.env.CODEX_HOME = join(home, "codex");
  bridge = createBridge({
    token: "tok", port: 0, allowedOrigins: ["chrome-extension://abc"],
    listPanes: async () => [{ pane: "w1:p2", agent: "codex", cwd: "/r2", title: "shell", status: "idle" }],
    routeDeps: { waitIdle: async () => ({ ok: true }), promptPane: async () => ({ ok: true }) },
  });
  base = `http://127.0.0.1:${bridge.server.port}`;
});
afterEach(() => {
  bridge.server.stop(true);
  rmSync(home, { recursive: true, force: true });
  delete process.env.ANYNOTATE_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

function form(input: unknown) {
  const f = new FormData();
  f.set("bundle", JSON.stringify(input));
  f.set("page.md", new Blob(["# page ⟦A1⟧"]), "page.md");
  f.set("crops/A1.png", new Blob([new Uint8Array([1, 2])]), "A1.png");
  return f;
}

test("health is open, everything else needs the token", async () => {
  expect((await fetch(`${base}/health`)).status).toBe(200);
  expect((await fetch(`${base}/sessions`)).status).toBe(401);
  expect((await fetch(`${base}/sessions`, { headers: { "X-Anynotate-Token": "bad" } })).status).toBe(401);
});

test("foreign browser origins are refused even with the token", async () => {
  const r = await fetch(`${base}/sessions`, { headers: { ...H, Origin: "https://evil.example" } });
  expect(r.status).toBe(403);
  const ok = await fetch(`${base}/sessions`, { headers: { ...H, Origin: "chrome-extension://abc" } });
  expect(ok.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
});

test("preflight from the extension is answered", async () => {
  const r = await fetch(`${base}/bundles`, { method: "OPTIONS", headers: { Origin: "chrome-extension://abc" } });
  expect(r.status).toBe(204);
  expect(r.headers.get("access-control-allow-headers")).toContain("X-Anynotate-Token");
  expect(r.headers.get("access-control-allow-headers")).toContain("X-Anynotate-Extension");
});

const FROM_EXT = { ...H, Origin: "chrome-extension://abc" };
const sentReadme = async (headers: Record<string, string>) => {
  const r = await fetch(`${base}/bundles`, { method: "POST", headers, body: form(sampleInput) });
  expect(r.status).toBe(201);
  const { id } = await r.json();
  return readFileSync(join(home, "inbox", id, "README.md"), "utf8").split("\n");
};
const lastSeen = () => {
  try {
    return readFileSync(join(home, "extension-version"), "utf8");
  } catch {
    return null;
  }
};

test("a bundle from the expected extension or a newer one gets no note, and its version is recorded", async () => {
  expect((await sentReadme({ ...FROM_EXT, "X-Anynotate-Extension": "0.3.1" }))[1]).toStartWith("Sent ");
  expect(lastSeen()).toBe("0.3.1\n");
  expect((await sentReadme({ ...FROM_EXT, "X-Anynotate-Extension": "0.10.0" }))[1]).toStartWith("Sent ");
  expect(lastSeen()).toBe("0.10.0\n");
});

test("a bundle from an older extension, or one sending no version, gets the note under the title", async () => {
  expect((await sentReadme({ ...FROM_EXT, "X-Anynotate-Extension": "0.2.0" }))[1]).toBe(
    "Note: sent from extension 0.2.0; 0.3.1 or later is expected, so some details may be missing.",
  );
  expect(lastSeen()).toBe("0.2.0\n");
  expect((await sentReadme(FROM_EXT))[1]).toBe("Note: sent from an older extension; 0.3.1 or later is expected, so some details may be missing.");
  expect(lastSeen()).toBe("unknown\n");
});

test("a client that is not a browser and sends no version is neither noted nor recorded", async () => {
  expect((await sentReadme(H))[1]).toStartWith("Sent ");
  expect(lastSeen()).toBeNull();
});

test("the extension version is recorded from any authenticated request, never from an unauthenticated one", async () => {
  await fetch(`${base}/sessions`, { method: "POST", headers: { Origin: "chrome-extension://abc", "X-Anynotate-Extension": "0.3.1" } });
  await fetch(`${base}/health`, { method: "POST", headers: { Origin: "chrome-extension://abc", "X-Anynotate-Extension": "0.3.1" } });
  expect(lastSeen()).toBeNull();
  expect((await fetch(`${base}/sessions`, { method: "POST", headers: { ...FROM_EXT, "X-Anynotate-Extension": "0.3.1" } })).status).toBe(200);
  expect(lastSeen()).toBe("0.3.1\n");
});

test("POST /bundles writes the inbox and routes", async () => {
  const r = await fetch(`${base}/bundles`, { method: "POST", headers: H, body: form({ ...sampleInput, target: { agent: "codex", pane: "w1:p2" } }) });
  expect(r.status).toBe(201);
  const { id, status } = await r.json();
  expect(status).toMatchObject({ state: "delivered", via: "herdr" });
  expect(readStatus(id)!.via).toBe("herdr");
  const got = await (await fetch(`${base}/bundles/${id}`, { headers: H })).json();
  expect(got.bundle.title).toBe(sampleInput.title);
});

test("GET /bundles/:id is a 404 for unknown and invalid ids", async () => {
  expect((await fetch(`${base}/bundles/nope`, { headers: H })).status).toBe(404);
  expect((await fetch(`${base}/bundles/..%2F..`, { headers: H })).status).toBe(404);
  expect((await fetch(`${base}/bundles/2026-09-24T153200-missing`, { headers: H })).status).toBe(404);
});

test("invalid bundle is a 400 with a reason", async () => {
  const r = await fetch(`${base}/bundles`, { method: "POST", headers: H, body: form({ ...sampleInput, v: 2 }) });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toBeTruthy();
});

test("sessions merge push, herdr and next-prompt", async () => {
  await fetch(`${base}/register`, { method: "POST", headers: H, body: JSON.stringify({ id: "s-1", agent: "claude", cwd: "/r1", title: "t" }) });
  touchSeen("gemini", "g-1", "/r3");
  touchSeen("claude", "s-1", "/r1");
  const s = await (await fetch(`${base}/sessions`, { headers: H })).json();
  expect(s.map((x: any) => `${x.method}:${x.agent}:${x.id}`)).toEqual(["push:claude:s-1", "herdr:codex:w1:p2", "next-prompt:gemini:g-1"]);
});

test("sessions tied to a herdr pane are never listed as next-prompt; the live pane names its newest one", async () => {
  touchSeen("codex", "in-live-pane", "/r2", new Date(), "w1:p2");
  touchSeen("claude", "in-dead-pane", "/r4", new Date(), "w9:p9");
  touchSeen("gemini", "no-pane", "/r3");
  const s = await (await fetch(`${base}/sessions`, { headers: H })).json();
  expect(s.map((x: any) => `${x.method}:${x.id}`).sort()).toEqual(["herdr:w1:p2", "next-prompt:no-pane"]);
  expect(s.find((x: any) => x.id === "w1:p2").sessionIds).toEqual(["in-live-pane"]);
  expect(s.find((x: any) => x.id === "no-pane").pane).toBeUndefined();
});

test("child and older sessions from a pane stay hidden; only the newest same-agent one names the pane", async () => {
  touchSeen("codex", "older", "/r2", new Date(Date.now() - 60_000), "w1:p2");
  touchSeen("codex", "newer", "/r2", new Date(), "w1:p2");
  touchSeen("claude", "child-run", "/r2", new Date(Date.now() - 1000), "w1:p2");
  const s = await (await fetch(`${base}/sessions`, { headers: H })).json();
  expect(s.map((x: any) => `${x.method}:${x.id}`)).toEqual(["herdr:w1:p2"]);
  expect(s.find((x: any) => x.id === "w1:p2").sessionIds).toEqual(["newer"]);
});

test("next-prompt sessions carry the title from the agent's own transcript", async () => {
  const sid = "5e55a0aa-0000-4000-8000-000000000001";
  mkdirSync(join(home, "claude", "projects", "-home-me-shop"), { recursive: true });
  writeFileSync(join(home, "claude", "projects", "-home-me-shop", `${sid}.jsonl`), `${JSON.stringify({ type: "ai-title", aiTitle: "Fix the cart total" })}\n`);
  touchSeen("claude", sid, "/home/me/shop");
  touchSeen("gemini", "g-1", "/r3");
  const s = await (await fetch(`${base}/sessions`, { headers: H })).json();
  expect(s.find((x: any) => x.id === sid).title).toBe("Fix the cart total");
  expect(s.find((x: any) => x.id === "g-1").title).toBe("");
});

test("a herdr pane carries its workspace name; sessions without one omit the field", async () => {
  bridge.server.stop(true);
  bridge = createBridge({
    token: "tok", port: 0,
    listPanes: async () => [
      { pane: "w1:p2", agent: "codex", cwd: "/r2", title: "shell", status: "idle", workspace: "shop" },
      { pane: "w2:p1", agent: "claude", cwd: "/r1", title: "", status: "idle" },
    ],
  });
  base = `http://127.0.0.1:${bridge.server.port}`;
  touchSeen("gemini", "g-1", "/r3");
  const s = await (await fetch(`${base}/sessions`, { headers: H })).json();
  expect(s.find((x: any) => x.id === "w1:p2").workspace).toBe("shop");
  expect(s.find((x: any) => x.id === "w2:p1")).not.toHaveProperty("workspace");
  expect(s.find((x: any) => x.id === "g-1")).not.toHaveProperty("workspace");
  for (const x of s) expect(Session.safeParse(x).success).toBe(true);
});

test("SSE delivers pushes to a registered adapter, ack updates status", async () => {
  await fetch(`${base}/register`, { method: "POST", headers: H, body: JSON.stringify({ id: "s-1", agent: "claude", cwd: "/tmp/repo", title: "" }) });
  const events = await fetch(`${base}/adapter/s-1/events`, { headers: H });
  const reader = events.body!.getReader();
  await reader.read(); // initial ": connected" comment
  const post = await fetch(`${base}/bundles`, { method: "POST", headers: H, body: form(sampleInput) });
  const { id } = await post.json();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  expect(chunk).toContain("event: deliver");
  expect(chunk).toContain(id);
  await reader.cancel();
  const ack = await fetch(`${base}/bundles/${id}/ack`, { method: "POST", headers: H, body: JSON.stringify({ summary: "looking at the cream question" }) });
  expect(ack.status).toBe(200);
  expect(readStatus(id)).toMatchObject({ state: "acked", summary: "looking at the cream question" });
});

test("SSE for an unregistered id is a 404", async () => {
  const r = await fetch(`${base}/adapter/ghost/events`, { headers: H });
  expect(r.status).toBe(404);
  expect((await r.json()).error).toBe("not registered");
});

test("cancelling an old SSE stream does not detach its replacement", async () => {
  await fetch(`${base}/register`, { method: "POST", headers: H, body: JSON.stringify({ id: "s-1", agent: "claude", cwd: "/tmp/repo", title: "" }) });
  const abortA = new AbortController();
  const a = (await fetch(`${base}/adapter/s-1/events`, { headers: H, signal: abortA.signal })).body!.getReader();
  await a.read();
  const b = (await fetch(`${base}/adapter/s-1/events`, { headers: H })).body!.getReader();
  await b.read();
  // Bun's client keeps the socket open on reader.cancel(); only an abort makes the server run A's cancel().
  abortA.abort();
  await Bun.sleep(100);
  const post = await fetch(`${base}/bundles`, { method: "POST", headers: H, body: form(sampleInput) });
  const { id, status } = await post.json();
  expect(status).toMatchObject({ state: "delivered", via: "push" });
  const chunk = new TextDecoder().decode((await b.read()).value);
  expect(chunk).toContain(id);
  await b.cancel();
});

test("POST /bundles answers after routeWaitMs while slow routing finishes in the background", async () => {
  const slow = createBridge({
    token: "tok", port: 0, routeWaitMs: 50,
    listPanes: async () => [],
    routeDeps: { waitIdle: async () => { await Bun.sleep(300); return { ok: true }; }, promptPane: async () => ({ ok: true }) },
  });
  try {
    const url = `http://127.0.0.1:${slow.server.port}`;
    const t0 = performance.now();
    const r = await fetch(`${url}/bundles`, { method: "POST", headers: H, body: form({ ...sampleInput, target: { agent: "codex", pane: "w1:p2" } }) });
    expect(performance.now() - t0).toBeLessThan(250);
    expect(r.status).toBe(201);
    const { id, status } = await r.json();
    expect(status.state).toBe("queued");
    let got: any;
    for (let i = 0; i < 40; i++) {
      got = await (await fetch(`${url}/bundles/${id}`, { headers: H })).json();
      if (got.status?.state === "delivered") break;
      await Bun.sleep(50);
    }
    expect(got.status).toMatchObject({ state: "delivered", via: "herdr" });
  } finally {
    slow.server.stop(true);
  }
});

test("loadOrCreateToken creates a 0600 token once and reuses it", () => {
  const t = loadOrCreateToken();
  expect(t).toMatch(/^[0-9a-f]{64}$/);
  if (process.platform !== "win32") expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);
  expect(loadOrCreateToken()).toBe(t);
});

test("loadOrCreateToken replaces an empty or malformed token file", () => {
  for (const bad of ["", "\n", "short", "Z".repeat(64)]) {
    writeFileSync(join(home, "token"), bad);
    const t = loadOrCreateToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(home, "token"), "utf8").trim()).toBe(t);
    if (process.platform !== "win32") expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);
  }
});

test("createBridge refuses an empty token", () => {
  expect(() => createBridge({ token: "", port: 0 })).toThrow("empty token");
});

test("/sessions lists a herdr pane of any agent kind, and a bundle aimed at it is accepted", async () => {
  bridge.server.stop(true);
  bridge = createBridge({
    token: "tok", port: 0,
    listPanes: async () => [{ pane: "w2:p1", agent: "agy", cwd: "/g", title: "anti", status: "idle" }],
    routeDeps: { waitIdle: async () => ({ ok: true }), promptPane: async () => ({ ok: true }) },
  });
  base = `http://127.0.0.1:${bridge.server.port}`;
  const s = await (await fetch(`${base}/sessions`, { headers: H })).json();
  expect(s).toContainEqual({ id: "w2:p1", agent: "agy", cwd: "/g", title: "anti", method: "herdr", pane: "w2:p1" });
  const r = await fetch(`${base}/bundles`, { method: "POST", headers: H, body: form({ ...sampleInput, target: { agent: "agy", pane: "w2:p1", cwd: "/g" } }) });
  expect(r.status).toBe(201);
  expect((await r.json()).status).toMatchObject({ state: "delivered", via: "herdr" });
});

const EXT = { Origin: "chrome-extension://abc" };

function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("health answers the protocol handshake", async () => {
  for (const init of [{ method: "POST", headers: EXT }, {}] as RequestInit[]) {
    const body = await (await fetch(`${base}/health`, init)).json();
    expect(HealthResponse.parse(body)).toEqual({ ok: true, bridgeVersion: pkg.version, protocol: { version: 2, min: 1 } });
  }
});

test("the allowed extension origin still needs the token, and POST variants serve it", async () => {
  expect((await fetch(`${base}/sessions`, { method: "POST", headers: EXT })).status).toBe(401);
  const s = await fetch(`${base}/sessions`, { method: "POST", headers: { ...EXT, ...H } });
  expect(s.status).toBe(200);
  expect(Array.isArray(await s.json())).toBe(true);
  const sent = await fetch(`${base}/bundles`, { method: "POST", headers: { ...EXT, ...H }, body: form(sampleInput) });
  expect(sent.status).toBe(201);
  const { id } = await sent.json();
  const st = await fetch(`${base}/bundles/${id}/status`, { method: "POST", headers: { ...EXT, ...H } });
  expect(st.status).toBe(200);
  expect((await st.json()).bundle.id).toBe(id);
});

test("a forged extension Origin without the token cannot type into a pane", async () => {
  bridge.server.stop(true);
  const prompted: string[] = [];
  bridge = createBridge({
    token: "tok", port: 0, allowedOrigins: ["chrome-extension://abc"],
    listPanes: async () => [{ pane: "w1:p2", agent: "codex", cwd: "/r2", title: "shell", status: "idle" }],
    routeDeps: { waitIdle: async () => ({ ok: true }), promptPane: async (pane) => { prompted.push(pane); return { ok: true }; } },
  });
  base = `http://127.0.0.1:${bridge.server.port}`;
  const r = await fetch(`${base}/bundles`, {
    method: "POST", headers: EXT, body: form({ ...sampleInput, target: { agent: "codex", pane: "w1:p2", cwd: "/r2" } }),
  });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: "bad token" });
  await Bun.sleep(50);
  expect(prompted).toEqual([]);
});

test("without an allowed origin every endpoint but /health needs the right token", async () => {
  for (const [method, path] of [["GET", "/sessions"], ["POST", "/sessions"], ["POST", "/bundles"], ["POST", "/bundles/x/status"], ["GET", "/bundles/x"]] as const) {
    const r = await fetch(`${base}${path}`, { method });
    expect({ method, path, status: r.status }).toEqual({ method, path, status: 401 });
  }
  for (const token of ["to", "tok2", "TOK"]) {
    expect((await fetch(`${base}/sessions`, { headers: { "X-Anynotate-Token": token } })).status).toBe(401);
  }
  expect((await fetch(`${base}/sessions`, { headers: H })).status).toBe(200);
});

test("the allowed extension origin without the token gets a 401 from every route but /health", async () => {
  const id = "2026-09-24T153200-tomato-soup";
  const routes = [
    ["POST", "/register"], ["POST", "/heartbeat"], ["POST", `/bundles/${id}/ack`],
    ["POST", `/bundles/${id}/status`], ["GET", "/adapter/x/events"], ["GET", "/sessions"],
  ] as const;
  for (const [method, path] of routes) {
    const r = await fetch(`${base}${path}`, { method, headers: EXT });
    expect({ method, path, status: r.status }).toEqual({ method, path, status: 401 });
  }
});

test("foreign origins get a JSON 403, preflight included", async () => {
  for (const method of ["GET", "POST", "OPTIONS"]) {
    const r = await fetch(`${base}/health`, { method, headers: { Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "forbidden origin" });
  }
});

test("requests addressed to any host but 127.0.0.1 or localhost are refused", async () => {
  const port = bridge.server.port!;
  expect(await rawGet(port, "/health", { Host: "evil.example" })).toEqual({ status: 403, body: JSON.stringify({ error: "bad host" }) });
  expect((await rawGet(port, "/sessions", { Host: `evil.example:${port}`, ...H })).status).toBe(403);
  expect((await rawGet(port, "/health", { Host: `localhost:${port}` })).status).toBe(200);
  expect((await rawGet(port, "/health", { Host: `127.0.0.1:${port}` })).status).toBe(200);
});
