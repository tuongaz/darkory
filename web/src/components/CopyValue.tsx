import { toast } from "sonner";
import { shortSessionId } from "@/lib/members";
import { cn } from "@/lib/utils";

/** Puts `value` on the clipboard and says so; where the browser refuses, the toast shows it to copy by hand. */
async function copy(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`Copied the ${what}`, { description: value });
  } catch {
    toast(`Not copied: the browser refused the clipboard`, { description: value });
  }
}

/**
 * A value in mono that copies itself when clicked, the whole of it on hover: a Session id, a
 * branch. `children` is what shows (a short form, or the value truncated); `what` names it in the
 * toast and the label ("Session id").
 */
export function CopyValue({ value, what, children, className }: { value: string; what: string; children?: string; className?: string }) {
  return (
    <button
      type="button"
      title={value}
      aria-label={`Copy the ${what} ${value}`}
      onClick={(e) => {
        // In a row that opens on click, the copy is all the click does.
        e.preventDefault();
        e.stopPropagation();
        void copy(value, what);
      }}
      className={cn(
        "max-w-full min-w-0 cursor-copy truncate rounded-sm text-left font-mono text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        className,
      )}
    >
      {children ?? value}
    </button>
  );
}

/** A Session id, short, with the whole id on hover and copied on click. */
export function SessionId({ id, className }: { id: string; className?: string }) {
  return (
    <CopyValue value={id} what="Session id" className={className}>
      {shortSessionId(id)}
    </CopyValue>
  );
}
