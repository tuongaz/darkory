import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback, type RefObject } from "react";
import type { Project, Skill } from "@/api/client";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkflowLine } from "@/components/workflowLine";
import type { RecordStep, WorkflowRecord } from "./bind";
import { DeleteStepDialog } from "./edit/DeleteStep";
import {
  addOutcome,
  addTaker,
  moveStepToWorkflow,
  renameWorkflow,
  stepsIn,
  workflowsOf,
  holdersAt,
  removeTaker,
  asksBeforeDelete,
  asLine,
  deleteStep,
  groupsOf,
  insertStep,
  makeMain,
  moveStepTo,
  removeOutcome,
  renameOutcome,
  renameStep,
  reorderStep,
  setSkill,
  setTarget,
  startMoves,
  type Draft,
  type Group,
} from "./edit/draft";
import { orgWide, useRoster } from "./edit/holders";
import type { OnLineActions } from "./edit/lineEdit";
import { OnLine } from "./edit/OnLine";
import { useOrgFacts } from "./edit/reach";
import type { DraftEditor } from "./edit/useDraft";
import { useEditorWorkflow } from "./edit/useEditorWorkflow";
import { WorkflowName } from "./edit/WorkflowName";

/**
 * One Workflow's editor, `/projects/:key/workflows/:workflow/edit` (the address names it): its name,
 * a field an admin renames it in; then the draft drawn on the line with its fields in place (vf-9),
 * and under it, where New Tasks start when the draft moves that. A Step the address names
 * (`?step=`) has its name in focus. An admin edits the draft and saves it whole; anyone else reads
 * the line. Under it, what Save would be refused, in words, or what `/v1` did refuse.
 */
export function EditingWorkflow({
  project,
  editor,
  draft,
  base,
  skills,
  focusStep,
  focusName,
  addStepRef,
}: {
  project: Project;
  /** Absent for a Member who is not an admin: read-only. */
  editor?: DraftEditor;
  draft: Draft | undefined;
  base: WorkflowRecord | undefined;
  skills: Skill[] | undefined;
  focusStep?: string;
  /** The Workflow's name takes the keys at once (a Workflow just added). */
  focusName?: boolean;
  /** Set to what the bar's "+ Step" does: a Step at the end of the line. */
  addStepRef?: RefObject<(() => void) | null>;
}) {
  const roster = useRoster(project.key);
  const facts = useOrgFacts(!!editor);
  const skillMap = useMemo(() => new Map((skills ?? []).map((s) => [s.id, s])), [skills]);
  // Who takes each Skill's Steps at Save: the draft's changes to who takes them drawn in.
  const holders = useMemo(() => holdersAt(draft, roster, new Set((skills ?? []).filter(orgWide).map((s) => s.id))), [draft, roster, skills]);
  const groups = useMemo(() => (draft ? groupsOf(draft.wf, skillMap, draft.placed) : () => "main" as const), [draft, skillMap]);
  const readOnly = !editor;
  const apply = useCallback((edit: (d: Draft) => Draft, key?: string) => editor?.apply(edit, key), [editor]);

  const shown = useEditorWorkflow(project, draft, base);
  const workflowId = shown.id;
  const order = useMemo(() => (draft ? stepsIn(draft.wf, workflowId) : []), [draft, workflowId]);

  // The field to focus once it is drawn: a new Step's name, a new outcome's, the Step asked for.
  const inputs = useRef(new Map<string, HTMLElement>());
  const [focus, setFocus] = useState<string | undefined>(focusStep);
  useEffect(() => {
    if (!focus) return;
    const el = inputs.current.get(focus);
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: "nearest" });
      setFocus(undefined);
    }
  }, [focus, draft, workflowId]);
  const inputRef = useCallback(
    (id: string): RefCallback<HTMLElement> =>
      (el) => {
        if (el) inputs.current.set(id, el);
        else inputs.current.delete(id);
      },
    [],
  );

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

  const [deleting, setDeleting] = useState<RecordStep | undefined>();

  const insert = (afterId: string | undefined, group?: Group) => {
    const after = afterId ? order.find((s) => s.id === afterId) : undefined;
    let made = "";
    apply((d) => {
      const r = insertStep(d, afterId, group ?? (after ? groups(after) : "main"), workflowId);
      made = r.id;
      return r.draft;
    });
    if (made) setFocus(made);
  };
  // The bar's "+ Step": after the last Step of the main line.
  const lastMain = order.filter((s) => groups(s) === "main").at(-1)?.id;
  useEffect(() => {
    if (!addStepRef) return;
    addStepRef.current = editor ? () => insert(lastMain, "main") : null;
  });

  if (editor?.query.isError) return <Refusal error={editor.query.error} className="m-6" />;
  if (!draft || !base || !skills) return <Skeleton aria-label="Loading the Workflow" className="m-6 h-[420px]" />;

  const workflows = workflowsOf(draft.wf);
  const workflow = workflows.find((w) => w.id === workflowId);
  const invalid = !!editor?.tried && !!editor.problem;

  const remove = (id: string) => {
    const s = order.find((x) => x.id === id);
    if (!s) return;
    if (asksBeforeDelete(draft, s.id)) setDeleting(s);
    else apply((d) => deleteStep(d, s.id, undefined, {}));
  };
  const takerSkill = (id: string) => order.find((s) => s.id === id)?.skill_id;

  const actions: OnLineActions = {
    renameStep: (id, name) => apply((d) => renameStep(d, id, name), `name:${id}`),
    settle: () => editor?.settle(),
    skill: (id, choice) => apply((d) => setSkill(d, id, choice)),
    reorder: (id, by) => apply((d) => reorderStep(d, id, by, groups)),
    moveTo: (id, onto) => apply((d) => moveStepTo(d, id, onto)),
    insertAfter: insert,
    deleteStep: remove,
    moveToWorkflow: (id, to) => {
      apply((d) => moveStepToWorkflow(d, id, to));
      // The editor follows the Step into the Workflow it joins, its name in focus.
      shown.pick(to, id);
      setFocus(id);
    },
    addTaker: (id, member, join) => {
      const skill = takerSkill(id);
      if (skill) apply((d) => addTaker(d, member, skill, join));
    },
    removeTaker: (id, member) => {
      const skill = takerSkill(id);
      if (skill) apply((d) => removeTaker(d, member, skill));
    },
    renameOutcome: (id, name) => apply((d) => renameOutcome(d, id, name), `outcome:${id}`),
    target: (id, to) => apply((d) => setTarget(d, id, to)),
    removeOutcome: (id) => apply((d) => removeOutcome(d, id)),
    addOutcome: (from) => {
      let made = "";
      apply((d) => {
        const r = addOutcome(d, from);
        made = r.id;
        return r.draft;
      });
      if (made) setFocus(made);
    },
    main: (id) => apply((d) => makeMain(d, id)),
  };

  const start = editor && editor.changes > 0 ? startMoves(base, draft.wf, skillMap) : undefined;
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
      {workflow && (
        <WorkflowName
          workflow={workflow}
          readOnly={readOnly}
          invalid={invalid}
          autoFocus={focusName}
          onRename={(name) => apply((d) => renameWorkflow(d, workflow.id, name), `workflow:${workflow.id}`)}
          onDone={() => editor?.settle()}
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto px-5 pt-3 pb-24 max-md:px-4">
        {readOnly ? (
          <WorkflowLine label="The line" workflow={asLine(draft.wf, skillMap, workflows.length > 1 ? workflowId : undefined)} tasks={[]} now={0} />
        ) : (
          <OnLine
            project={project}
            draft={draft}
            base={base}
            skills={skills}
            workflowId={workflowId}
            groups={groups}
            holders={holders}
            roster={roster}
            facts={facts}
            invalid={invalid}
            actions={actions}
            inputRef={inputRef}
            note={
              start && (
                <p role="note" aria-label="Where New Tasks start" className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                  {start}
                </p>
              )
            }
          />
        )}
      </div>
      {deleting && editor && (
        <DeleteStepDialog
          draft={draft}
          step={deleting}
          skills={skillMap}
          onClose={() => setDeleting(undefined)}
          onDelete={(moveTo, repoint) => {
            apply((d) => deleteStep(d, deleting.id, moveTo, repoint));
            setDeleting(undefined);
          }}
        />
      )}
      {said && <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3 [&>*]:pointer-events-auto">{said}</div>}
    </div>
  );
}
