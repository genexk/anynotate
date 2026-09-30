import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMessage, encodeMessage, MAX_MESSAGE_BYTES, nativeReply, runNativeHost } from "../src/agent/native-host";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const ALLOWED = [`chrome-extension://${ID}`];
const TOKEN = "a".repeat(64);

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

async function* chunks(...parts: Uint8Array[]) {
  for (const p of parts) yield p;
}

function frameHeader(len: number) {
  const h = new Uint8Array(4);
  new DataView(h.buffer).setUint32(0, len, true);
  return h;
}

test("encode and decode round-trip, including non-ASCII text", () => {
  const msg = { type: "token", title: "Tomato soup – Recipes ⟦A1⟧ 🍅" };
  const buf = encodeMessage(msg);
  expect(new DataView(buf.buffer, buf.byteOffset).getUint32(0, true)).toBe(buf.length - 4);
  const out = decodeMessage(buf)!;
  expect(out.value).toEqual(msg);
  expect(out.rest.length).toBe(0);
});

test("decode waits for a full frame split across chunks and keeps the rest", () => {
  const a = encodeMessage({ type: "token" });
  const b = encodeMessage({ type: "other" });
  const all = new Uint8Array([...a, ...b]);
  expect(decodeMessage(all.slice(0, 2))).toBeNull();
  expect(decodeMessage(all.slice(0, a.length - 1))).toBeNull();
  const first = decodeMessage(all)!;
  expect(first.value).toEqual({ type: "token" });
  expect(decodeMessage(first.rest)!.value).toEqual({ type: "other" });
});

test("decode refuses a length prefix over the cap", () => {
  expect(() => decodeMessage(frameHeader(MAX_MESSAGE_BYTES + 1))).toThrow();
});

test("an allowed origin gets the token, with or without the trailing slash", () => {
  for (const origin of [`chrome-extension://${ID}/`, `chrome-extension://${ID}`]) {
    expect(nativeReply({ type: "token" }, origin, ALLOWED, () => TOKEN)).toEqual({ ok: true, token: TOKEN });
  }
  expect(nativeReply({ type: "token" }, `chrome-extension://${ID}/`, [`${ALLOWED[0]}/`], () => TOKEN)).toEqual({ ok: true, token: TOKEN });
});

test("a foreign or missing origin is refused without reading the token", () => {
  let reads = 0;
  const readToken = () => { reads++; return TOKEN; };
  for (const origin of ["chrome-extension://pponmlkjihgfedcbapponmlkjihgfedcb/", undefined, "", "/", `chrome-extension://${ID}//`, "https://recipes.example.com"]) {
    const r = nativeReply({ type: "token" }, origin, ALLOWED, readToken);
    expect(r.ok).toBe(false);
  }
  expect(reads).toBe(0);
});

test("an unknown request is refused without reading the token", () => {
  let reads = 0;
  const readToken = () => { reads++; return TOKEN; };
  for (const req of [{ type: "other" }, {}, null, "token", ["token"]]) {
    const r = nativeReply(req, ALLOWED[0], ALLOWED, readToken);
    expect(r).toMatchObject({ ok: false });
    expect(typeof (r as { error: string }).error).toBe("string");
  }
  expect(reads).toBe(0);
});

test("runNativeHost answers one framed request from split chunks", async () => {
  writeFileSync(join(home, "origins"), `${ALLOWED[0]}\n`);
  const req = encodeMessage({ type: "token" });
  const out: Uint8Array[] = [];
  await runNativeHost([`${ALLOWED[0]}/`], chunks(req.slice(0, 3), req.slice(3)), (b) => out.push(b));
  expect(out.length).toBe(1);
  const reply = decodeMessage(out[0]!)!.value as { ok: boolean; token: string };
  expect(reply).toEqual({ ok: true, token: readFileSync(join(home, "token"), "utf8").trim() });
});

test("runNativeHost refuses a disallowed caller and never creates a token", async () => {
  const out: Uint8Array[] = [];
  await runNativeHost(["chrome-extension://pponmlkjihgfedcbapponmlkjihgfedcb/"], chunks(encodeMessage({ type: "token" })), (b) => out.push(b));
  expect(decodeMessage(out[0]!)!.value).toMatchObject({ ok: false });
  expect(existsSync(join(home, "token"))).toBe(false);
});

test("runNativeHost stops reading at an oversized length prefix", async () => {
  let pulled = 0;
  async function* endless() {
    yield frameHeader(MAX_MESSAGE_BYTES + 1);
    for (;;) { pulled++; yield new Uint8Array(65_536); }
  }
  const out: Uint8Array[] = [];
  await runNativeHost([`${ALLOWED[0]}/`], endless(), (b) => out.push(b));
  expect(pulled).toBe(0);
  expect(decodeMessage(out[0]!)!.value).toMatchObject({ ok: false });
});

test("runNativeHost answers malformed JSON with an error", async () => {
  const body = new TextEncoder().encode("{not json");
  const out: Uint8Array[] = [];
  await runNativeHost([`${ALLOWED[0]}/`], chunks(frameHeader(body.length), body), (b) => out.push(b));
  expect(decodeMessage(out[0]!)!.value).toMatchObject({ ok: false });
});

test("runNativeHost rejects on EOF before a full frame and writes nothing", async () => {
  const out: Uint8Array[] = [];
  await expect(runNativeHost([`${ALLOWED[0]}/`], chunks(frameHeader(10), new Uint8Array(3)), (b) => out.push(b))).rejects.toThrow();
  expect(out).toEqual([]);
});

const bin = join(import.meta.dir, "../bin/anynotate");

async function readFrame(stream: ReadableStream<Uint8Array>) {
  let buf = new Uint8Array(0);
  for await (const c of stream) {
    buf = new Uint8Array([...buf, ...c]);
    const got = decodeMessage(buf);
    if (got) return { value: got.value, extra: got.rest.length };
  }
  return null;
}

test("the native-host command hands an allowed extension the token and exits while stdin stays open", async () => {
  writeFileSync(join(home, "origins"), `${ALLOWED[0]}\n`);
  const proc = Bun.spawn([bin, "native-host", `${ALLOWED[0]}/`], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ANYNOTATE_HOME: home },
  });
  proc.stdin.write(encodeMessage({ type: "token" }));
  await proc.stdin.flush();
  const reply = await readFrame(proc.stdout);
  expect(await proc.exited).toBe(0);
  expect(reply).toEqual({ value: { ok: true, token: readFileSync(join(home, "token"), "utf8").trim() }, extra: 0 });
});

test("the native-host command refuses a foreign extension", async () => {
  const proc = Bun.spawn([bin, "native-host", "chrome-extension://pponmlkjihgfedcbapponmlkjihgfedcb/"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ANYNOTATE_HOME: home },
  });
  proc.stdin.write(encodeMessage({ type: "token" }));
  await proc.stdin.flush();
  const reply = await readFrame(proc.stdout);
  expect(await proc.exited).toBe(0);
  expect(reply!.value).toMatchObject({ ok: false });
  expect(existsSync(join(home, "token"))).toBe(false);
});

test("the native-host command exits non-zero with empty stdout on a truncated frame", async () => {
  const proc = Bun.spawn([bin, "native-host", `${ALLOWED[0]}/`], {
    stdin: new Uint8Array([...frameHeader(10), 1, 2]), stdout: "pipe", stderr: "pipe", env: { ...process.env, ANYNOTATE_HOME: home },
  });
  const out = await new Response(proc.stdout).arrayBuffer();
  expect(await proc.exited).not.toBe(0);
  expect(out.byteLength).toBe(0);
});
