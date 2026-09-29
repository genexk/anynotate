import { randomUUID } from "node:crypto";
import { listSeen } from "../inbox/seen";
import { readBundle, readStatus, updateStatus, writeBundle } from "../inbox/store";
import { Agent, BundleInput, type Session } from "@anynotate/protocol";
import { listPanes as herdrListPanes, type Pane, promptPane, waitIdle } from "./herdr";
import { Registry } from "./registry";
import { route, type RouteDeps } from "./router";

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
};

export function createBridge(opts: Opts) {
  if (!opts.token) throw new Error("empty token");
  const registry = opts.registry ?? new Registry();
  const allowed = new Set(opts.allowedOrigins ?? []);
  const listPanes = opts.listPanes ?? (() => herdrListPanes());
  const routeWaitMs = opts.routeWaitMs ?? ROUTE_WAIT_MS;
  const deps: RouteDeps = {
    registry,
    waitIdle: opts.routeDeps?.waitIdle ?? ((pane) => waitIdle(pane)),
    promptPane: opts.routeDeps?.promptPane ?? ((pane, id) => promptPane(pane, id)),
  };

  const cors = (origin: string | null): Record<string, string> =>
    origin && allowed.has(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": "X-Anynotate-Token, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          Vary: "Origin",
        }
      : {};

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 47291,
    maxRequestBodySize: MAX_BODY,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const h = cors(origin);
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers: h });

      if (origin && !allowed.has(origin)) return new Response("forbidden origin", { status: 403 });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
      if (url.pathname === "/health") return json({ ok: true });
      if (req.headers.get("x-anynotate-token") !== opts.token) return json({ error: "bad token" }, 401);

      const parts = url.pathname.split("/").filter(Boolean);
      try {
        if (req.method === "GET" && url.pathname === "/sessions") {
          const push = registry.live();
          const pushIds = new Set(push.map((s) => s.id));
          const seen = listSeen();
          // A pane belongs to its newest seen session of the same agent (listSeen is newest first); older sessions
          // that once ran there have exited, so they stay next-prompt entries instead of being delivered to the pane.
          const inPane = new Set<string>();
          const herdr: Session[] = (await listPanes()).map((p) => {
            const owner = seen.find((s) => s.pane === p.pane && s.agent === p.agent);
            if (owner) inPane.add(`${owner.agent}:${owner.sessionId}`);
            return {
              id: p.pane, agent: p.agent, cwd: p.cwd, title: p.title, method: "herdr", pane: p.pane,
              ...(owner ? { sessionIds: [owner.sessionId] } : {}),
            };
          });
          const next: Session[] = seen
            .filter((s) => !pushIds.has(s.sessionId) && !inPane.has(`${s.agent}:${s.sessionId}`))
            .map((s) => ({ id: s.sessionId, agent: s.agent, cwd: s.cwd, title: "", method: "next-prompt", ...(s.pane ? { pane: s.pane } : {}) }));
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
          const bundle = writeBundle(parsed.data, files);
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
