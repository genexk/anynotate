import type { z } from "zod";
import {
  BundleStatusResponse, type BundleInput, ErrorResponse, HealthResponse, OkResponse, SendResponse, SessionsResponse,
} from "./index.js";

// Shared request/response examples. The bridge's tests replay every exchange against a live bridge; client
// tests check that they make the extension exchanges with exactly this method and path and can parse the examples.
export const FIXTURE_EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
export const EXAMPLE_BUNDLE_ID = "2026-09-24T153200-tomato-soup-recipes";

export const exampleBundleInput: BundleInput = {
  v: 1,
  url: "https://recipes.example.com/tomato-soup",
  title: "Tomato soup – Recipes",
  sentAt: "2026-09-24T15:32:00.000Z",
  target: { agent: "claude", sessionId: "s-1", cwd: "/tmp/repo" },
  overall: "can we make this vegan?",
  annotations: [{
    id: "A1", kind: "text", comment: "is there a substitute for cream?", intent: "explain",
    anchor: {
      quote: { exact: "200 ml cream", prefix: "stir in ", suffix: " before serving" },
      css: "section#ingredients > li:nth-child(3)", path: ["main", "section#ingredients", "ul"], near: "Ingredients",
    },
    box: { x: 10, y: 20, w: 100, h: 18 },
    viewport: { w: 1280, h: 800, dpr: 2, scrollY: 0 },
    crop: "crops/A1.png",
  }, {
    id: "A2", kind: "element", comment: "make this bowl bigger", intent: "change",
    anchor: { css: "canvas#plating", path: ["main", "figure"], near: "Serving" },
    element: { tag: "canvas", text: "", html: '<canvas id="plating" width="800" height="600"></canvas>', attrs: { id: "plating" } },
    box: { x: 40, y: 300, w: 800, h: 600 },
    viewport: { w: 1280, h: 800, dpr: 2, scrollY: 0 },
    crop: "crops/A2.png",
    region: { x: 310, y: 420, w: 220, h: 140 },
  }],
};
export const examplePage = "# Tomato soup\n\nstir in ⟦A1⟧200 ml cream before serving\n";

export const responseSchemas = {
  HealthResponse, SessionsResponse, SendResponse, BundleStatusResponse, OkResponse, ErrorResponse,
} satisfies Record<string, z.ZodType>;
export type SchemaName = keyof typeof responseSchemas;

export type Exchange = {
  name: string;
  request: {
    method: "GET" | "POST";
    path: string;
    // extension = allowed Origin and token; extension-no-token = allowed Origin only; token = X-Anynotate-Token, no Origin;
    // foreign-origin = a web page.
    auth: "extension" | "extension-no-token" | "token" | "none" | "foreign-origin";
    host?: string;
    json?: unknown;
    bundle?: { input: BundleInput; files: Record<string, string> };
  };
  status: number;
  response: { schema: SchemaName; example: unknown };
};

const health = { ok: true, bridgeVersion: "0.6.1", protocol: { version: 2, min: 1 } };
const queued = { state: "queued", at: "2026-09-24T15:32:01.000Z" };
const exampleBundle = { ...exampleBundleInput, id: EXAMPLE_BUNDLE_ID, files: { page: "page.md", screenshot: "screenshot.png" } };

export const conformance: Exchange[] = [
  { name: "health-extension", request: { method: "POST", path: "/health", auth: "extension" }, status: 200, response: { schema: "HealthResponse", example: health } },
  { name: "health-probe", request: { method: "GET", path: "/health", auth: "none" }, status: 200, response: { schema: "HealthResponse", example: health } },
  { name: "sessions-extension", request: { method: "POST", path: "/sessions", auth: "extension" }, status: 200, response: { schema: "SessionsResponse", example: [{ id: "w1:p2", agent: "claude", cwd: "/home/me/project", title: "shell", method: "herdr", pane: "w1:p2", workspace: "project" }] } },
  { name: "sessions-token", request: { method: "GET", path: "/sessions", auth: "token" }, status: 200, response: { schema: "SessionsResponse", example: [] } },
  { name: "sessions-extension-no-token", request: { method: "POST", path: "/sessions", auth: "extension-no-token" }, status: 401, response: { schema: "ErrorResponse", example: { error: "bad token" } } },
  { name: "sessions-unauthenticated", request: { method: "POST", path: "/sessions", auth: "none" }, status: 401, response: { schema: "ErrorResponse", example: { error: "bad token" } } },
  { name: "sessions-foreign-origin", request: { method: "POST", path: "/sessions", auth: "foreign-origin" }, status: 403, response: { schema: "ErrorResponse", example: { error: "forbidden origin" } } },
  { name: "health-wrong-host", request: { method: "GET", path: "/health", auth: "none", host: "evil.example" }, status: 403, response: { schema: "ErrorResponse", example: { error: "bad host" } } },
  { name: "send-bundle", request: { method: "POST", path: "/bundles", auth: "extension", bundle: { input: exampleBundleInput, files: { "page.md": examplePage } } }, status: 201, response: { schema: "SendResponse", example: { id: EXAMPLE_BUNDLE_ID, status: queued } } },
  { name: "bundle-status-extension", request: { method: "POST", path: "/bundles/:id/status", auth: "extension" }, status: 200, response: { schema: "BundleStatusResponse", example: { bundle: exampleBundle, status: queued } } },
  { name: "bundle-status-token", request: { method: "GET", path: "/bundles/:id", auth: "token" }, status: 200, response: { schema: "BundleStatusResponse", example: { bundle: exampleBundle, status: queued } } },
  { name: "ack", request: { method: "POST", path: "/bundles/:id/ack", auth: "token", json: { summary: "suggested oat cream" } }, status: 200, response: { schema: "OkResponse", example: { ok: true } } },
  { name: "bundle-status-unknown", request: { method: "POST", path: "/bundles/2026-01-01T000000-missing/status", auth: "extension" }, status: 404, response: { schema: "ErrorResponse", example: { error: "not found" } } },
];
