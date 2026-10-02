import type { Check } from "./doctor";

export const STATUS_USAGE = "usage: anynotate status [--notify]";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// One line for a herdr notification or a status bar; the exit code matches formatChecks.
export function summarizeChecks(checks: Check[], version: string): { line: string; code: number } {
  const bridge = checks.find((c) => c.name === "bridge");
  const parts = [`Anynotate ${version}`, bridge?.ok === false ? "bridge not running" : "bridge running"];
  const failed = checks.filter((c) => c.ok === false);
  const warnings = checks.filter((c) => c.ok === "warn" && !c.skipped).length;
  const skipped = checks.filter((c) => c.skipped).length;
  if (failed.length) {
    const [first] = failed;
    parts.push(`${first!.name}: ${first!.detail}${failed.length > 1 ? ` (+${failed.length - 1} more failed)` : ""}`);
  } else {
    const counts = [warnings ? plural(warnings, "warning") : "", skipped ? `${skipped} skipped` : ""].filter(Boolean);
    parts.push(counts.length ? counts.join(", ") : "all checks passed");
  }
  return { line: parts.join(" · "), code: failed.length ? 1 : 0 };
}

export const notifyArgv = (bin: string, line: string) => [bin, "notification", "show", "Anynotate", "--body", line];
