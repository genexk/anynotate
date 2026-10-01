import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliArgv } from "./fixtures/spawn";
import { addOrigin, originsPath, readOrigins, removeOrigin } from "../src/bridge/origins";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

const id = "abcdefghijklmnopabcdefghijklmnop";

test("add is idempotent, validated, owner-only; list and remove work", () => {
  expect(readOrigins()).toEqual([]);
  expect(addOrigin(`chrome-extension://${id}`)).toEqual({ added: true });
  expect(addOrigin(`chrome-extension://${id}`)).toEqual({ added: false });
  expect(() => addOrigin("https://evil.example")).toThrow(/chrome-extension/);
  expect(() => addOrigin("chrome-extension://zzz")).toThrow(/chrome-extension/);
  expect(readOrigins()).toEqual([`chrome-extension://${id}`]);
  if (process.platform !== "win32") expect(statSync(originsPath()).mode & 0o777).toBe(0o600);
  expect(readFileSync(originsPath(), "utf8")).toBe(`chrome-extension://${id}\n`);
  expect(removeOrigin(`chrome-extension://${id}`)).toEqual({ removed: true });
  expect(removeOrigin(`chrome-extension://${id}`)).toEqual({ removed: false });
  expect(readOrigins()).toEqual([]);
});

// Reads stdout line by line until the startup line appears, or gives up after `ms`.
async function startupLine(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  let buf = "";
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())));
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk === null || chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const line = buf.split("\n").find((l) => l.includes("anynotate bridge on"));
      if (line) return line;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`no startup line within ${ms} ms; got: ${buf}`);
}

test("the bridge CLI merges env and file origins", async () => {
  const shared = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  addOrigin(`chrome-extension://${id}`);
  addOrigin(shared);
  const proc = Bun.spawn(cliArgv("bridge"), {
    env: { ...process.env, ANYNOTATE_HOME: home, ANYNOTATE_PORT: "0", ANYNOTATE_ALLOWED_ORIGINS: `chrome-extension://pppppppppppppppppppppppppppppppp, ${shared}, http://localhost:3000, null, *` },
    stdout: "pipe",
  });
  try {
    const line = await startupLine(proc.stdout, 10_000);
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(line)?.[1]);
    expect(line).toContain(`chrome-extension://${id}`);
    expect(line).toContain("chrome-extension://pppppppppppppppppppppppppppppppp");
    expect(line.split(shared).length).toBe(2);
    for (const bad of ["http://localhost:3000", "null", "*"]) expect(line).not.toContain(bad);
    const r = await fetch(`http://127.0.0.1:${port}/sessions`, { headers: { Origin: "http://localhost:3000" } });
    expect(r.status).toBe(403);
  } finally {
    proc.kill();
    await proc.exited;
  }
});
