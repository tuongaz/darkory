import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Text a person or an agent wrote (a Task's description, a Note, an Observation), as Markdown.
 *
 * - What renders: paragraphs, lists, code spans and fenced blocks, emphasis, strong,
 *   strikethrough and links. A heading renders as a paragraph; an image renders as its alt text;
 *   a table or a quote renders as its text. Raw HTML is dropped: a block of it whole, an inline
 *   tag alone (the text between `<b>` and `</b>` stays, as plain text).
 * - A link renders only for an `http:` or `https:` address, and opens in a new tab with no
 *   referrer. Any other address (`javascript:`, `mailto:`, a relative path) renders as its text.
 * - A newline is a line break and a blank line starts a paragraph, as the composer's textarea
 *   wrote them (remark-breaks); two trailing spaces before a newline are a break too.
 *
 * Nothing loads or injects a style at run time: the look is `prose-dk` in globals.css.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose-dk", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
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

// h1–h6 and img are allowed only to be rendered by `components` (as a paragraph, as alt text):
// unwrapDisallowed would leave a heading's text bare and drop an image's alt.
const allowed = ["p", "ul", "ol", "li", "code", "pre", "em", "strong", "a", "br", "del", "h1", "h2", "h3", "h4", "h5", "h6", "img"];

const webOnly: UrlTransform = (url) => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

const components: Components = {
  h1: "p",
  h2: "p",
  h3: "p",
  h4: "p",
  h5: "p",
  h6: "p",
  img: ({ alt }) => <>{alt ?? ""}</>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};
