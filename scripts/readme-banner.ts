// Renders the README's hero banner (docs/readme/banner.png) from the guide screenshots. Playwright is borrowed
// from the extension checkout, as in guide-tui-shots.ts:
//   ANYNOTATE_PLAYWRIGHT=../anynotate-extension/node_modules/playwright bun scripts/readme-banner.ts
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "docs/readme/banner.png");
const PLAYWRIGHT = resolve(process.env.ANYNOTATE_PLAYWRIGHT ?? join(ROOT, "../anynotate-extension/node_modules/playwright"));

const dataUri = (path: string) => `data:image/png;base64,${readFileSync(join(ROOT, path)).toString("base64")}`;

function html(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    width: 1280px; height: 640px; overflow: hidden; position: relative;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif;
    color: #f3f0fa;
    background:
      radial-gradient(55% 60% at 12% 10%, rgb(91 45 110 / 90%), transparent 70%),
      radial-gradient(50% 60% at 92% 20%, rgb(44 88 201 / 70%), transparent 70%),
      radial-gradient(45% 50% at 45% 85%, rgb(123 63 147 / 55%), transparent 70%),
      radial-gradient(35% 40% at 85% 100%, rgb(255 216 74 / 22%), transparent 70%),
      #0d0b17;
  }
  .head { position: absolute; left: 56px; top: 40px; display: flex; align-items: center; gap: 16px; }
  .head img { width: 52px; height: 52px; border-radius: 12px; }
  .name { font-size: 34px; font-weight: 700; letter-spacing: -0.02em; }
  .tag { font-size: 19px; color: #cbc3da; margin-top: 2px; }
  .tag b { color: #ffd84a; font-weight: 600; }
  .glass {
    position: absolute; border-radius: 16px; overflow: hidden;
    background: rgb(22 17 36 / 60%);
    border: 1px solid rgb(255 255 255 / 22%);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%), 0 30px 60px -20px rgb(0 0 0 / 75%);
  }
  .browser { left: 56px; top: 132px; width: 720px; }
  .bar { height: 34px; display: flex; align-items: center; gap: 7px; padding: 0 14px; background: rgb(255 255 255 / 8%); border-bottom: 1px solid rgb(255 255 255 / 14%); }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .url { margin-left: 14px; flex: 1; height: 20px; border-radius: 10px; background: rgb(255 255 255 / 10%); font-size: 12px; line-height: 20px; padding-left: 12px; color: #cbc3da; }
  .browser img { display: block; width: 720px; height: 450px; }
  .tui { right: 48px; top: 300px; width: 470px; padding: 0; }
  .tui img { display: block; width: 470px; }
  .arrow {
    position: absolute; left: 744px; top: 220px; display: flex; align-items: center; gap: 10px;
    padding: 12px 22px; border-radius: 999px; font-size: 22px; font-weight: 700; color: #1b1626;
    background: linear-gradient(160deg, #ffe680, #ffd84a);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 60%), 0 18px 36px -14px rgb(255 216 74 / 55%);
  }
  .arrow span { font-size: 26px; }
  .caption { position: absolute; right: 48px; top: 268px; width: 470px; text-align: right; font-size: 14px; color: #cbc3da; }
  </style></head><body>
  <div class="head">
    <img src="${dataUri("site/img/icon.png")}" alt="">
    <div><div class="name">Anynotate</div><div class="tag">Annotate anything in your browser. <b>Send it to your AI.</b></div></div>
  </div>
  <div class="glass browser">
    <div class="bar"><i class="dot" style="background:#ff5f57"></i><i class="dot" style="background:#febc2e"></i><i class="dot" style="background:#28c840"></i><div class="url">example.com/recipes/tomato-soup</div></div>
    <img src="${dataUri("site/img/guide/4-notes-light.png")}" alt="">
  </div>
  <div class="arrow"><span>→</span> your agent</div>
  <div class="caption">claude · codex · any agent in a herdr pane</div>
  <div class="glass tui"><img src="${dataUri("site/img/guide/inbox-send.png")}" alt=""></div>
  </body></html>`;
}

type Chromium = {
  launch(): Promise<{
    newContext(o: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<{
      newPage(): Promise<{ setContent(html: string): Promise<void>; screenshot(o: { path: string }): Promise<unknown> }>;
    }>;
    close(): Promise<void>;
  }>;
};

async function main() {
  const { chromium } = (await import(join(PLAYWRIGHT, "index.mjs"))) as { chromium: Chromium };
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
    const tab = await ctx.newPage();
    await tab.setContent(html());
    mkdirSync(join(ROOT, "docs/readme"), { recursive: true });
    await tab.screenshot({ path: OUT });
    console.log(OUT);
  } finally {
    await browser.close();
  }
}

await main();
