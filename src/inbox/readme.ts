import type { Annotation, Bundle } from "@anynotate/protocol";

function where(a: Annotation): string {
  const parts: string[] = [];
  if (a.anchor.near) parts.push(`under "${a.anchor.near}"`);
  if (a.element) {
    const label = a.element.name || a.element.text.slice(0, 60);
    parts.push(`<${a.element.tag}>${label ? ` "${label}"` : ""}${a.element.role ? ` (role=${a.element.role})` : ""}`);
  }
  return parts.join(" · ");
}

function section(a: Annotation, uploaded: ReadonlySet<string>): string {
  const head = [a.id, a.kind, a.intent, where(a)].filter(Boolean).join(" · ");
  const lines = [`## ${head}`];
  if (a.anchor.quote) lines.push(`> quote: "${a.anchor.quote.exact}"`);
  lines.push(`Comment: ${a.comment || "(no comment)"}`);
  lines.push(`Crop: ${uploaded.has(a.crop) ? a.crop : "(none)"} · selector: \`${a.anchor.css}\``);
  return lines.join("\n");
}

export function renderReadme(b: Bundle, uploaded: ReadonlySet<string>): string {
  const n = b.annotations.length;
  const vp = b.annotations[0]?.viewport;
  const target = `${b.target.agent} @ ${b.target.cwd ?? b.target.pane ?? b.target.sessionId ?? "any"}`;
  const out = [
    `# Browser notes: "${b.title}" (${b.url})`,
    `Sent ${b.sentAt} · ${n} note${n === 1 ? "" : "s"}${vp ? ` · viewport ${vp.w}×${vp.h}` : ""} · target: ${target}`,
    "",
    "The user annotated this page in their browser and wants you to act on these notes.",
  ];
  if (b.overall) out.push("", "## Overall", `> ${b.overall}`);
  for (const a of b.annotations) out.push("", section(a, uploaded));
  const files = [
    `${b.files.page} (search ⟦${b.annotations[0]?.id ?? "An"}⟧ to find each note in the page structure)`,
    `${b.files.screenshot} (viewport with numbered markers)`,
    "annotations.json (selectors, element HTML, boxes)",
  ];
  if (b.files.snapshot) files.push(`${b.files.snapshot} (full DOM archive; grep, do not read whole)`);
  out.push("", "## Files (in this folder)", ...files.map((f) => `- ${f}`), "");
  return out.join("\n");
}
