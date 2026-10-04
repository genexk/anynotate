import { expect, test } from "bun:test";
import { Bundle, BundleInput, Session, Status, Target } from "@anynotate/protocol";
import { sampleInput } from "./fixtures/sample";

test("BundleInput accepts a valid text annotation", () => {
  expect(BundleInput.parse(sampleInput).annotations[0]!.id).toBe("A1");
});

test("reserved kinds are rejected in v1", () => {
  const bad = structuredClone(sampleInput) as any;
  bad.annotations[0].kind = "region";
  expect(() => BundleInput.parse(bad)).toThrow();
});

test("element html is capped at 4KB", () => {
  const bad = structuredClone(sampleInput) as any;
  bad.annotations[0].kind = "element";
  bad.annotations[0].element = { tag: "div", text: "x", html: "a".repeat(4097), attrs: {} };
  expect(() => BundleInput.parse(bad)).toThrow();
});

test("Bundle requires id and files", () => {
  expect(() => Bundle.parse(sampleInput)).toThrow();
  const b = Bundle.parse({ ...sampleInput, id: "2026-09-24T153200-tomato-soup", files: { page: "page.md", screenshot: "screenshot.png" } });
  expect(b.files.snapshot).toBeUndefined();
});

test("Status allows delivered via herdr", () => {
  expect(Status.parse({ state: "delivered", via: "herdr", at: "2026-09-24T15:33:00.000Z" }).via).toBe("herdr");
});

test("Bundle rejects ids outside the store id pattern", () => {
  const files = { page: "page.md", screenshot: "screenshot.png" };
  expect(() => Bundle.parse({ ...sampleInput, id: "../x", files })).toThrow();
  expect(() => Bundle.parse({ ...sampleInput, id: "tomato-soup", files })).toThrow();
  expect(Bundle.parse({ ...sampleInput, id: "2026-09-24T153200-tomato-soup-2", files }).id).toBe("2026-09-24T153200-tomato-soup-2");
});

test("sentAt must be an ISO datetime", () => {
  expect(BundleInput.safeParse({ ...sampleInput, sentAt: "junk" }).success).toBe(false);
  expect(BundleInput.safeParse({ ...sampleInput, sentAt: "2026-09-24" }).success).toBe(false);
  expect(BundleInput.safeParse({ ...sampleInput, sentAt: "2026-09-24T15:32:00+02:00" }).success).toBe(true);
});

test("any lowercase agent name is accepted as a target or session agent", () => {
  expect(Target.parse({ agent: "agy", pane: "w1:p1" }).agent).toBe("agy");
  expect(Session.parse({ id: "p", agent: "open_code-2", cwd: "/r", title: "", method: "herdr" }).agent).toBe("open_code-2");
});

test("agent names outside ^[a-z][a-z0-9_-]{0,31}$ are rejected", () => {
  for (const bad of ["", "Agy", "1agy", "a/b", "a b", "../x", "a".repeat(33)]) {
    expect(Target.safeParse({ agent: bad }).success).toBe(false);
  }
  expect(Target.safeParse({ agent: "a".repeat(32) }).success).toBe(true);
});

test("intent accepts explain, change, approve and the legacy values, and may be absent", () => {
  for (const intent of ["explain", "change", "approve", "question", "bug", "note"]) {
    const x = structuredClone(sampleInput) as any;
    x.annotations[0].intent = intent;
    expect(BundleInput.safeParse(x).success).toBe(true);
  }
  const praise = structuredClone(sampleInput) as any;
  praise.annotations[0].intent = "praise";
  expect(BundleInput.safeParse(praise).success).toBe(false);
  const none = structuredClone(sampleInput) as any;
  delete none.annotations[0].intent;
  expect(BundleInput.parse(none).annotations[0]!.intent).toBeUndefined();
});

const regionNote = () => {
  const x = structuredClone(sampleInput) as any;
  Object.assign(x.annotations[0], {
    kind: "element",
    anchor: { ...x.annotations[0].anchor, quote: undefined },
    element: { tag: "canvas", text: "", html: '<canvas id="board"></canvas>', attrs: { id: "board" } },
    region: { x: 310, y: 96, w: 420, h: 180 },
  });
  return x;
};

test("an element annotation may carry a region, and bundles without one still parse", () => {
  expect(BundleInput.parse(regionNote()).annotations[0]!.region).toEqual({ x: 310, y: 96, w: 420, h: 180 });
  expect(BundleInput.parse(sampleInput).annotations[0]!.region).toBeUndefined();
});

test("region is rejected on text annotations and with a negative size", () => {
  const onText = structuredClone(sampleInput) as any;
  onText.annotations[0].region = { x: 0, y: 0, w: 10, h: 10 };
  expect(BundleInput.safeParse(onText).success).toBe(false);
  const negative = regionNote();
  negative.annotations[0].region.w = -1;
  expect(BundleInput.safeParse(negative).success).toBe(false);
  const partial = regionNote();
  delete partial.annotations[0].region.h;
  expect(BundleInput.safeParse(partial).success).toBe(false);
});

test("unknown fields on an annotation and its region are stripped", () => {
  const x = regionNote();
  x.annotations[0].future = "ignored";
  x.annotations[0].region.rotation = 45;
  const a = BundleInput.parse(x).annotations[0] as any;
  expect(a.future).toBeUndefined();
  expect(a.region).toEqual({ x: 310, y: 96, w: 420, h: 180 });
});

test("offscreen is an optional boolean on any annotation", () => {
  const x = structuredClone(sampleInput) as any;
  x.annotations[0].offscreen = true;
  expect(BundleInput.parse(x).annotations[0]!.offscreen).toBe(true);
  expect(BundleInput.parse(sampleInput).annotations[0]!.offscreen).toBeUndefined();
  x.annotations[0].offscreen = "yes";
  expect(BundleInput.safeParse(x).success).toBe(false);
});

test("frames is an optional list of iframe selectors on the anchor", () => {
  const x = structuredClone(sampleInput) as any;
  x.annotations[0].anchor.frames = ["iframe#card", "iframe.inner"];
  expect(BundleInput.parse(x).annotations[0]!.anchor.frames).toEqual(["iframe#card", "iframe.inner"]);
  expect(BundleInput.parse(sampleInput).annotations[0]!.anchor.frames).toBeUndefined();
  x.annotations[0].anchor.frames = "iframe#card";
  expect(BundleInput.safeParse(x).success).toBe(false);
});

test("a session may name its herdr workspace", () => {
  const base = { id: "w1:p2", agent: "claude", cwd: "/home/me/project", title: "shell", method: "herdr", pane: "w1:p2" };
  expect(Session.parse({ ...base, workspace: "shop" }).workspace).toBe("shop");
  expect(Session.parse(base).workspace).toBeUndefined();
  expect(Session.safeParse({ ...base, workspace: 3 }).success).toBe(false);
});
