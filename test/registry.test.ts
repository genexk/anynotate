import { expect, test } from "bun:test";
import { Registry } from "../src/bridge/registry";

test("entries expire after the TTL unless heartbeated", () => {
  let t = 0;
  const r = new Registry(30_000, () => t);
  r.register({ id: "c1", agent: "claude", cwd: "/r", title: "my-feature" });
  expect(r.live().map((s) => s.id)).toEqual(["c1"]);
  t = 29_000; expect(r.heartbeat("c1")).toBe(true);
  t = 58_000; expect(r.live().length).toBe(1);
  t = 90_000; expect(r.live()).toEqual([]);
  expect(r.heartbeat("nope")).toBe(false);
});

test("sender exists only when attached and live", () => {
  let t = 0;
  const r = new Registry(30_000, () => t);
  r.register({ id: "c1", agent: "claude", cwd: "/r", title: "" });
  expect(r.sender("c1")).toBeUndefined();
  const got: string[] = [];
  r.attach("c1", (b) => got.push(b));
  r.sender("c1")!("b-1");
  expect(got).toEqual(["b-1"]);
  t = 31_000; expect(r.sender("c1")).toBeUndefined();
  t = 0; r.detach("c1"); expect(r.sender("c1")).toBeUndefined();
});

test("live() reports push sessions", () => {
  const r = new Registry();
  r.register({ id: "c1", agent: "codex", cwd: "/r", title: "t" });
  expect(r.live()).toEqual([{ id: "c1", agent: "codex", cwd: "/r", title: "t", method: "push" }]);
});

test("attach reports whether the id is registered", () => {
  const r = new Registry();
  expect(r.attach("ghost", () => {})).toBe(false);
  r.register({ id: "c1", agent: "claude", cwd: "/r", title: "" });
  expect(r.attach("c1", () => {})).toBe(true);
});

test("detach with a sender only clears that sender", () => {
  const r = new Registry();
  r.register({ id: "c1", agent: "claude", cwd: "/r", title: "" });
  const a = () => {};
  const b = () => {};
  r.attach("c1", a);
  r.attach("c1", b);
  r.detach("c1", a);
  expect(r.sender("c1")).toBe(b);
  r.detach("c1", b);
  expect(r.sender("c1")).toBeUndefined();
});
