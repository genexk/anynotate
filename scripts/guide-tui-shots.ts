// Renders the inbox TUI from made-up bundles in a throwaway ANYNOTATE_HOME and screenshots each state for the
// site's guide. Playwright is borrowed from the extension checkout, so this repo gains no dependency:
//   ANYNOTATE_PLAYWRIGHT=../anynotate-extension/node_modules/playwright bun scripts/guide-tui-shots.ts
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Annotation, BundleInput, Intent } from "@anynotate/protocol";
import type { Pane } from "../src/bridge/herdr";
import { applyEffect, type InboxDeps } from "../src/agent/inbox";
import { loadRows, readReadme } from "../src/agent/inbox-data";
import { handleKey, type InboxState, initialState, renderInbox, withSize } from "../src/agent/inbox-view";
import { updateStatus, writeBundle } from "../src/inbox/store";
import { ansiToHtml, escapeHtml } from "./ansi-html";

const OUT = resolve(import.meta.dir, "../site/img/guide");
const PLAYWRIGHT = resolve(process.env.ANYNOTATE_PLAYWRIGHT ?? join(import.meta.dir, "../../anynotate-extension/node_modules/playwright"));
process.env.TZ = "UTC";
const NOW = new Date("2026-09-30T15:00:00Z");
const COLS = 96;
const ROWS = 14;

const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

function text(id: string, comment: string, exact: string, near: string, intent?: Intent): Annotation {
  return {
    id, kind: "text", comment, intent,
    anchor: { quote: { exact, prefix: "", suffix: "" }, css: "main > p", path: ["main", "p"], near },
    box: { x: 48, y: 580, w: 280, h: 22 }, viewport: { w: 1280, h: 800, dpr: 1, scrollY: 0 }, crop: `crops/${id}.png`,
  };
}

function element(id: string, comment: string, tag: string, name: string, near: string, intent?: Intent): Annotation {
  return {
    id, kind: "element", comment, intent,
    anchor: { css: `${tag}.primary`, path: ["main", `${tag}.primary`], near },
    element: { tag, name, text: name, html: `<${tag} class="primary">${name}</${tag}>`, attrs: { class: "primary" } },
    box: { x: 48, y: 670, w: 114, h: 38 }, viewport: { w: 1280, h: 800, dpr: 1, scrollY: 0 }, crop: `crops/${id}.png`,
  };
}

type Fake = { input: BundleInput; minutes: number; status?: "delivered" | "acked"; via?: "herdr" | "hook"; session?: string; summary?: string };

const FAKES: Fake[] = [
  {
    minutes: 4320,
    status: "acked", via: "hook", summary: "Labelled the card number field",
    input: {
      v: 1, url: "https://example.com/checkout", title: "Checkout form – example.com", sentAt: "", target: { agent: "codex", sessionId: "7f3a9c21-5b8e-4d0a-9c61-2e4f8a7b1d30" },
      annotations: [text("A1", "This field has no label", "Card number", "Payment"), element("A2", "Disable until the form is valid", "button", "Pay now", "Payment", "change")],
    },
  },
  {
    minutes: 1440,
    input: {
      v: 1, url: "https://docs.example.com/getting-started", title: "Onboarding docs – Getting started", sentAt: "", target: { agent: "claude", cwd: "/home/me/docs" },
      annotations: [text("A1", "Step 3 skips the install command", "Run the setup wizard", "Install", "change")],
    },
  },
  {
    minutes: 130,
    status: "acked", via: "herdr", session: "w1:p3", summary: "Raised the contrast of the plan cards",
    input: {
      v: 1, url: "https://example.com/pricing", title: "Pricing page – example.com", sentAt: "", target: { agent: "codex", pane: "w1:p3" },
      annotations: [
        text("A1", "Too faint on a white card", "Billed yearly", "Plans", "change"),
        text("A2", "Why is Pro cheaper per seat here?", "$8 per seat", "Plans", "explain"),
        element("A3", "Looks right", "a", "Start free trial", "Plans", "approve"),
        text("A4", "Missing the currency", "Total today", "Summary", "change"),
      ],
    },
  },
  {
    minutes: 25,
    status: "delivered", via: "herdr", session: "w1:p2",
    input: {
      v: 1, url: "https://example.com/recipes/tomato-soup", title: "Tomato soup – Recipes", sentAt: "", target: { agent: "claude", pane: "w1:p2" },
      overall: "Looks good overall, just these three",
      annotations: [
        text("A1", "Say what temperature to roast at", "Roast the tomatoes with a little olive oil", "Method", "change"),
        text("A2", "How much is a pinch, roughly?", "a pinch of sugar", "Method", "explain"),
        element("A3", "Make this button easier to find", "button", "Print recipe", "Method"),
      ],
    },
  },
  {
    minutes: 3,
    input: {
      v: 1, url: "https://example.com/shop/pull/42", title: "Fix login button contrast · Pull Request #42 · example/shop", sentAt: "", target: { agent: "claude", pane: "w1:p2" },
      annotations: [element("A1", "Still fails contrast on hover", "button", "Log in", "Sign in", "change"), text("A2", "Keep this wording", "Forgot your password?", "Sign in", "approve")],
    },
  },
];

const PANES: Pane[] = [
  { pane: "w1:p2", agent: "claude", cwd: "/home/me/recipes", title: "soup", status: "idle", workspace: "recipes" },
  { pane: "w1:p3", agent: "codex", cwd: "/home/me/shop", title: "pricing", status: "working", workspace: "shop" },
  { pane: "w2:p1", agent: "claude", cwd: "/home/me/docs", title: "onboarding", status: "idle", workspace: "docs" },
];

function seed(): void {
  for (const f of FAKES) {
    const at = ago(f.minutes);
    const b = writeBundle({ ...f.input, sentAt: at.toISOString() }, {}, at);
    if (f.status) updateStatus(b.id, "guide", (s) => ({ ...s, state: f.status!, via: f.via, session: f.session, summary: f.summary }));
  }
}

const deps: InboxDeps = {
  loadRows,
  readReadme,
  listPanes: async () => ({ panes: PANES }),
  deliver: async () => ({ ok: true, line: "" }),
  remove: () => ({ ok: true }),
};

async function press(s: InboxState, ...keys: string[]): Promise<InboxState> {
  let state = s;
  for (const key of keys) {
    const step = handleKey(state, key);
    state = step.state;
    if (step.effect) state = (await applyEffect(state, step.effect, deps)).state;
  }
  return state;
}

const STYLE = `
:root { color-scheme: dark; }
html, body { margin: 0; background: transparent; }
body { padding: 0; display: inline-block; }
.win { background: #0f1218; border: 1px solid #2a303a; border-radius: 12px; overflow: hidden; }
.bar { position: relative; height: 34px; background: #1a1f28; border-bottom: 1px solid #262c36; display: flex; align-items: center; padding: 0 14px; }
.dots { display: flex; gap: 8px; }
.dots i { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; }
.dots i:nth-child(2) { background: #febc2e; } .dots i:nth-child(3) { background: #28c840; }
.title { position: absolute; left: 0; right: 0; text-align: center; color: #9aa3b2; font: 600 13px/34px -apple-system, "Segoe UI", system-ui, sans-serif; pointer-events: none; }
pre { margin: 0; padding: 14px 18px 16px; color: #d7dce4; font: 14px/20px Menlo, "SF Mono", "DejaVu Sans Mono", Consolas, monospace; white-space: pre-wrap; width: 96ch; }
.b { font-weight: 700; color: #f2f4f7; } .d { color: #7d8696; }
.fg-yellow { color: #e5c07b; } .fg-cyan { color: #56b6c2; } .fg-green { color: #98c379; } .fg-red { color: #e06c75; } .fg-blue { color: #61afef; } .fg-magenta { color: #c678dd; }
.cursor { background: #d7dce4; color: #0f1218; }
.bg-stripe { background: #1c2028; } .rv { background: #d7dce4; color: #0f1218; }
`;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div class="win"><div class="bar"><div class="dots"><i></i><i></i><i></i></div><div class="title">${escapeHtml(title)}</div></div><pre>${body}</pre></div></body></html>`;

type Shot = { screenshot(o: { path: string; omitBackground: boolean }): Promise<unknown> };
type Tab = { setContent(html: string): Promise<void>; locator(sel: string): Shot };
type Chromium = {
  launch(): Promise<{
    newContext(o: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<{ newPage(): Promise<Tab> }>;
    close(): Promise<void>;
  }>;
};

const tui = (s: InboxState) => page("Anynotate inbox", renderInbox(s, { now: NOW.getTime(), color: true, depth: "truecolor" }).map(ansiToHtml).join("\n"));

function agentIllustration(id: string): string {
  const c = (cls: string, t: string) => `<span class="${cls}">${escapeHtml(t)}</span>`;
  const lines = [
    c("d", "claude · w1:p2 · /home/me/recipes"),
    "",
    `${c("b", "›")} Browser notes waiting: read ~/.anynotate/inbox/${id}/README.md and act on them.`,
    "",
    `${c("fg-green", "●")} Reading the README: 3 notes on “Tomato soup – Recipes”.`,
    "",
    `${c("fg-green", "●")} 1. ${c("b", "Change")} · “Roast the tomatoes…” → added “at 200 °C (180 °C fan)” to the step.`,
    `${c("fg-green", "●")} 2. ${c("b", "Explain")} · “a pinch of sugar” → a pinch is about ⅛ teaspoon; added that`,
    "     as a hint after the ingredient.",
    `${c("fg-green", "●")} 3. ${escapeHtml("<button>")} “Print recipe” → moved it up next to the title and made it`,
    "     a filled button.",
    "",
    `${c("d", "  Edited recipes/tomato-soup.html (+6 −3). Marked the bundle as read.")}`,
    "",
    `${c("b", "›")} <span class="cursor"> </span>`,
  ];
  return page("Agent session (illustration)", lines.join("\n"));
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), "anynotate-guide-"));
  process.env.ANYNOTATE_HOME = home;
  try {
    seed();
    const rows = loadRows(false);
    const soup = rows.findIndex((r) => r.title.startsWith("Tomato soup"));
    const base = withSize(initialState(rows), COLS, ROWS);
    const atSoup = await press(base, ...Array<string>(soup).fill("down"));
    const shots: Record<string, string> = {
      "inbox-list.png": tui(base),
      "inbox-readme.png": tui(await press(atSoup, "enter")),
      "inbox-send.png": tui(await press(base, "s")),
      "inbox-delete.png": tui(await press(base, "down", "down", "down", "d")),
      "inbox-help.png": tui(await press(base, "?")),
      "agent-receives.png": agentIllustration(rows[soup]!.id),
    };
    const { chromium } = (await import(join(PLAYWRIGHT, "index.mjs"))) as { chromium: Chromium };
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1.5 });
      const tab = await ctx.newPage();
      mkdirSync(OUT, { recursive: true });
      for (const [name, html] of Object.entries(shots)) {
        await tab.setContent(html);
        await tab.locator("body").screenshot({ path: join(OUT, name), omitBackground: true });
        console.log(join(OUT, name));
      }
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
