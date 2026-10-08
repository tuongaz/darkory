import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** How long the icon shows a check after a copy. */
export const copiedFor = 1500;

/**
 * A value with a copy button at its end: `children` show it (the value itself when absent), and
 * on hover, or when the button has the keyboard's focus, a copy icon appears after it in space
 * kept for it, so nothing moves. A click puts `value` on the clipboard and turns the icon into a
 * check for a moment; where the browser refuses, a toast shows the value to copy by hand. `label`
 * names the value for the button: "Copy Session id". It works inline and in a table cell, where
 * the value wraps rather than pushing the icon out; in a row that opens on click, the copy is all
 * the click does. A row marked `group/copy` shows the icon while the pointer is anywhere on it.
 */
export function Copy({ value, label, children, className }: { value: string; label: string; children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast(`Not copied: the browser refused the clipboard`, { description: value });
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), copiedFor);
  }

  return (
    <span className={cn("group/copy relative inline-block max-w-full min-w-0 pr-6 align-middle", className)}>
      {children ?? value}
      <button
        type="button"
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        title={copied ? "Copied" : `Copy ${label}`}
        data-copied={copied || undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void copy();
        }}
        className={cn(
          "absolute top-1/2 right-0 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity",
          "group-hover/copy:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          "data-[copied]:text-foreground data-[copied]:opacity-100 [&_svg]:size-3.5",
        )}
      >
        {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      </button>
    </span>
  );
}
