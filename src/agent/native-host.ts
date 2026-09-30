import { resolve } from "node:path";
import { readOrigins } from "../bridge/origins";
import { loadOrCreateToken } from "../bridge/token";
import { extensionOrigins } from "./install";

// Chrome native messaging: a 4-byte little-endian length, then UTF-8 JSON.
// Chrome caps messages to a host at 4 GB; a token request is tiny, so anything over 1 MB is refused
// before it is buffered.
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export type NativeReply = { ok: true; token: string } | { ok: false; error: string };

export function encodeMessage(obj: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, true);
  out.set(body, 4);
  return out;
}

export function decodeMessage(buf: Uint8Array): { value: unknown; rest: Uint8Array } | null {
  if (buf.length < 4) return null;
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true);
  if (len > MAX_MESSAGE_BYTES) throw new RangeError(`message of ${len} bytes exceeds ${MAX_MESSAGE_BYTES}`);
  if (buf.length < 4 + len) return null;
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(4, 4 + len)));
  return { value, rest: buf.subarray(4 + len) };
}

const bare = (origin: string) => (origin.endsWith("/") ? origin.slice(0, -1) : origin);

// The caller is checked before the request, so a refused caller never causes the token to be read or created.
export function nativeReply(request: unknown, callerOrigin: string | undefined, allowedOrigins: string[], readToken: () => string): NativeReply {
  const caller = callerOrigin ? bare(callerOrigin) : "";
  if (!caller || !allowedOrigins.some((o) => bare(o) === caller)) return { ok: false, error: "origin not allowed" };
  const isTokenRequest = typeof request === "object" && request !== null && !Array.isArray(request) && (request as { type?: unknown }).type === "token";
  if (!isTokenRequest) return { ok: false, error: "unknown request" };
  return { ok: true, token: readToken() };
}

const repo = resolve(import.meta.dir, "../..");

// Reads exactly one request and writes exactly one reply. EOF before a full frame rejects without
// writing; an oversized or malformed frame gets an error reply and nothing more is read.
export async function runNativeHost(argv: string[], input: AsyncIterable<Uint8Array>, write: (b: Uint8Array) => void): Promise<void> {
  let buf = new Uint8Array(0);
  let request: unknown;
  let failure: string | undefined;
  let complete = false;
  for await (const chunk of input) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
    try {
      const got = decodeMessage(buf);
      if (!got) continue;
      request = got.value;
    } catch (err) {
      failure = err instanceof RangeError ? "message too large" : "malformed message";
    }
    complete = true;
    break;
  }
  if (!complete) throw new Error("input closed before a full message");
  const reply: NativeReply = failure
    ? { ok: false, error: failure }
    : nativeReply(request, argv[0], [...readOrigins(), ...extensionOrigins(repo)], loadOrCreateToken);
  write(encodeMessage(reply));
}
