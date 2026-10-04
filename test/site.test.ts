import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SITE = resolve(import.meta.dir, "..", "site");
const PAGES = ["index.html", "guide/index.html", "privacy/index.html", "support/index.html"];
const ALLOWED_HOSTS = new Set(["github.com", "genexk.github.io", "chromewebstore.google.com", "buymeacoffee.com"]);

function refs(html: string): string[] {
  const attrs = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
  const srcsets = [...html.matchAll(/\ssrcset="([^"]*)"/g)].flatMap((m) =>
    m[1]!.split(",").map((part) => part.trim().split(/\s+/)[0]!),
  );
  return [...attrs, ...srcsets];
}

function internalRefs(html: string): string[] {
  return refs(html).filter((r) => !/^(https?:|mailto:|#)/.test(r));
}

function target(page: string, ref: string): string {
  const path = ref.replace(/[?#].*$/, "");
  const abs = resolve(dirname(join(SITE, page)), path);
  return path === "" || path.endsWith("/") || (existsSync(abs) && statSync(abs).isDirectory()) ? join(abs, "index.html") : abs;
}

describe.each(PAGES)("site/%s", (page) => {
  const file = join(SITE, page);
  const html = () => readFileSync(file, "utf8");

  test("exists", () => {
    expect(existsSync(file)).toBe(true);
  });

  test("has a non-empty <title>", () => {
    expect(html()).toMatch(/<title>[^<]*\S[^<]*<\/title>/);
  });

  test("has a favicon that exists", () => {
    const icon = html().match(/<link rel="icon"[^>]*href="([^"]+)"/);
    expect(icon).not.toBeNull();
    expect(existsSync(target(page, icon![1]!))).toBe(true);
  });

  test("has no placeholder text", () => {
    expect(html()).not.toMatch(/TODO|lorem/i);
  });

  test("loads nothing from other origins", () => {
    expect(html()).not.toMatch(/\s(?:src|srcset)="https?:|<link[^>]+href="https?:|url\(\s*["']?https?:/);
  });

  test("links only to github.com, genexk.github.io, the Chrome Web Store and Buy me a coffee", () => {
    for (const ref of refs(html()).filter((r) => /^https?:/.test(r))) {
      expect(ALLOWED_HOSTS.has(new URL(ref).hostname), ref).toBe(true);
    }
  });

  test("every image has alt text and dimensions", () => {
    for (const img of html().match(/<img\b[^>]*>/g) ?? []) {
      expect(img, img).toMatch(/\salt="/);
      expect(img, img).toMatch(/\swidth="\d+"/);
      expect(img, img).toMatch(/\sheight="\d+"/);
    }
  });

  test("links to the guide from the site nav and the footer", () => {
    const navs = html().match(/<nav aria-label="(?:Site|Footer)">[\s\S]*?<\/nav>/g) ?? [];
    expect(navs).toHaveLength(2);
    for (const nav of navs) expect(nav).toMatch(/<a href="(?:\.\.\/)?(?:guide\/|\.\/)"[^>]*>Guide<\/a>/);
  });

  test("links to Buy me a coffee from the footer, in a new tab", () => {
    const footer = /<footer[\s\S]*?<\/footer>/.exec(html())![0];
    expect(footer).toContain('<a href="https://buymeacoffee.com/genexk" target="_blank" rel="noopener noreferrer">☕ Buy me a coffee</a>');
  });

  test("uses the current stylesheet version", () => {
    expect(html()).toMatch(/href="(?:\.\.\/)?style\.css\?v=7"/);
  });

  test("holds no personal paths or addresses", () => {
    expect(html()).not.toMatch(/\/Users\/|\/home\/(?!me\b)|@(?!example\.com)[a-z0-9-]+\.(?:com|org|net)/i);
  });

  test("internal links and images resolve to files in site/", () => {
    for (const ref of internalRefs(html())) {
      expect(ref.startsWith("/"), `${ref} is root-relative; Pages serves the site under /anynotate/`).toBe(false);
      const abs = target(page, ref);
      expect(relative(SITE, abs).startsWith(".."), `${ref} leaves site/`).toBe(false);
      expect(existsSync(abs), `${ref} -> ${relative(SITE, abs)}`).toBe(true);
    }
  });
});

test("the stylesheet loads nothing from other origins", () => {
  const css = readFileSync(join(SITE, "style.css"), "utf8");
  expect(css).not.toMatch(/@import/);
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]!);
  for (const url of urls) {
    expect(url, url).not.toMatch(/^(?:[a-z]+:|\/)/i);
    expect(existsSync(join(SITE, url)), url).toBe(true);
  }
});

describe("site/guide", () => {
  const html = readFileSync(join(SITE, "guide/index.html"), "utf8");
  const dir = join(SITE, "img/guide");
  const pngSize = (file: string) => {
    const head = readFileSync(file).subarray(16, 24);
    return { width: head.readUInt32BE(0), height: head.readUInt32BE(4) };
  };

  test("every image is lazy-loaded and opens full size", () => {
    const imgs = html.match(/<img\b[^>]*>/g)!.filter((img) => img.includes("img/guide/"));
    expect(imgs.length).toBeGreaterThan(10);
    for (const img of imgs) expect(img, img).toContain('loading="lazy"');
    for (const [, href] of html.matchAll(/<a class="zoom" href="([^"]+)">/g)) expect(existsSync(join(SITE, "guide", href!)), href).toBe(true);
  });

  test("every screenshot in img/guide is used, matches its declared size, and stays small", () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".png"))) {
      expect(html, name).toContain(`../img/guide/${name}`);
      const { width, height } = pngSize(join(dir, name));
      expect(width, name).toBeLessThanOrEqual(1600);
      expect(statSync(join(dir, name)).size, name).toBeLessThan(250_000);
      const img = html.match(new RegExp(`<img src="\\.\\./img/guide/${name.replace(".", "\\.")}"[^>]*>`));
      if (img) expect(img[0], name).toContain(`width="${width}" height="${height}"`);
    }
  });

  test("has the sections the home page promises", () => {
    for (const id of ["install", "first-note", "pick", "region", "intent", "edit", "send", "agent", "inbox", "settings", "trouble"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`href="#${id}"`);
    }
  });
});

test("the home page links to the guide from the hero and the use-it steps", () => {
  const home = readFileSync(join(SITE, "index.html"), "utf8");
  expect(home).toMatch(/<a class="btn btn-ghost" href="guide\/">[\s\S]*?See how it works/);
  expect(home).toContain('<a href="guide/">Read the guide</a>');
});
