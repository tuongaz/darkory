import type { Element, Root, RootContent } from "hast";
import { SquareCheckIcon, SquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Text a person or an agent wrote (a Task's description, a Note, an Observation), as Markdown.
 *
 * - What renders: paragraphs, lists, task lists (each item's box ticked or not), code spans and
 *   fenced blocks, emphasis, strong, strikethrough and links. A heading renders as a paragraph in
 *   semibold; an image renders as its alt text; a table or a quote renders as its text; a
 *   footnote renders as its text in a list at the end. Raw HTML is dropped: a block of it whole,
 *   an inline tag alone (the text between `<b>` and `</b>` stays, as plain text).
 * - A link renders only for an absolute `http://` or `https://` address, written out in full
 *   (`new URL(…).href`), and opens in a new tab with no referrer. Any other address
 *   (`javascript:`, `mailto:`, `http:foo`, a relative path) renders as its text.
 * - A newline is a line break and a blank line starts a paragraph, as GitHub comments and the
 *   composer's textarea have them (remark-breaks): "a\nb" is one paragraph with a <br>, "a\n\nb"
 *   is two paragraphs.
 * - No element carries an `id`, so two Notes on one page never repeat one.
 *
 * Nothing loads or injects a style at run time: the look is `prose-dk` in globals.css.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose-dk", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        remarkRehypeOptions={footnotes}
        rehypePlugins={[tidy]}
        skipHtml
        allowedElements={allowed}
        unwrapDisallowed
        urlTransform={webOnly}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// A footnote's way back to its reference is an empty link (so it renders as nothing): an empty
// string would not do, as mdast-util-to-hast takes it for unset and writes "↩".
const footnotes = { footnoteBackContent: () => [], footnoteLabel: "Footnotes" };

// h1–h6 and img are allowed only to be rendered by `components` (as a paragraph, as alt text):
// unwrapDisallowed would leave a heading's text bare and drop an image's alt.
const allowed = ["p", "ul", "ol", "li", "code", "pre", "em", "strong", "a", "br", "del", "h1", "h2", "h3", "h4", "h5", "h6", "img"];

const webOnly: UrlTransform = (url) => {
  const address = url.trim();
  if (!/^https?:\/\//i.test(address)) return null;
  try {
    return new URL(address).href;
  } catch {
    return null;
  }
};

/**
 * Before the elements are filtered: takes every `id` off (GFM's footnotes set them), and turns a
 * task list item's checkbox, which is not an allowed element, into `data-task` on its item
 * ("done" or "open"), dropping the space after the box.
 */
function tidy() {
  return (tree: Root) => walk(tree.children);
}

function walk(nodes: RootContent[]) {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    delete node.properties.id;
    if (node.tagName === "li" && classes(node).includes("task-list-item")) markTask(node);
    walk(node.children);
  }
}

function markTask(li: Element) {
  // A tight list's item holds the box itself; a loose list's holds it in its first paragraph.
  const first = li.children.find((c) => c.type === "element");
  const holder = first?.tagName === "p" ? first : li;
  const at = holder.children.findIndex((c) => c.type === "element" && c.tagName === "input" && c.properties.type === "checkbox");
  if (at < 0) return;
  const box = holder.children[at] as Element;
  li.properties.dataTask = box.properties.checked ? "done" : "open";
  holder.children.splice(at, 1);
  const next = holder.children[at];
  if (next?.type === "text") next.value = next.value.replace(/^\s+/, "");
}

const classes = (el: Element) => {
  const c = el.properties.className;
  return Array.isArray(c) ? c.map(String) : [];
};

const Heading = ({ children }: { children?: ReactNode }) => <p className="font-semibold">{children}</p>;

const components: Components = {
  h1: Heading,
  h2: Heading,
  h3: Heading,
  h4: Heading,
  h5: Heading,
  h6: Heading,
  img: ({ alt }) => <>{alt ?? ""}</>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  ul: ({ children }) => <ul>{children}</ul>,
  ol: ({ children, start }) => <ol start={start}>{children}</ol>,
  li: ({ node, children }) => {
    const task = node?.properties.dataTask;
    if (task !== "done" && task !== "open") return <li>{children}</li>;
    const Box = task === "done" ? SquareCheckIcon : SquareIcon;
    return (
      <li data-task={task}>
        <Box role="img" aria-label={task === "done" ? "Checked" : "Unchecked"} className="task-box" />
        {children}
      </li>
    );
  },
};
