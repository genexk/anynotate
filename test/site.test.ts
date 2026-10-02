import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SITE = resolve(import.meta.dir, "..", "site");
const PAGES = ["index.html", "privacy/index.html", "support/index.html"];

function internalRefs(html: string): string[] {
  const refs = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
  return refs.filter((r) => !/^(https?:|mailto:|#)/.test(r));
}

function target(page: string, ref: string): string {
  const path = ref.replace(/[?#].*$/, "");
  const abs = resolve(dirname(join(SITE, page)), path);
  return path === "" || path.endsWith("/") || (existsSync(abs) && statSync(abs).isDirectory()) ? join(abs, "index.html") : abs;
}

describe.each(PAGES)("site/%s", (page) => {
  const file = join(SITE, page);

  test("exists", () => {
    expect(existsSync(file)).toBe(true);
  });

  test("has a non-empty <title>", () => {
    expect(readFileSync(file, "utf8")).toMatch(/<title>[^<]*\S[^<]*<\/title>/);
  });

  test("has no placeholder text", () => {
    expect(readFileSync(file, "utf8")).not.toMatch(/TODO|lorem/i);
  });

  test("loads nothing from other origins", () => {
    expect(readFileSync(file, "utf8")).not.toMatch(/\ssrc="https?:|<link[^>]+href="https?:/);
  });

  test("internal links resolve to files in site/", () => {
    for (const ref of internalRefs(readFileSync(file, "utf8"))) {
      expect(ref.startsWith("/"), `${ref} is root-relative; Pages serves the site under /anynotate/`).toBe(false);
      const abs = target(page, ref);
      expect(relative(SITE, abs).startsWith(".."), `${ref} leaves site/`).toBe(false);
      expect(existsSync(abs), `${ref} -> ${relative(SITE, abs)}`).toBe(true);
    }
  });
});
