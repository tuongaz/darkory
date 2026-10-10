import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { PaperclipIcon } from "lucide-react";
import { evidenceURL, type Evidence } from "@/api/client";
import { sizeText } from "./format";

const images = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** How tall a text box grows before its lines fade out. */
const boxHeight = 112;
/** A text file at most this size shows its first lines; a bigger one is a plain row. */
const textLimit = 20_000;

const mediaType = (e: Evidence) => e.content_type.split(";")[0].trim().toLowerCase();
const isImage = (e: Evidence) => images.has(mediaType(e));
const isShortText = (e: Evidence) => {
  const t = mediaType(e);
  return (t.startsWith("text/") || t === "application/json") && e.size < textLimit;
};

/**
 * What a row of Evidence shows under its words: each small text file as a box of its first lines,
 * the images as thumbnails, then the rest by name and size. `plain` lists the files that are
 * neither; a single Evidence's row names its file already, so it passes none.
 */
export function EvidenceFiles({ files, plain = true }: { files: readonly Evidence[]; plain?: boolean }) {
  const texts = files.filter(isShortText);
  const pictures = files.filter(isImage);
  const rest = plain ? files.filter((f) => !isShortText(f) && !isImage(f)) : [];
  if (texts.length + pictures.length + rest.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {texts.map((f) => (
        <TextBox key={f.id} file={f} plain={plain} />
      ))}
      {pictures.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pictures.map((f) => (
            <Thumbnail key={f.id} file={f} />
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <ul className="flex flex-col gap-1">
          {rest.map((f) => (
            <li key={f.id}>
              <FileLink file={f} open />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * "📎 trace.zip 900 kB": the file's name, a download, and its size; with `open`, an "open ↗" after
 * them, as a text box's caption has, for a file listed under a folded row.
 */
export function FileLink({ file, open }: { file: Evidence; open?: boolean }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
      <a href={evidenceURL(file.id)} download={file.filename} className="inline-flex min-w-0 items-center gap-1 hover:underline">
        <PaperclipIcon className="size-3 flex-none text-muted-foreground" aria-hidden />
        <span className="truncate">{file.filename}</span>
      </a>
      <span className="whitespace-nowrap text-muted-foreground">{sizeText(file.size)}</span>
      {open && (
        <a href={evidenceURL(file.id)} target="_blank" rel="noreferrer noopener" className="whitespace-nowrap text-muted-foreground hover:text-foreground">
          open ↗
        </a>
      )}
    </span>
  );
}

/** An image as a 148×92 thumbnail from its top, loaded when scrolled to, its name and size under it; the whole opens the file. */
function Thumbnail({ file }: { file: Evidence }) {
  return (
    <a href={evidenceURL(file.id)} target="_blank" rel="noreferrer noopener" title={file.filename} className="flex w-[148px] flex-col gap-1 text-xs">
      <img
        src={evidenceURL(file.id)}
        alt={file.filename}
        loading="lazy"
        className="h-[92px] w-[148px] rounded-md border bg-muted object-cover object-top"
      />
      <span className="truncate text-foreground">{file.filename}</span>
      <span className="text-muted-foreground">{sizeText(file.size)}</span>
    </a>
  );
}

/**
 * A small text file: its name, size and open on one line, then its first lines in a box that fades
 * out at 112px. While it loads the box is one short empty line; a file it cannot read is a plain
 * row in a folded row (`plain`), nothing under a row that names it already; it is asked for once.
 */
function TextBox({ file, plain }: { file: Evidence; plain: boolean }) {
  const text = useQuery({
    queryKey: ["evidence-text", file.id],
    queryFn: async () => {
      const res = await globalThis.fetch(new Request(new URL(evidenceURL(file.id), window.location.origin), { credentials: "include" }));
      if (!res.ok) throw new Error(`${res.status}`);
      return res.text();
    },
    // Evidence never changes once attached; a refusal will not change on asking again.
    staleTime: Infinity,
    retry: false,
  });
  // The fade says there is more: drawn only when the lines run past the box.
  const pre = useRef<HTMLPreElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    if (pre.current) setOverflows(pre.current.scrollHeight > boxHeight);
  }, [text.data]);
  // A single Evidence's row names its file already.
  if (text.isError) return plain ? <FileLink file={file} open /> : null;
  return (
    <figure aria-label={file.filename} className="flex min-w-0 flex-col overflow-hidden rounded-md border bg-card text-xs">
      <figcaption className="flex min-w-0 items-center gap-1.5 border-b px-2.5 py-1.5">
        <PaperclipIcon className="size-3 flex-none text-muted-foreground" aria-hidden />
        <span className="truncate text-foreground">{file.filename}</span>
        <span className="whitespace-nowrap text-muted-foreground">{sizeText(file.size)}</span>
        <a href={evidenceURL(file.id)} target="_blank" rel="noreferrer noopener" className="ml-auto whitespace-nowrap text-muted-foreground hover:text-foreground">
          open ↗
        </a>
      </figcaption>
      {text.isPending ? (
        <div aria-busy="true" className="h-7" />
      ) : (
        <div className="relative max-h-[112px] overflow-hidden">
          <pre ref={pre} className="px-2.5 py-2 font-mono text-[11.5px] leading-[1.45] whitespace-pre text-foreground">
            {text.data}
          </pre>
          {overflows && <span aria-hidden data-fade className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-transparent to-card" />}
        </div>
      )}
    </figure>
  );
}
