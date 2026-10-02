import { expect, test } from "bun:test";
import { ansiToHtml } from "../scripts/ansi-html";
import { renderInbox, withSize, initialState } from "../src/agent/inbox-view";

test("SGR bold, dim and colours become classed spans, and reset ends them", () => {
  expect(ansiToHtml("\x1b[1mtitle\x1b[0m plain \x1b[2mdim\x1b[0m \x1b[33mqueued\x1b[0m")).toBe(
    '<span class="b">title</span> plain <span class="d">dim</span> <span class="fg-yellow">queued</span>',
  );
});

test("text is escaped and styles combine until reset", () => {
  expect(ansiToHtml("\x1b[1m<a & \"b\">\x1b[36mx\x1b[0m>")).toBe('<span class="b">&lt;a &amp; &quot;b&quot;&gt;</span><span class="b fg-cyan">x</span>&gt;');
});

test("a rendered inbox converts with no escape codes left", () => {
  const lines = renderInbox(withSize(initialState([]), 60, 6), { now: 0, color: true }).map(ansiToHtml);
  expect(lines.join("\n")).not.toContain("\x1b");
  expect(lines[0]).toContain('<span class="b">Anynotate inbox');
});
