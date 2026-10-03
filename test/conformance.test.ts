import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BundleInput } from "@anynotate/protocol";
import { conformance, EXAMPLE_BUNDLE_ID, exampleBundleInput, type Exchange, FIXTURE_EXTENSION_ORIGIN, responseSchemas } from "@anynotate/protocol/fixtures";
import { createBridge } from "../src/bridge/server";

let home: string;
let bridge: ReturnType<typeof createBridge>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "anynotate-conf-"));
  process.env.ANYNOTATE_HOME = home;
  bridge = createBridge({
    token: "tok", port: 0, allowedOrigins: [FIXTURE_EXTENSION_ORIGIN],
    listPanes: async () => [],
    routeDeps: { waitIdle: async () => ({ ok: true }), promptPane: async () => ({ ok: true }) },
  });
});
afterEach(() => { bridge.server.stop(true); rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

function headersFor(x: Exchange): Record<string, string> {
  switch (x.request.auth) {
    case "extension": return { Origin: FIXTURE_EXTENSION_ORIGIN, "X-Anynotate-Token": "tok" };
    case "extension-no-token": return { Origin: FIXTURE_EXTENSION_ORIGIN };
    case "token": return { "X-Anynotate-Token": "tok" };
    case "foreign-origin": return { Origin: "https://evil.example" };
    case "none": return {};
  }
}

function withHost(port: number, path: string, host: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
    });
    r.on("error", reject);
    r.end();
  });
}

async function run(x: Exchange, id: string): Promise<{ status: number; body: unknown }> {
  const port = bridge.server.port!;
  const path = x.request.path.replace(":id", id);
  if (x.request.host) return withHost(port, path, x.request.host);
  const init: RequestInit = { method: x.request.method, headers: headersFor(x) };
  if (x.request.bundle) {
    const f = new FormData();
    f.set("bundle", JSON.stringify(x.request.bundle.input));
    for (const [name, text] of Object.entries(x.request.bundle.files)) f.set(name, new Blob([text]), name);
    init.body = f;
  } else if (x.request.json !== undefined) {
    init.body = JSON.stringify(x.request.json);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: res.status, body: await res.json() };
}

test("the bridge answers every conformance exchange as @anynotate/protocol describes", async () => {
  let id = EXAMPLE_BUNDLE_ID;
  for (const x of conformance) {
    const res = await run(x, id);
    expect({ name: x.name, status: res.status }).toEqual({ name: x.name, status: x.status });
    const parsed = responseSchemas[x.response.schema].safeParse(res.body);
    expect({ name: x.name, ok: parsed.success }).toEqual({ name: x.name, ok: true });
    if (x.name === "send-bundle") id = (res.body as { id: string }).id;
    if (x.name === "bundle-status-extension") {
      expect((res.body as { bundle: BundleInput }).bundle.annotations.map((a) => a.region)).toEqual(exampleBundleInput.annotations.map((a) => a.region));
    }
  }
});
