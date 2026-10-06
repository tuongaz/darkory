import { CheckIcon, XIcon } from "lucide-react";
import type { Glyph } from "@/lib/status";
import { cn } from "@/lib/utils";

export type { Glyph };


const names: Record<Glyph, string> = {
  backlog: "Backlog",
  todo: "Todo",
  inprogress: "In progress",
  inreview: "In review",
  done: "Done",
  dropped: "Dropped",
};

const shapes: Record<Glyph, string> = {
  backlog: "rounded-full border-[1.5px] border-dashed border-muted-foreground",
  todo: "rounded-full border-[1.5px] border-muted-foreground",
  inprogress:
    "rounded-full border-[1.5px] border-state-claimed shadow-[inset_0_0_0_2px_var(--background)] bg-[conic-gradient(var(--state-claimed)_0_50%,transparent_50%_100%)]",
  inreview:
    "rounded-full border-[1.5px] border-state-waiting shadow-[inset_0_0_0_2px_var(--background)] bg-[conic-gradient(var(--state-waiting)_0_75%,transparent_75%_100%)]",
  done: "rounded-full bg-state-done text-on-solid",
  dropped: "rounded-full bg-muted-foreground text-on-solid",
};

/** A Status as Linear draws it: a 14px circle per kind. `label` names it for screen readers (default: the glyph's own name). */
export function StatusGlyph({ glyph, label, className }: { glyph: Glyph; label?: string; className?: string }) {
  return (
    <span
      role="img"
      aria-label={label ?? names[glyph]}
      data-glyph={glyph}
      className={cn("inline-grid size-3.5 flex-none place-items-center", shapes[glyph], className)}
    >
      {glyph === "done" && <CheckIcon className="size-[9px] text-on-solid" strokeWidth={3} />}
      {glyph === "dropped" && <XIcon className="size-[9px] text-on-solid" strokeWidth={3} />}
    </span>
  );
}
