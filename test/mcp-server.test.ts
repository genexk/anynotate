import { expect, test } from "bun:test";
import { createMcpServer, LATEST_PROTOCOL, MODERN_PROTOCOL_VERSIONS, PROTOCOL_VERSIONS, serveStdio, type Tool } from "../src/mcp/server";

const echo: Tool = {
  name: "echo",
  description: "Echoes its input.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  call: (args) => ({ content: [{ type: "text", text: String(args.text ?? "") }] }),
};
const boom: Tool = {
  name: "boom",
  description: "Always throws.",
  inputSchema: { type: "object" },
  call: () => {
    throw new Error("kaboom");
  },
};

const server = (logs: string[] = []) =>
  createMcpServer({
    name: "anynotate",
    version: "9.9.9",
    instructions: "Read browser notes.",
    tools: [echo, boom],
    prompts: [
      {
        name: "review-browser-notes",
        description: "Review my latest browser notes.",
        arguments: [{ name: "id", description: "bundle id", required: false }],
        get: (args) => ({ messages: [{ role: "user", content: { type: "text", text: `read ${args.id ?? "latest"}` } }] }),
      },
    ],
    log: (line) => logs.push(line),
  });

const call = async (s: ReturnType<typeof server>, msg: unknown) => {
  const out = await s.handleLine(typeof msg === "string" ? msg : JSON.stringify(msg));
  return out === null ? null : JSON.parse(out);
};

test("initialize echoes a supported requested version and describes the server", async () => {
  const r = await call(server(), { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
  expect(r).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
      serverInfo: { name: "anynotate", version: "9.9.9" },
      instructions: "Read browser notes.",
    },
  });
});

test("initialize answers with the latest supported version when the requested one is unknown", async () => {
  const r = await call(server(), { jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "1999-01-01" } });
  expect(r.result.protocolVersion).toBe(LATEST_PROTOCOL);
  expect(PROTOCOL_VERSIONS).toContain("2024-11-05");
  expect(PROTOCOL_VERSIONS[0]).toBe(LATEST_PROTOCOL);
});

test("ping returns an empty result", async () => {
  expect(await call(server(), { jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
});

test("notifications get no response, known or not", async () => {
  const s = server();
  expect(await call(s, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  expect(await call(s, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).toBeNull();
  expect(await call(s, { jsonrpc: "2.0", method: "no/such/notification" })).toBeNull();
});

test("an unknown method is -32601", async () => {
  expect((await call(server(), { jsonrpc: "2.0", id: 2, method: "resources/list" })).error.code).toBe(-32601);
});

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" } };

test("server/discover describes the server in the 2026-07-28 shape", async () => {
  const r = await call(server(), { jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: META } });
  expect(r).toEqual({
    jsonrpc: "2.0",
    id: "d",
    result: {
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {}, prompts: {} },
      instructions: "Read browser notes.",
      ttlMs: 300_000,
      cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "anynotate", version: "9.9.9" } },
    },
  });
  expect(MODERN_PROTOCOL_VERSIONS).toEqual(["2026-07-28"]);
});

test("a request carrying the modern protocol version gets resultType and serverInfo on its result", async () => {
  const s = server();
  const list = await call(s, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } });
  expect(list.result.resultType).toBe("complete");
  expect(list.result._meta).toEqual({ "io.modelcontextprotocol/serverInfo": { name: "anynotate", version: "9.9.9" } });
  expect(list.result.tools).toHaveLength(2);
  const called = await call(s, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "x" }, _meta: META } });
  expect(called.result).toMatchObject({ resultType: "complete", content: [{ type: "text", text: "x" }] });
  const legacy = await call(s, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  expect(legacy.result.resultType).toBeUndefined();
});

test("an unsupported modern protocol version is -32022 with the supported list", async () => {
  const r = await call(server(), { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } });
  expect(r).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28"], requested: "2099-01-01" } } });
});

test("a modern request without client capabilities is -32602", async () => {
  const { "io.modelcontextprotocol/clientCapabilities": _, ...meta } = META;
  expect((await call(server(), { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } })).error.code).toBe(-32602);
});

test("initialize never negotiates the stateless revision", async () => {
  const r = await call(server(), { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } });
  expect(r.result.protocolVersion).toBe(LATEST_PROTOCOL);
});

test("a request with a null id is -32600", async () => {
  expect(await call(server(), { jsonrpc: "2.0", id: null, method: "ping" })).toMatchObject({ id: null, error: { code: -32600 } });
});

test("bad JSON is -32700 with a null id", async () => {
  expect(await call(server(), "{not json")).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
});

test("a message that is not a JSON-RPC request is -32600", async () => {
  const s = server();
  expect(await call(s, { id: 1, method: "ping" })).toMatchObject({ id: 1, error: { code: -32600 } });
  expect(await call(s, { jsonrpc: "2.0", id: 1, method: 5 })).toMatchObject({ id: 1, error: { code: -32600 } });
  expect(await call(s, "42")).toMatchObject({ id: null, error: { code: -32600 } });
});

test("a response sent by the client is ignored", async () => {
  expect(await call(server(), { jsonrpc: "2.0", id: 9, result: {} })).toBeNull();
});

test("tools/list lists name, description and input schema without the handler", async () => {
  const r = await call(server(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "boom"]);
  expect(r.result.tools[0]).toEqual({ name: "echo", description: "Echoes its input.", inputSchema: echo.inputSchema });
});

test("tools/call dispatches to the named tool", async () => {
  const r = await call(server(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });
  expect(r.result).toEqual({ content: [{ type: "text", text: "hi" }] });
});

test("tools/call with no arguments passes an empty object", async () => {
  const r = await call(server(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });
  expect(r.result.content[0].text).toBe("");
});

test("tools/call of an unknown tool or without a name is -32602", async () => {
  const s = server();
  expect((await call(s, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } })).error.code).toBe(-32602);
  expect((await call(s, { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} })).error.code).toBe(-32602);
  expect((await call(s, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: [1] } })).error.code).toBe(-32602);
});

test("a tool that throws becomes an isError result and is logged", async () => {
  const logs: string[] = [];
  const r = await call(server(logs), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom", arguments: {} } });
  expect(r.result).toEqual({ content: [{ type: "text", text: "boom failed: kaboom" }], isError: true });
  expect(logs.join("\n")).toContain("kaboom");
});

test("prompts/list and prompts/get", async () => {
  const s = server();
  const list = await call(s, { jsonrpc: "2.0", id: 1, method: "prompts/list" });
  expect(list.result.prompts).toEqual([
    { name: "review-browser-notes", description: "Review my latest browser notes.", arguments: [{ name: "id", description: "bundle id", required: false }] },
  ]);
  const got = await call(s, { jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "review-browser-notes", arguments: { id: "x" } } });
  expect(got.result).toEqual({ messages: [{ role: "user", content: { type: "text", text: "read x" } }] });
  expect((await call(s, { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "nope" } })).error.code).toBe(-32602);
});

test("a JSON-RPC batch gets an array of the non-notification responses", async () => {
  const out = await server().handleLine(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]));
  expect(JSON.parse(out!)).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  expect(await server().handleLine(JSON.stringify([{ jsonrpc: "2.0", method: "notifications/initialized" }]))).toBeNull();
});

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });

test("serveStdio reads newline-delimited messages split across chunks and writes one line per response", async () => {
  const lines: string[] = [];
  await serveStdio(
    server(),
    streamOf('{"jsonrpc":"2.0","id":1,"me', 'thod":"ping"}\r\n\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}'),
    (line) => lines.push(line),
  );
  expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}\n', '{"jsonrpc":"2.0","id":2,"result":{}}\n']);
});

test("serveStdio output never holds an embedded newline", async () => {
  const lines: string[] = [];
  const s = createMcpServer({ name: "n", version: "1", tools: [{ ...echo, call: () => ({ content: [{ type: "text", text: "a\nb" }] }) }], prompts: [] });
  await serveStdio(s, streamOf('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo"}}\n'), (l) => lines.push(l));
  expect(lines).toHaveLength(1);
  expect(lines[0]!.slice(0, -1)).not.toContain("\n");
  expect(JSON.parse(lines[0]!).result.content[0].text).toBe("a\nb");
});

test("serveStdio answers an over-long line with -32600 and keeps serving", async () => {
  const lines: string[] = [];
  const long = `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${"x".repeat(300)}"}`;
  await serveStdio(server(), streamOf(long.slice(0, 150), `${long.slice(150)}\n`, '{"jsonrpc":"2.0","id":2,"method":"ping"}\n'), (l) => lines.push(l), { maxLine: 100 });
  expect(lines.map((l) => JSON.parse(l))).toEqual([
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Message too large" } },
    { jsonrpc: "2.0", id: 2, result: {} },
  ]);
});

test("serveStdio measures the line limit in bytes, not characters", async () => {
  const lines: string[] = [];
  const wide = `{"jsonrpc":"2.0","id":1,"method":"ping","pad":"${"é".repeat(40)}"}`;
  expect(wide.length).toBeLessThan(100);
  await serveStdio(server(), streamOf(`${wide}\n`, '{"jsonrpc":"2.0","id":2,"method":"ping"}\n'), (l) => lines.push(l), { maxLine: 100 });
  expect(lines.map((l) => JSON.parse(l).id)).toEqual([null, 2]);
});
