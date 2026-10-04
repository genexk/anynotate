// A stand-in for the herdr CLI, run by bun through the launcher writeHerdrShim generates.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

appendFileSync(need("HERDR_SHIM_LOG"), `${args.join(" ")}\n`);
const command = `${args[0] ?? ""} ${args[1] ?? ""}`;
if (command === "agent list") process.stdout.write(readFileSync(need("HERDR_SHIM_LIST")));
if (command === "workspace list" && process.env.HERDR_SHIM_WORKSPACES) process.stdout.write(readFileSync(process.env.HERDR_SHIM_WORKSPACES));
// HERDR_SHIM_ON_PROMPT is JSON { argv, stdin }: a command to run as if the typed prompt had fired the pane's hook.
if (command === "agent prompt" && process.env.HERDR_SHIM_ON_PROMPT) {
  const { argv, stdin } = JSON.parse(process.env.HERDR_SHIM_ON_PROMPT) as { argv: string[]; stdin: string };
  const r = Bun.spawnSync(argv, { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "inherit" });
  appendFileSync(need("HERDR_SHIM_ON_PROMPT_OUT"), `[${r.stdout.toString().replace(/\n+$/, "")}]\n`);
}
// HERDR_SHIM_FAIL is JSON { "<group> <command>": { code, stderr } }: that command fails with that exit code and stderr.
const fail = (JSON.parse(process.env.HERDR_SHIM_FAIL ?? "{}") as Record<string, { code: number; stderr?: string }>)[command];
if (fail) {
  process.stderr.write(fail.stderr ?? "");
  process.exit(fail.code);
}
process.exit(Number(process.env.HERDR_SHIM_EXIT ?? 0));
