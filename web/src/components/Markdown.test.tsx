import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const md = (text: string) => render(<Markdown text={text} />).container.firstElementChild as HTMLElement;

describe("Markdown", () => {
  it("renders a code span as code", () => {
    const el = md("Run `make check` first");
    expect(el.querySelector("p > code")).toHaveTextContent("make check");
    expect(el).toHaveClass("prose-dk");
  });

  it("renders a fenced block as pre > code, kept verbatim", () => {
    const el = md("```go\nfunc main() {\n\t<b>x</b>\n}\n```");
    const code = el.querySelector("pre > code");
    expect(code?.textContent).toBe("func main() {\n\t<b>x</b>\n}\n");
    expect(el.querySelector("b")).toBeNull();
  });

  it("renders a bulleted and a numbered list", () => {
    const el = md("- one\n- two\n\n1. first\n2. second");
    expect([...el.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    expect([...el.querySelectorAll("ol > li")].map((li) => li.textContent)).toEqual(["first", "second"]);
  });

  it("opens an https link in a new tab with no referrer", () => {
    const a = md("See [the PR](https://github.com/o/r/pull/7)").querySelector("a");
    expect(a).toHaveAttribute("href", "https://github.com/o/r/pull/7");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders a bare https address as a link (GFM autolink)", () => {
    expect(md("at https://example.com/x today").querySelector("a")).toHaveAttribute("href", "https://example.com/x");
  });

  it("renders a javascript: link as its text, with no anchor", () => {
    const el = md("[click](javascript:alert(1)) and [Mail](mailto:a@b.c) and [rel](/v1/tasks)");
    expect(el.querySelector("a")).toBeNull();
    expect(el).toHaveTextContent("click and Mail and rel");
    expect(el.innerHTML).not.toContain("javascript");
  });

  it("renders an image as its alt text, with no img", () => {
    const el = md("Before ![the screenshot](https://example.com/s.png) after");
    expect(el.querySelector("img")).toBeNull();
    expect(el).toHaveTextContent("Before the screenshot after");
  });

  it("drops raw HTML tags, keeping the text between inline ones as plain text", () => {
    const el = md('Hi <script>alert(1)</script><b onclick="x()">bold</b>\n\n<div>block</div>\n\n<script>\nsteal()\n</script>\n\nafter');
    expect(el.querySelector("script, b, div")).toBeNull();
    expect(el.innerHTML).not.toMatch(/onclick|<script|steal/);
    expect([...el.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Hi alert(1)bold", "after"]);
  });

  it("renders a heading as a paragraph", () => {
    const el = md("# Plan\n## Steps\nDo it");
    expect(el.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
    expect([...el.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Plan", "Steps", "Do it"]);
  });

  it("renders a table as its text, with no table", () => {
    const el = md("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(el.querySelector("table, tr, td")).toBeNull();
    expect(el).toHaveTextContent("a b 1 2");
  });

  it("keeps a newline as a line break and a blank line as a new paragraph", () => {
    const el = md("Ran the tests.\nAll pass.\n\nNext: the PR.");
    const ps = el.querySelectorAll("p");
    expect(ps).toHaveLength(2);
    expect(ps[0].querySelector("br")).not.toBeNull();
    expect(ps[0].textContent).toBe("Ran the tests.\nAll pass.");
    expect(ps[1]).toHaveTextContent("Next: the PR.");
  });

  it("renders emphasis, strong and strikethrough", () => {
    const el = md("*a* **b** ~~c~~");
    expect(el.querySelector("em")).toHaveTextContent("a");
    expect(el.querySelector("strong")).toHaveTextContent("b");
    expect(el.querySelector("del")).toHaveTextContent("c");
  });

  // The Install's CSP is style-src 'self' (csp.test.tsx): nothing here may add a <style> or a style attribute.
  it("adds no style at run time", () => {
    const el = md("# H\n\n- `a`\n\n```\nb\n```\n\n[l](https://x.y) ![i](https://x.y/i.png) | t |\n| - |\n| 1 |");
    expect(document.querySelectorAll("style")).toHaveLength(0);
    expect(el.querySelectorAll("[style]")).toHaveLength(0);
  });
});
