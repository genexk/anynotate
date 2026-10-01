import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const cli = async (args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawn([join(import.meta.dir, "../bin/anynotate"), ...args], {
    env: { ...process.env, ANYNOTATE_HOME: home, ANYNOTATE_RETENTION_DAYS: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return { code: await proc.exited, out };
};

test("retention prints the effective setting and its source, and sets it in settings.json", async () => {
  expect((await cli(["retention"])).out).toBe("retention 30 days (default)\n");
  expect((await cli(["retention"], { ANYNOTATE_RETENTION_DAYS: "5" })).out).toBe("retention 5 days (env)\n");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ other: 1 }));
  expect((await cli(["retention", "7"])).out).toBe("retention set to 7 days (settings.json)\n");
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ other: 1, retentionDays: 7 });
  expect(statSync(join(home, "settings.json")).mode & 0o777).toBe(0o600);
  expect((await cli(["retention"])).out).toBe("retention 7 days (settings.json)\n");
  expect((await cli(["retention", "off"])).out).toBe("retention set to off (settings.json)\n");
  const bad = await cli(["retention", "soon"]);
  expect(bad.code).toBe(1);
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).retentionDays).toBe("off");
});

test("prune --dry-run lists old bundles without deleting them; prune deletes them", async () => {
  const old = writeBundle({ ...sampleInput, title: "old" }, {}, new Date(2000, 0, 1)).id;
  const fresh = writeBundle({ ...sampleInput, title: "fresh" }, {}).id;
  const dry = await cli(["prune", "--dry-run"]);
  expect(dry.out).toBe(`would prune ${old}\nwould prune 1 bundle(s) older than 30 days\n`);
  expect(existsSync(join(home, "inbox", old))).toBe(true);
  expect((await cli(["prune"])).out).toBe(`pruned ${old}\npruned 1 bundle(s) older than 30 days\n`);
  expect(existsSync(join(home, "inbox", old))).toBe(false);
  expect(existsSync(join(home, "inbox", fresh))).toBe(true);
});

test("prune rejects unknown arguments", async () => {
  const old = writeBundle({ ...sampleInput, title: "old" }, {}, new Date(2000, 0, 1)).id;
  for (const args of [["prune", "--dryrun"], ["prune", "now"], ["prune", "--dry-run", "x"]]) {
    expect((await cli(args)).code).toBe(1);
  }
  expect(existsSync(join(home, "inbox", old))).toBe(true);
});

test("retention <days> mentions the env override only when the env value is non-blank", async () => {
  expect((await cli(["retention", "7"], { ANYNOTATE_RETENTION_DAYS: "  " })).out).not.toContain("takes precedence");
  expect((await cli(["retention", "7"], { ANYNOTATE_RETENTION_DAYS: "3" })).out).toContain("takes precedence");
});
