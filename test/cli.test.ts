import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBundle } from "../src/inbox/store";
import { sampleInput } from "./fixtures/sample";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "anynotate-")); process.env.ANYNOTATE_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ANYNOTATE_HOME; });

test("hook writes its full output to a pipe, well past 64 KB", async () => {
  const ids = [1, 2, 3].map((n) => writeBundle({ ...sampleInput, overall: `${n}`.repeat(300_000) }, {}).id);
  const proc = Bun.spawn([join(import.meta.dir, "../bin/anynotate"), "hook", "--agent", "claude"], {
    env: { ...process.env, ANYNOTATE_HOME: home },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-1", cwd: "/tmp/repo" })),
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out.length).toBeGreaterThan(900_000);
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
  for (const id of ids) expect(ctx).toContain(id);
});

test("hook --agent accepts any valid agent name and ignores an invalid one", async () => {
  const run = async (agent: string) => {
    const proc = Bun.spawn([join(import.meta.dir, "../bin/anynotate"), "hook", "--agent", agent], {
      env: { ...process.env, ANYNOTATE_HOME: home },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-1", cwd: "/a" })),
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out;
  };
  const id = writeBundle({ ...sampleInput, target: { agent: "agy", cwd: "/a" } }, {}).id;
  expect(await run("Bad/Name")).toBe("");
  const out = JSON.parse(await run("agy"));
  expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  expect(out.hookSpecificOutput.additionalContext).toContain(id);
});
