import { ChevronDownIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Project, Skill } from "@/api/client";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { WorkflowRecord } from "./bind";
import { groupsOf, type Draft } from "./edit/draft";
import { useSkillHolders } from "./edit/holders";
import { Preview } from "./edit/Preview";
import { StepList } from "./edit/StepList";
import type { DraftEditor } from "./edit/useDraft";

/**
 * Settings › a Project › Workflow: the Workflow as a plain ordered list, with a preview of its line
 * above (behind a toggle on a phone). An admin edits it and saves it whole; anyone else reads it.
 * Under the list, what Save would be refused, in words, or what `/v1` did refuse.
 */
export function EditingWorkflow({
  project,
  editor,
  draft,
  base,
  skills,
  focusStep,
}: {
  project: Project;
  /** Absent for a Member who is not an admin: the list read-only. */
  editor?: DraftEditor;
  draft: Draft | undefined;
  base: WorkflowRecord | undefined;
  skills: Skill[] | undefined;
  focusStep?: string;
}) {
  const phone = useIsMobile();
  const [showLine, setShowLine] = useState(false);
  const holders = useSkillHolders(project.key, skills);
  const skillMap = useMemo(() => new Map((skills ?? []).map((s) => [s.id, s])), [skills]);
  const groups = useMemo(() => (draft ? groupsOf(draft.wf, skillMap) : () => "main" as const), [draft, skillMap]);

  // Leaving the page with changes unsaved asks first.
  const unsaved = !!editor && editor.changes > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // Undo, outside a field (a field undoes its own typing): ⌘Z or Ctrl+Z.
  useEffect(() => {
    if (!editor) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      editor.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

  if (editor?.query.isError) return <Refusal error={editor.query.error} className="m-6" />;
  if (!draft || !base || !skills) return <Skeleton aria-label="Loading the Workflow" className="m-6 h-[420px]" />;

  const said = editor && ((editor.tried && editor.problem) || !!editor.refused) && (
    <div className="rounded-md border border-danger-border bg-background px-3 py-2 shadow-soft">
      {editor.refused ? (
        <Refusal error={editor.refused} />
      ) : (
        <p role="alert" className="text-xs text-destructive">
          {editor.problem}
        </p>
      )}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <section aria-label="Preview" className="flex-none border-b bg-sidebar">
        <div className="flex items-center gap-2 px-5 pt-2.5 text-xs text-muted-foreground max-md:px-4 max-md:py-2.5">
          {phone ? (
            <button
              type="button"
              aria-expanded={showLine}
              onClick={() => setShowLine((v) => !v)}
              className="flex items-center gap-1 rounded-sm font-semibold text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {showLine ? "Hide the line" : "Show the line"}
              <ChevronDownIcon aria-hidden className={cn("size-3.5 transition-transform", showLine && "rotate-180")} />
            </button>
          ) : (
            <span className="font-semibold text-foreground">Preview</span>
          )}
        </div>
        {(!phone || showLine) && <Preview draft={draft.wf} base={base} skills={skillMap} groups={groups} className="mx-auto max-w-[1240px] px-2" />}
      </section>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[1020px] pt-3 pb-24 md:px-4">
          <StepList project={project} holders={holders} editor={editor} draft={draft} base={base} skills={skills} groups={groups} readOnly={!editor} focusStep={focusStep} />
        </div>
      </div>
      {said && <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3 [&>*]:pointer-events-auto">{said}</div>}
    </div>
  );
}
