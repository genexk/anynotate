import { type Annotation, type Bundle, INTENTS, type Intent } from "@anynotate/protocol";
import { describeTarget } from "./target";

const DIRECTIVES: Record<Intent, string> = {
  explain: "**Explain** this.",
  change: "**Change requested.**",
  approve: "**Approved** — no change needed.",
};

function where(a: Annotation): string {
  const parts: string[] = [];
  if (a.anchor.near) parts.push(`under "${a.anchor.near}"`);
  if (a.element) {
    const label = a.element.name || a.element.text.slice(0, 60);
    parts.push(`<${a.element.tag}>${label ? ` "${label}"` : ""}${a.element.role ? ` (role=${a.element.role})` : ""}`);
  }
  return parts.join(" · ");
}

function regionLine(a: Annotation, uploaded: ReadonlySet<string>): string | undefined {
  const r = a.region;
  if (!r) return undefined;
  const n = Math.round;
  const on = a.element ? ` on <${a.element.tag}${a.element.attrs.id ? `#${a.element.attrs.id}` : ""}>` : "";
  const crop = uploaded.has(a.crop) ? ` · see ${a.crop}` : "";
  return `Region: ${n(r.w)}×${n(r.h)} at (${n(r.x)}, ${n(r.y)})${on}${crop}`;
}

function section(a: Annotation, uploaded: ReadonlySet<string>): string {
  const directive = a.intent && (INTENTS as readonly string[]).includes(a.intent) ? DIRECTIVES[a.intent as Intent] : undefined;
  const head = [a.id, a.kind, directive ? undefined : a.intent, where(a)].filter(Boolean).join(" · ") + (a.offscreen ? " (off-screen when sent)" : "");
  const lines = [`## ${head}`];
  if (directive) lines.push(directive);
  if (a.anchor.quote) lines.push(`> quote: "${a.anchor.quote.exact}"`);
  const region = regionLine(a, uploaded);
  if (region) lines.push(region);
  lines.push(`Comment: ${a.comment || "(no comment)"}`);
  const frames = a.anchor.frames?.length ? ` inside iframe ${a.anchor.frames.map((f) => `\`${f}\``).join(" › ")}` : "";
  lines.push(`Crop: ${uploaded.has(a.crop) ? a.crop : "(none)"} · selector: \`${a.anchor.css}\`${frames}`);
  return lines.join("\n");
}

export function renderReadme(b: Bundle, uploaded: ReadonlySet<string>): string {
  const n = b.annotations.length;
  const vp = b.annotations[0]?.viewport;
  const target = describeTarget(b.target);
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
