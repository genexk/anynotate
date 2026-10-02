import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SITE = resolve(import.meta.dir, "..", "site");
const PAGES = ["index.html", "privacy/index.html", "support/index.html"];
const ALLOWED_HOSTS = new Set(["github.com", "genexk.github.io"]);

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

  test("links only to github.com and genexk.github.io", () => {
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
  expect(readFileSync(join(SITE, "style.css"), "utf8")).not.toMatch(/url\(|@import/);
});
