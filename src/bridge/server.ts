import { randomUUID, timingSafeEqual } from "node:crypto";
import { Agent, BundleInput, type HealthResponse, PROTOCOL_MIN, PROTOCOL_VERSION, type Session } from "@anynotate/protocol";
import pkg from "../../package.json";
import { listSeen } from "../inbox/seen";
import { readBundle, readStatus, updateStatus, writeBundle } from "../inbox/store";
import { EXTENSION_HEADER, extensionRecorder, senderFromHeader } from "./extension-version";
import { listPanes as herdrListPanes, type Pane, promptPane, waitIdle } from "./herdr";
import { Registry } from "./registry";
import { route, type RouteDeps } from "./router";
import { createTitler, type TitleQuery } from "./titles";

const MAX_BODY = 50 * 1024 * 1024;
// POST /bundles answers after at most this long; herdr's idle wait can take minutes, so routing finishes in the background.
export const ROUTE_WAIT_MS = 2000;

type Opts = {
  token: string;
  port?: number;
  allowedOrigins?: string[];
  registry?: Registry;
  routeDeps?: Partial<RouteDeps>;
  listPanes?: () => Promise<Pane[]>;
  routeWaitMs?: number;
  sessionTitle?: (q: TitleQuery) => string;
  recordExtension?: (sender: string) => void;
};

function sameToken(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// DNS rebinding: a page on evil.example can resolve its own name to 127.0.0.1, but its requests still say Host: evil.example.
const hostAllowed = (host: string | null, port: number | undefined) =>
  port !== undefined && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);

const HEALTH: HealthResponse = { ok: true, bridgeVersion: pkg.version, protocol: { version: PROTOCOL_VERSION, min: PROTOCOL_MIN } };

export function createBridge(opts: Opts) {
  if (!opts.token) throw new Error("empty token");
  const registry = opts.registry ?? new Registry();
  const allowed = new Set(opts.allowedOrigins ?? []);
  const listPanes = opts.listPanes ?? (() => herdrListPanes());
  const routeWaitMs = opts.routeWaitMs ?? ROUTE_WAIT_MS;
  const sessionTitle = opts.sessionTitle ?? createTitler();
  const recordExtension = opts.recordExtension ?? extensionRecorder();
  const deps: RouteDeps = {
    registry,
    waitIdle: opts.routeDeps?.waitIdle ?? ((pane) => waitIdle(pane)),
    promptPane: opts.routeDeps?.promptPane ?? ((pane, id) => promptPane(pane, id)),
  };

  const cors = (origin: string | null): Record<string, string> =>
    origin && allowed.has(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": `X-Anynotate-Token, ${EXTENSION_HEADER}, Content-Type`,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          Vary: "Origin",
        }
      : {};

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 47291,
    maxRequestBodySize: MAX_BODY,
    idleTimeout: 0,
    async fetch(req, srv) {
      if (!hostAllowed(req.headers.get("host"), srv.port)) return Response.json({ error: "bad host" }, { status: 403 });
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const h = cors(origin);
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers: h });

      if (origin && !allowed.has(origin)) return Response.json({ error: "forbidden origin" }, { status: 403 });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (url.pathname === "/health") return json(HEALTH);
      // Any local process can forge an allowed Origin, so the Origin only earns CORS headers; the token is still required.
      if (!sameToken(req.headers.get("x-anynotate-token"), opts.token)) return json({ error: "bad token" }, 401);

      const parts = url.pathname.split("/").filter(Boolean);
      // An extension's request carries its Origin; one without the version header comes from a release before it.
      const extensionHeader = req.headers.get(EXTENSION_HEADER);
      const sender = extensionHeader !== null || origin ? senderFromHeader(extensionHeader) : undefined;
      if (sender) recordExtension(sender);
      try {
        if ((req.method === "GET" || req.method === "POST") && url.pathname === "/sessions") {
          const push = registry.live();
          const pushIds = new Set(push.map((s) => s.id));
          const seen = listSeen();
          // A pane belongs to its newest seen session of the same agent (listSeen is newest first).
          const herdr: Session[] = (await listPanes()).map((p) => {
            const owner = seen.find((s) => s.pane === p.pane && s.agent === p.agent);
            return {
              id: p.pane, agent: p.agent, cwd: p.cwd, title: p.title, method: "herdr", pane: p.pane,
              ...(owner ? { sessionIds: [owner.sessionId] } : {}),
              ...(p.workspace ? { workspace: p.workspace } : {}),
            };
          });
          // A session tied to a herdr pane is that pane's owner (already listed as the pane) or an exited/child run
          // that will never take another prompt, so only sessions outside herdr are offered for next-prompt delivery.
          const next: Session[] = seen
            .filter((s) => !s.pane && !pushIds.has(s.sessionId))
            .map((s) => ({ id: s.sessionId, agent: s.agent, cwd: s.cwd, title: sessionTitle(s), method: "next-prompt" }));
          return json([...push, ...herdr, ...next]);
        }

        if (req.method === "POST" && url.pathname === "/bundles") {
          const form = await req.formData();
          const parsed = BundleInput.safeParse(JSON.parse(String(form.get("bundle") ?? "null")));
          if (!parsed.success) return json({ error: parsed.error.message }, 400);
          const files: Record<string, Uint8Array> = {};
          for (const [name, value] of form.entries()) {
            if (name !== "bundle" && typeof value !== "string") files[name] = new Uint8Array(await (value as Blob).arrayBuffer());
          }
          const bundle = writeBundle(parsed.data, files, new Date(), sender);
          const routing = route(bundle, deps).catch((e) => {
            console.error(`anynotate: routing ${bundle.id} failed:`, e);
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([routing, new Promise((r) => { timer = setTimeout(r, routeWaitMs); })]);
          clearTimeout(timer);
          const status = readStatus(bundle.id) ?? { state: "queued", at: new Date().toISOString() };
          return json({ id: bundle.id, status }, 201);
        }

        if (req.method === "GET" && parts[0] === "bundles" && parts.length === 2) {
          const id = parts[1]!;
          try {
            return json({ bundle: readBundle(id), status: readStatus(id) });
          } catch {
            return json({ error: "not found" }, 404);
          }
        }

        if (req.method === "POST" && parts[0] === "bundles" && parts.length === 3 && parts[2] === "status") {
          const id = parts[1]!;
          try {
            return json({ bundle: readBundle(id), status: readStatus(id) });
          } catch {
            return json({ error: "not found" }, 404);
          }
        }

        if (req.method === "POST" && parts[0] === "bundles" && parts[2] === "ack") {
          const { summary } = (await req.json()) as { summary?: string };
          // A unique owner per call keeps concurrent acks from sharing claim/temp file names.
          const owner = `ack-${process.pid}-${randomUUID()}`;
          const ok = updateStatus(parts[1]!, owner, (s) => ({ ...s, state: "acked", summary: String(summary ?? "") }));
          return ok ? json({ ok: true }) : json({ error: "not found or busy" }, 404);
        }

        if (req.method === "POST" && url.pathname === "/register") {
          const b = (await req.json()) as { id: string; agent: string; cwd: string; title?: string };
          registry.register({ id: String(b.id), agent: Agent.parse(b.agent), cwd: String(b.cwd), title: String(b.title ?? "") });
          return json({ ok: true });
        }

        if (req.method === "POST" && url.pathname === "/heartbeat") {
          const { id } = (await req.json()) as { id: string };
          return registry.heartbeat(String(id)) ? json({ ok: true }) : json({ ok: false }, 404);
        }

        if (req.method === "GET" && parts[0] === "adapter" && parts[2] === "events") {
          const id = parts[1]!;
          let controller!: ReadableStreamDefaultController<string>;
          let ping: ReturnType<typeof setInterval> | undefined;
          const send = (bundleId: string) => controller.enqueue(`event: deliver\ndata: ${JSON.stringify({ bundleId })}\n\n`);
          // start() runs synchronously in the constructor, so the controller exists before attach.
          const stream = new ReadableStream<string>({
            start(c) {
              controller = c;
              c.enqueue(": connected\n\n");
            },
            cancel() {
              clearInterval(ping);
              registry.detach(id, send);
            },
          });
          if (!registry.attach(id, send)) return json({ error: "not registered" }, 404);
          ping = setInterval(() => controller.enqueue(": ping\n\n"), 15_000);
          return new Response(stream, { headers: { ...h, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        }

        return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    },
  });

  return { server, registry };
}
