import { useRef } from "react";
import { cn } from "@/lib/utils";
import { nameMax } from "../edits";
import type { RecordWorkflow } from "./draft";

/**
 * The head of a Workflow's editor: its name, a field an admin renames it in, saved with the draft.
 * Enter keeps the name; Escape puts back the one it had when the field was entered. A Member who
 * is not an admin reads it. Hovering marks the field's edge and moves nothing.
 */
export function WorkflowName({
  workflow,
  readOnly,
  invalid,
  autoFocus,
  onRename,
  onDone,
}: {
  workflow: RecordWorkflow;
  readOnly: boolean;
  /** Save was pressed with something to fix: an empty name is marked. */
  invalid: boolean;
  autoFocus?: boolean;
  onRename: (name: string) => void;
  /** Ends a run of typing in the name. */
  onDone: () => void;
}) {
  // The name as it was when the field was entered: what Escape puts back.
  const was = useRef(workflow.name);
  const empty = !workflow.name.trim();
  return (
    <header className="flex h-12 flex-none items-center border-b px-3 max-md:px-2">
      {readOnly ? (
        <h2 className="truncate px-2 text-[15px] font-semibold">{workflow.name}</h2>
      ) : (
        <input
          autoFocus={autoFocus}
          onFocus={(e) => {
            was.current = workflow.name;
            e.currentTarget.select();
          }}
          value={workflow.name}
          maxLength={nameMax}
          placeholder="Name"
          aria-label="Name of the Workflow"
          aria-invalid={(invalid && empty) || undefined}
          onChange={(e) => onRename(e.target.value)}
          onBlur={onDone}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== "Escape") return;
            e.preventDefault();
            // The Escape stops here: it puts the name back, not the editor around it.
            e.stopPropagation();
            if (e.key === "Escape" && workflow.name !== was.current) onRename(was.current);
            e.currentTarget.blur();
          }}
          className={cn(
            "h-8 w-full max-w-[420px] min-w-0 rounded-md border border-transparent bg-transparent px-2 text-[15px] font-semibold outline-none",
            "hover:border-input focus-visible:border-foreground focus-visible:ring-[3px] focus-visible:ring-muted aria-invalid:border-destructive",
          )}
        />
      )}
    </header>
  );
}
