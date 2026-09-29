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
