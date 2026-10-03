import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBundle } from "../src/inbox/store";
import { createMcpServer } from "../src/mcp/server";
import { anynotatePrompts, anynotateTools, MCP_INSTRUCTIONS } from "../src/mcp/tools";
import schema from "./fixtures/mcp-2026-07-28-results.schema.json";
import { sampleInput } from "./fixtures/sample";

type Schema = Record<string, any>;
const defs = (schema as Schema).$defs as Record<string, Schema>;

// Enough of JSON Schema 2020-12 for the keywords the MCP result types use; format is not checked.
function validate(s: Schema, v: unknown, at = "$"): string[] {
  if (s.$ref) return validate(defs[(s.$ref as string).replace("#/$defs/", "")]!, v, at);
  const errors: string[] = [];
  if (s.anyOf && !(s.anyOf as Schema[]).some((sub) => validate(sub, v, at).length === 0)) errors.push(`${at}: matches no anyOf branch`);
  if ("const" in s && v !== s.const) errors.push(`${at}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !(s.enum as unknown[]).includes(v)) errors.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
  if (s.type) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    const ok = types.some((t) => t === actual || (t === "integer" && Number.isInteger(v)));
    if (!ok) return [...errors, `${at}: expected ${types.join("|")}, got ${actual}`];
  }
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${at}: below ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${at}: above ${s.maximum}`);
  }
  if (Array.isArray(v) && s.items) v.forEach((item, i) => errors.push(...validate(s.items, item, `${at}[${i}]`)));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    for (const key of (s.required as string[] | undefined) ?? []) if (!(key in obj)) errors.push(`${at}: missing ${key}`);
    for (const [key, value] of Object.entries(obj)) {
      if (s.properties && key in s.properties) errors.push(...validate(s.properties[key], value, `${at}.${key}`));
      else if (s.additionalProperties === false) errors.push(`${at}: unexpected ${key}`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") errors.push(...validate(s.additionalProperties, value, `${at}.${key}`));
    }
  }
  return errors;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anynotate-mcp-spec-"));
  process.env.ANYNOTATE_HOME = home;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeBundle(sampleInput, { "page.md": new TextEncoder().encode("⟦A1⟧ x"), "screenshot.png": png, "crops/A1.png": png });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.ANYNOTATE_HOME;
});

const server = () => createMcpServer({ name: "anynotate", version: "0.6.0", instructions: MCP_INSTRUCTIONS, tools: anynotateTools(), prompts: anynotatePrompts });
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };

async function result(method: string, params: Record<string, unknown> = {}, modern = true) {
  const out = await server().handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: modern ? { ...params, _meta: META } : params }));
  const reply = JSON.parse(out!);
  expect(reply.error).toBeUndefined();
  return reply.result;
}

const CASES: [string, Record<string, unknown>, string][] = [
  ["server/discover", {}, "DiscoverResult"],
  ["tools/list", {}, "ListToolsResult"],
  ["tools/call", { name: "list_notes", arguments: {} }, "CallToolResult"],
  ["tools/call", { name: "read_notes", arguments: { include_page_text: true } }, "CallToolResult"],
  ["tools/call", { name: "get_screenshot", arguments: { id: "latest" } }, "CallToolResult"],
  ["tools/call", { name: "read_notes", arguments: { id: "nope" } }, "CallToolResult"],
  ["prompts/list", {}, "ListPromptsResult"],
  ["prompts/get", { name: "review-browser-notes", arguments: {} }, "GetPromptResult"],
  ["ping", {}, "EmptyResult"],
];

test.each(CASES)("modern %s result matches the 2026-07-28 schema (%#)", async (method, params, type) => {
  const r = await result(method, params);
  expect(validate(defs[type]!, r)).toEqual([]);
  expect(r.resultType).toBe("complete");
});

test("the validator catches a missing cache hint", () => {
  expect(validate(defs.ListToolsResult!, { resultType: "complete", tools: [] })).toEqual(["$: missing cacheScope", "$: missing ttlMs"]);
});

const MODERN_ONLY = ["resultType", "ttlMs", "cacheScope", "_meta"];

test.each(["tools/list", "prompts/list", "ping"])("legacy %s carries no 2026-07-28 fields", async (method) => {
  const r = await result(method, {}, false);
  for (const key of MODERN_ONLY) expect(r).not.toHaveProperty(key);
});

test("legacy initialize, tools/call and prompts/get carry no 2026-07-28 fields", async () => {
  for (const [method, params] of [
    ["initialize", { protocolVersion: "2025-11-25" }],
    ["tools/call", { name: "list_notes", arguments: {} }],
    ["prompts/get", { name: "review-browser-notes" }],
  ] as const) {
    const r = await result(method, params, false);
    for (const key of MODERN_ONLY) expect(r).not.toHaveProperty(key);
  }
});
