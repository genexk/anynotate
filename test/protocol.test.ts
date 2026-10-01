import { expect, test } from "bun:test";
import {
  AckRequest, BundleInput, BundleStatusResponse, compatibility, ErrorResponse, HealthResponse, INTENTS, LEGACY_INTENTS, OkResponse,
  PROTOCOL_MIN, PROTOCOL_VERSION, SendResponse, SessionsResponse,
} from "@anynotate/protocol";
import { conformance, EXAMPLE_BUNDLE_ID, exampleBundleInput, responseSchemas } from "@anynotate/protocol/fixtures";

test("protocol v2 constants", () => {
  expect(PROTOCOL_VERSION).toBe(2);
  expect(PROTOCOL_MIN).toBe(1);
  expect(INTENTS).toEqual(["explain", "change", "approve"]);
  expect(LEGACY_INTENTS).toEqual(["question", "bug", "note"]);
});

test("every current and legacy intent parses", () => {
  for (const intent of [...INTENTS, ...LEGACY_INTENTS]) {
    const annotations = [{ ...exampleBundleInput.annotations[0]!, intent }];
    expect(BundleInput.safeParse({ ...exampleBundleInput, annotations }).success).toBe(true);
  }
});

test("a v2-only client refuses a v1 bridge, and a v1 client keeps working with a v2 bridge", () => {
  expect(compatibility({ min: 2, max: 2 }, { version: 1, min: 1 })).toBe("bridge-too-old");
  expect(compatibility({ min: 1, max: 1 }, { version: 2, min: 1 })).toBe("ok");
});

test("compatibility needs overlapping ranges and says which side is behind", () => {
  expect(compatibility({ min: 1, max: 1 }, { version: 1, min: 1 })).toBe("ok");
  expect(compatibility({ min: 1, max: 2 }, { version: 3, min: 2 })).toBe("ok");
  expect(compatibility({ min: 2, max: 2 }, { version: 1, min: 1 })).toBe("bridge-too-old");
  expect(compatibility({ min: 1, max: 1 }, { version: 3, min: 2 })).toBe("extension-too-old");
});

test("HealthResponse is the handshake shape and rejects the pre-v1 body", () => {
  expect(HealthResponse.parse({ ok: true, bridgeVersion: "0.2.0", protocol: { version: 1, min: 1 } }).protocol.version).toBe(1);
  expect(HealthResponse.safeParse({ ok: true }).success).toBe(false);
  expect(HealthResponse.safeParse({ ok: true, bridgeVersion: "0.2.0", protocol: { version: 0, min: 1 } }).success).toBe(false);
});

test("response schemas accept the bridge's bodies", () => {
  const status = { state: "queued", at: "2026-09-24T15:32:01.000Z" };
  expect(SendResponse.safeParse({ id: "2026-09-24T153200-tomato-soup-recipes", status }).success).toBe(true);
  expect(SendResponse.safeParse({ id: "not an id", status }).success).toBe(false);
  expect(BundleStatusResponse.shape.status.safeParse(null).success).toBe(true);
  expect(AckRequest.parse({}).summary).toBeUndefined();
  expect(OkResponse.safeParse({ ok: true }).success).toBe(true);
  expect(ErrorResponse.safeParse({ error: "bad token" }).success).toBe(true);
  expect(SessionsResponse.safeParse([{ id: "w1:p2", agent: "claude", cwd: "/home/me/project", title: "shell", method: "herdr", pane: "w1:p2" }]).success).toBe(true);
});

test("every conformance example parses with the schema it names", () => {
  for (const x of conformance) {
    const ok = responseSchemas[x.response.schema].safeParse(x.response.example).success;
    expect({ name: x.name, ok }).toEqual({ name: x.name, ok: true });
  }
});

test("conformance covers the extension's four calls, in the order a send makes them", () => {
  const ext = conformance.filter((x) => x.request.auth === "extension" && x.status < 400).map((x) => `${x.request.method} ${x.request.path}`);
  expect(ext).toEqual(["POST /health", "POST /sessions", "POST /bundles", "POST /bundles/:id/status"]);
  expect(new Set(conformance.map((x) => x.name)).size).toBe(conformance.length);
  expect(BundleInput.safeParse(exampleBundleInput).success).toBe(true);
  expect(EXAMPLE_BUNDLE_ID).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}-[a-z0-9-]+$/);
});
