import { ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";
import { Pill, type PillTone } from "@/components/Pill";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { startMoves, type Change } from "./draft";
import type { DraftEditor } from "./useDraft";

const tone: Record<Change["kind"], PillTone> = {
  Added: "done",
  Deleted: "blocked",
  Removed: "blocked",
  Renamed: "secondary",
  Skill: "secondary",
  Moved: "secondary",
  "Re-pointed": "claimed",
  Main: "claimed",
  "Workflow added": "done",
  "Workflow renamed": "secondary",
  "Workflow deleted": "blocked",
  "Workflows reordered": "secondary",
};

/**
 * The bar's "N changes ⌄" (vf-9), in the waiting blue: a button that lists the changes — each with
 * what it changed — and what moves because of them (where New Tasks start). ⌘Z undoes the last.
 * With none, "Editing".
 */
export function ChangesChip({ editor }: { editor: DraftEditor }) {
  const n = editor.changes;
  const skills = useMemo(() => new Map((editor.skills ?? []).map((s) => [s.id, s])), [editor.skills]);
  const start = useMemo(() => (editor.base && editor.draft && n > 0 ? startMoves(editor.base, editor.draft.wf, skills) : undefined), [editor.base, editor.draft, skills, n]);
  if (n === 0)
    return (
      <span role="status" aria-label="Editing">
        <Pill tone="outline" className="font-normal">
          Editing
        </Pill>
      </span>
    );
  return (
    <span role="status" aria-label="Editing">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${n} ${n === 1 ? "change" : "changes"}: list them`}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-state-waiting bg-background px-2.5 text-xs font-medium whitespace-nowrap text-state-waiting outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:bg-accent"
          >
            {n} {n === 1 ? "change" : "changes"}
            <ChevronDownIcon aria-hidden className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[400px] max-w-[calc(100vw-32px)] p-3.5">
          <h2 className="mb-2 text-[13px] font-semibold">
            {n} {n === 1 ? "change" : "changes"}, not saved
          </h2>
          <ul aria-label="Changes" className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-1.5 text-[13px]">
            {editor.changeList.map((c, i) => (
              <li key={i} className="contents">
                <Pill tone={tone[c.kind]} className="justify-self-start font-normal">
                  {c.kind}
                </Pill>
                <span className="min-w-0 break-words">{c.text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 border-t pt-2 text-xs text-muted-foreground">
            {start && `${start}. `}Undo: ⌘Z
          </p>
        </PopoverContent>
      </Popover>
    </span>
  );
}
