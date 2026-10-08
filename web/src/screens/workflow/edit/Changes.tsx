import { ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";
import { Pill, type PillTone } from "@/components/Pill";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { lineTopology } from "@/components/workflowLine";
import { asLine, type Change } from "./draft";
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
};

/**
 * The header's "Editing · N changes": with changes, a button that lists them — each with what it
 * changed — and what moves because of them (where New Tasks start). ⌘Z undoes the last.
 */
export function ChangesChip({ editor }: { editor: DraftEditor }) {
  const n = editor.changes;
  const skills = useMemo(() => new Map((editor.skills ?? []).map((s) => [s.id, s])), [editor.skills]);
  const start = useMemo(() => {
    if (!editor.base || !editor.draft || n === 0) return undefined;
    const was = lineTopology(asLine(editor.base, skills)).start;
    const is = lineTopology(asLine(editor.draft.wf, skills)).start;
    return was === is ? undefined : (editor.draft.wf.steps.find((s) => s.id === is)?.name.trim() ?? null);
  }, [editor.base, editor.draft, skills, n]);
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
          <button type="button" aria-label={`Editing · ${n} ${n === 1 ? "change" : "changes"}: list them`} className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <Pill tone="claimed" className="gap-1 font-normal">
              <span className="max-sm:sr-only">Editing · </span>
              {n} {n === 1 ? "change" : "changes"}
              <ChevronDownIcon aria-hidden className="size-3" />
            </Pill>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[400px] max-w-[calc(100vw-32px)] p-3.5">
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
            {start !== undefined && (start ? `New Tasks will start at ${start}. ` : "No Step is left where New Tasks start. ")}Undo: ⌘Z
          </p>
        </PopoverContent>
      </Popover>
    </span>
  );
}
