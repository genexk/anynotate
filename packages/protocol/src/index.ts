import { z } from "zod";

export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const Agent = z.string().regex(AGENT_NAME);
export type Agent = z.infer<typeof Agent>;

export const INTENTS = ["explain", "change", "approve"] as const;
export const LEGACY_INTENTS = ["question", "bug", "note"] as const;
/** The intent clients should send; parsed annotations may also hold a LEGACY_INTENTS value. */
export type Intent = (typeof INTENTS)[number];

const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** A rectangle the user drew, in CSS px relative to the viewport at capture time (add `viewport.scrollY` for page y). */
export const Region = z.object({ x: z.number(), y: z.number(), w: z.number().nonnegative(), h: z.number().nonnegative() });
export type Region = z.infer<typeof Region>;

export const Annotation = z.object({
  id: z.string().regex(/^A\d+$/),
  // v1 kinds only; "region" | "draw" are reserved for later tools.
  kind: z.enum(["text", "element"]),
  comment: z.string(),
  intent: z.enum([...INTENTS, ...LEGACY_INTENTS]).optional(),
  anchor: z.object({
    quote: z.object({ exact: z.string(), prefix: z.string(), suffix: z.string() }).optional(),
    position: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
    css: z.string(),
    path: z.array(z.string()),
    near: z.string(),
    hosts: z.array(z.string()).optional(),
    /** CSS selectors of the iframes holding the note, outermost first, each resolved in the previous frame's document; absent for the top document. `css`, `hosts` and `path` are then inside the innermost frame, while `box` and `region` stay in the top page's viewport. */
    frames: z.array(z.string()).optional(),
  }),
  element: z.object({
    tag: z.string(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().max(500),
    html: z.string().max(4096),
    attrs: z.record(z.string(), z.string()),
  }).optional(),
  box: Box,
  viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number(), scrollY: z.number() }),
  crop: z.string().regex(/^crops\/A\d+\.png$/),
  region: Region.optional(),
  /** True when the note's target was not on screen at send time (scrolled out of a virtual list, another tab); `box` and the crop are from when it was last seen. */
  offscreen: z.boolean().optional(),
}).refine((a) => !a.region || a.kind === "element", { message: "region is only allowed on element annotations", path: ["region"] });
export type Annotation = z.infer<typeof Annotation>;

export const Target = z.object({
  agent: Agent,
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  pane: z.string().optional(),
});
export type Target = z.infer<typeof Target>;

// What the extension POSTs; the bridge assigns id and files.
export const BundleInput = z.object({
  v: z.literal(1),
  url: z.string(),
  title: z.string(),
  sentAt: z.iso.datetime({ offset: true }),
  target: Target,
  overall: z.string().optional(),
  annotations: z.array(Annotation),
});
export type BundleInput = z.infer<typeof BundleInput>;

// Matches what newBundleId produces, including the "-<n>" collision suffix.
export const BUNDLE_ID = /^\d{4}-\d{2}-\d{2}T\d{6}-[a-z0-9-]+$/;

export const Bundle = BundleInput.extend({
  id: z.string().regex(BUNDLE_ID),
  files: z.object({ page: z.string(), screenshot: z.string(), snapshot: z.string().optional() }),
});
export type Bundle = z.infer<typeof Bundle>;

export const Via = z.enum(["push", "herdr", "hook", "pull"]);
export type Via = z.infer<typeof Via>;

export const Status = z.object({
  state: z.enum(["queued", "delivered", "acked"]),
  at: z.string(),
  via: Via.optional(),
  session: z.string().optional(),
  agent: Agent.optional(),
  summary: z.string().optional(),
  note: z.string().optional(),
});
export type Status = z.infer<typeof Status>;

export const Session = z.object({
  id: z.string(),
  agent: Agent,
  cwd: z.string(),
  title: z.string(),
  method: z.enum(["push", "herdr", "next-prompt"]),
  pane: z.string().optional(),
  sessionIds: z.array(z.string()).optional(),
  /** Display name of the herdr workspace a herdr pane is in. */
  workspace: z.string().optional(),
});
export type Session = z.infer<typeof Session>;

// Protocol v2. Additive changes (optional fields, new endpoints) keep the version; removals, renames and
// semantic changes bump PROTOCOL_VERSION, and the bridge keeps accepting the previous version for a release.
export const PROTOCOL_VERSION = 2;
export const PROTOCOL_MIN = 1;

export const HealthResponse = z.object({
  ok: z.literal(true),
  bridgeVersion: z.string(),
  protocol: z.object({ version: z.number().int().positive(), min: z.number().int().positive() }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const SessionsResponse = z.array(Session);
export type SessionsResponse = z.infer<typeof SessionsResponse>;

export const SendResponse = z.object({ id: z.string().regex(BUNDLE_ID), status: Status });
export type SendResponse = z.infer<typeof SendResponse>;

export const BundleStatusResponse = z.object({ bundle: Bundle, status: Status.nullable() });
export type BundleStatusResponse = z.infer<typeof BundleStatusResponse>;

export const AckRequest = z.object({ summary: z.string().optional() });
export type AckRequest = z.infer<typeof AckRequest>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

export const ErrorResponse = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export type Compatibility = "ok" | "bridge-too-old" | "extension-too-old";

// A client supports protocol versions [min, max]; a bridge speaks `version` and still accepts down to `min`.
export function compatibility(client: { min: number; max: number }, bridge: { version: number; min: number }): Compatibility {
  if (bridge.version < client.min) return "bridge-too-old";
  if (client.max < bridge.min) return "extension-too-old";
  return "ok";
}
