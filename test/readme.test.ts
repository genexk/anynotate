import { expect, test } from "bun:test";
import { renderReadme } from "../src/inbox/readme";
import { Bundle } from "@anynotate/protocol";
import { sampleInput } from "./fixtures/sample";

const bundle = Bundle.parse({
  ...sampleInput,
  id: "2026-09-24T153207-tomato-soup",
  files: { page: "page.md", screenshot: "screenshot.png", snapshot: "snapshot.html" },
  annotations: [
    sampleInput.annotations[0],
    { ...sampleInput.annotations[0], id: "A2", kind: "element", comment: "print this?", intent: "change",
      anchor: { ...sampleInput.annotations[0]!.anchor, quote: undefined, near: "Actions" },
      element: { tag: "button", role: "button", name: "Print recipe", text: "Print", html: "<button>Print</button>", attrs: {} },
      crop: "crops/A2.png" },
  ],
});

const uploaded = new Set(["page.md", "screenshot.png", "snapshot.html", "crops/A1.png", "crops/A2.png"]);

test("header carries title, url, count and target", () => {
  const md = renderReadme(bundle, uploaded);
  expect(md).toStartWith('# Browser notes: "Tomato soup – Recipes" (https://recipes.example.com/tomato-soup)');
  expect(md).toContain("2 notes");
  expect(md).toContain("target: claude @ /tmp/repo");
});

test("each annotation has location, quote or element, comment and crop", () => {
  const md = renderReadme(bundle, uploaded);
  expect(md).toContain('## A1 · text · question · under "Ingredients"');
  expect(md).toContain('> quote: "200 ml cream"');
  expect(md).toContain("Comment: is there a substitute for cream?");
  expect(md).toContain('## A2 · element · under "Actions" · <button> "Print recipe" (role=button)\n**Change requested.**');
  expect(md).toContain("crops/A2.png");
});

test("overall note and file index are present", () => {
  const md = renderReadme(bundle, uploaded);
  expect(md).toContain("## Overall\n> can we make this vegan?");
  expect(md).toContain("page.md (search ⟦A1⟧");
  expect(md).toContain("snapshot.html (full DOM archive; grep, do not read whole)");
});

test("a crop that was not uploaded is shown as (none), not as a path to a missing file", () => {
  const md = renderReadme(bundle, new Set(["page.md", "crops/A1.png"]));
  expect(md).toContain("Crop: crops/A1.png");
  expect(md).toContain("Crop: (none)");
  expect(md).not.toContain("crops/A2.png");
});

test("the file index names the bundle's own first note, not a hardcoded A1", () => {
  const onlyA2 = Bundle.parse({ ...bundle, annotations: [bundle.annotations[1]] });
  const md = renderReadme(onlyA2, uploaded);
  expect(md).toContain("page.md (search ⟦A2⟧");
  expect(md).not.toContain("⟦A1⟧");
  const none = Bundle.parse({ ...bundle, annotations: [], overall: "just a page note" });
  expect(renderReadme(none, uploaded)).toContain("page.md (search ⟦An⟧");
});

test("new intents get a directive line under the heading; legacy and missing intents get none", () => {
  const a = sampleInput.annotations[0]!;
  const note = (id: string, intent?: string) => ({ ...a, id, intent, crop: `crops/${id}.png` });
  const b = Bundle.parse({
    ...sampleInput,
    id: "2026-09-24T153207-tomato-soup",
    files: { page: "page.md", screenshot: "screenshot.png" },
    annotations: [note("A1", "explain"), note("A2", "change"), note("A3", "approve"), note("A4", "question"), note("A5")],
  });
  const md = renderReadme(b, uploaded);
  const quote = '> quote: "200 ml cream"';
  expect(md).toContain(`## A1 · text · under "Ingredients"\n**Explain** this.\n${quote}`);
  expect(md).toContain(`## A2 · text · under "Ingredients"\n**Change requested.**\n${quote}`);
  expect(md).toContain(`## A3 · text · under "Ingredients"\n**Approved** — no change needed.\n${quote}`);
  expect(md).toContain(`## A4 · text · question · under "Ingredients"\n${quote}`);
  expect(md).toContain(`## A5 · text · under "Ingredients"\n${quote}`);
  expect(md.match(/^\*\*(Explain|Change requested\.|Approved)\*\*/gm)).toHaveLength(3);
  expect(md).toContain("Comment: is there a substitute for cream?");
});
