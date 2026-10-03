// A Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0, one message per line.
// It speaks the initialize-handshake revisions (2024-11-05 through 2025-11-25) and the stateless 2026-07-28 revision,
// which carries its protocol version in each request's _meta. A request decides which one it gets.

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const MAX_LINE_BYTES = 1024 * 1024;

// In 2026-07-28 these results are cacheable and must carry a cache hint. They are fixed per binary and hold no user
// data, so any cache may keep them; a binary update restarts the server, and five minutes bounds a stale copy.
const CACHEABLE = new Set(["server/discover", "tools/list", "prompts/list"]);
export const CACHE_HINT = { ttlMs: 300_000, cacheScope: "public" } as const;

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: Content[]; isError?: boolean };

export type Tool = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  call: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
};

export type PromptMessage = { role: "user" | "assistant"; content: { type: "text"; text: string } };
export type Prompt = {
  name: string;
  title?: string;
  description: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
  get: (args: Record<string, string>) => { description?: string; messages: PromptMessage[] };
};

export type McpServerOptions = {
  name: string;
  version: string;
  instructions?: string;
  tools: Tool[];
  prompts: Prompt[];
  log?: (line: string) => void;
};

type Id = string | number | null;
type Response = { jsonrpc: "2.0"; id: Id; result: unknown } | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string; data?: unknown } };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";
const error = (id: Id, code: number, message: string, data?: unknown): Response => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

const pick = <T extends object>(obj: T, keys: (keyof T)[]) =>
  Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

export function createMcpServer(o: McpServerOptions) {
  const log = o.log ?? ((line: string) => console.error(line));
  const tools = new Map(o.tools.map((t) => [t.name, t]));
  const prompts = new Map(o.prompts.map((p) => [p.name, p]));

  const serverInfo = { name: o.name, version: o.version };
  const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
    "server/discover": () => ({
      supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
      capabilities: { tools: {}, prompts: {} },
      ...(o.instructions ? { instructions: o.instructions } : {}),
    }),
    initialize: (params) => {
      const requested = params.protocolVersion;
      const protocolVersion = (PROTOCOL_VERSIONS as readonly unknown[]).includes(requested) ? requested : LATEST_PROTOCOL;
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo,
        ...(o.instructions ? { instructions: o.instructions } : {}),
      };
    },
    ping: () => ({}),
    "tools/list": () => ({ tools: o.tools.map((t) => pick(t, ["name", "title", "description", "inputSchema", "annotations"])) }),
    "tools/call": async (params) => {
      const tool = typeof params.name === "string" ? tools.get(params.name) : undefined;
      if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
      const args = params.arguments ?? {};
      if (!isObject(args)) throw new RpcError(INVALID_PARAMS, "arguments must be an object");
      try {
        return await tool.call(args);
      } catch (err) {
        log(`anynotate mcp: ${tool.name} failed: ${(err as Error).stack ?? err}`);
        return { content: [{ type: "text", text: `${tool.name} failed: ${(err as Error).message}` }], isError: true };
      }
    },
    "prompts/list": () => ({ prompts: o.prompts.map((p) => pick(p, ["name", "title", "description", "arguments"])) }),
    "prompts/get": (params) => {
      const prompt = typeof params.name === "string" ? prompts.get(params.name) : undefined;
      if (!prompt) throw new RpcError(INVALID_PARAMS, `Unknown prompt: ${String(params.name)}`);
      const args = isObject(params.arguments) ? params.arguments : {};
      return prompt.get(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])));
    },
  };

  async function handleMessage(msg: unknown): Promise<Response | null> {
    if (!isObject(msg)) return error(null, INVALID_REQUEST, "Invalid Request");
    const id: Id = isId(msg.id) ? msg.id : null;
    const hasId = "id" in msg;
    if (msg.jsonrpc !== "2.0" || (hasId && !isId(msg.id))) return error(id, INVALID_REQUEST, "Invalid Request");
    if (!("method" in msg)) return null;
    if (typeof msg.method !== "string") return error(id, INVALID_REQUEST, "Invalid Request");
    if (!hasId) return null;
    const handler = Object.hasOwn(methods, msg.method) ? methods[msg.method] : undefined;
    if (!handler) return error(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
    const params = msg.params ?? {};
    if (!isObject(params)) return error(id, INVALID_PARAMS, "params must be an object");
    const meta = isObject(params._meta) ? params._meta : {};
    const modern = META_VERSION in meta;
    if (modern) {
      const requested = meta[META_VERSION];
      if (!(MODERN_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)) {
        return error(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: [...MODERN_PROTOCOL_VERSIONS], requested });
      }
      if (!isObject(meta[META_CAPABILITIES])) return error(id, INVALID_PARAMS, `_meta is missing ${META_CAPABILITIES}`);
    }
    try {
      const result = await handler(params);
      if (!modern && msg.method !== "server/discover") return { jsonrpc: "2.0", id, result };
      const cache = CACHEABLE.has(msg.method) ? CACHE_HINT : {};
      return { jsonrpc: "2.0", id, result: { resultType: "complete", ...(result as object), ...cache, _meta: { [META_SERVER_INFO]: serverInfo } } };
    } catch (err) {
      if (err instanceof RpcError) return error(id, err.code, err.message);
      log(`anynotate mcp: ${msg.method} failed: ${(err as Error).stack ?? err}`);
      return error(id, INTERNAL_ERROR, "Internal error");
    }
  }

  // One input line in, at most one output line (without its newline) out.
  async function handleLine(line: string): Promise<string | null> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return JSON.stringify(error(null, PARSE_ERROR, "Parse error"));
    }
    if (Array.isArray(msg)) {
      if (msg.length === 0) return JSON.stringify(error(null, INVALID_REQUEST, "Invalid Request"));
      const out: Response[] = [];
      for (const m of msg) {
        const r = await handleMessage(m);
        if (r) out.push(r);
      }
      return out.length ? JSON.stringify(out) : null;
    }
    const r = await handleMessage(msg);
    return r ? JSON.stringify(r) : null;
  }

  return { handleLine };
}

export type McpServer = ReturnType<typeof createMcpServer>;

// Handles messages in order until the input ends; each response is written as one line.
// A line longer than maxLine bytes is answered with -32600 and skipped up to its newline, so input can't grow memory
// without bound. Lines are split on the newline byte and decoded whole, so a multi-byte character never straddles them.
export async function serveStdio(
  server: McpServer,
  input: ReadableStream<Uint8Array>,
  write: (line: string) => void,
  o: { maxLine?: number } = {},
): Promise<void> {
  const maxLine = o.maxLine ?? MAX_LINE_BYTES;
  const decoder = new TextDecoder();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let skipping = false;
  const tooLarge = () => write(`${JSON.stringify(error(null, INVALID_REQUEST, "Message too large"))}\n`);
  const take = () => {
    const bytes = Buffer.concat(pending);
    pending = [];
    pendingBytes = 0;
    return bytes;
  };
  const handle = async (bytes: Uint8Array) => {
    const line = decoder.decode(bytes).replace(/\r$/, "");
    if (!line.trim()) return;
    const out = await server.handleLine(line);
    if (out !== null) write(`${out}\n`);
  };
  for await (const chunk of input) {
    let from = 0;
    for (let nl = chunk.indexOf(0x0a); nl >= 0; nl = chunk.indexOf(0x0a, from)) {
      const part = chunk.subarray(from, nl);
      from = nl + 1;
      if (skipping) {
        skipping = false;
        take();
        continue;
      }
      if (pendingBytes + part.length > maxLine) {
        take();
        tooLarge();
        continue;
      }
      pending.push(part);
      await handle(take());
    }
    const rest = chunk.slice(from);
    if (skipping) continue;
    pending.push(rest);
    pendingBytes += rest.length;
    if (pendingBytes > maxLine) {
      take();
      tooLarge();
      skipping = true;
    }
  }
  if (!skipping && pendingBytes) await handle(take());
}
