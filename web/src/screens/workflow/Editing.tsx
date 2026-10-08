import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback } from "react";
import { useSearchParams } from "react-router";
import type { Project, Skill } from "@/api/client";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { lineTopology } from "@/components/workflowLine";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { RecordStep, WorkflowRecord } from "./bind";
import { DeleteStepDialog } from "./edit/DeleteStep";
import {
  addOutcome,
  addTaker,
  holdersAt,
  removeTaker,
  asksBeforeDelete,
  asLine,
  deleteStep,
  groupsOf,
  inOrder,
  insertStep,
  makeMain,
  moveStepTo,
  removeOutcome,
  renameOutcome,
  renameStep,
  reorderStep,
  setSkill,
  setTarget,
  type Draft,
  type Group,
} from "./edit/draft";
import { orgWide, useRoster } from "./edit/holders";
import { Preview } from "./edit/Preview";
import { useOrgFacts } from "./edit/reach";
import { StepList, type RowTags } from "./edit/StepList";
import { StepPanel, type PanelActions } from "./edit/StepPanel";
import type { DraftEditor } from "./edit/useDraft";
import { stepParam } from "./StepPeek";
import { toShort } from "@/lib/shortid";

/**
 * Settings › a Project › Workflow: the line on top (behind a toggle on a phone), then the Steps as
 * a text list beside the picked Step's panel. None is picked until the address names one or a
 * Step is picked — in the list, with ↑/↓, or on the line — which opens it in the panel and puts
 * it in the address (`?step=`); on a phone the panel takes the list's place. Deleting the picked
 * Step picks its neighbour in its part of the list. An admin edits the draft and saves it whole; anyone else reads it. Under it,
 * what Save would be refused, in words, or what `/v1` did refuse.
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
  /** Absent for a Member who is not an admin: read-only. */
  editor?: DraftEditor;
  draft: Draft | undefined;
  base: WorkflowRecord | undefined;
  skills: Skill[] | undefined;
  focusStep?: string;
}) {
  const phone = useIsMobile();
  const [showLine, setShowLine] = useState(false);
  const roster = useRoster(project.key);
  const facts = useOrgFacts(!!editor);
  const skillMap = useMemo(() => new Map((skills ?? []).map((s) => [s.id, s])), [skills]);
  // Who takes each Skill's Steps at Save: the draft's changes to who takes them drawn in.
  const holders = holdersAt(draft, roster, new Set((skills ?? []).filter(orgWide).map((s) => s.id)));
  const groups = useMemo(() => (draft ? groupsOf(draft.wf, skillMap, draft.placed) : () => "main" as const), [draft, skillMap]);
  const readOnly = !editor;
  const apply = useCallback((edit: (d: Draft) => Draft, key?: string) => editor?.apply(edit, key), [editor]);

  // The picked Step: the one the address names, else none until one is picked.
  const [params, setParams] = useSearchParams();
  // A Step id from an old link may be a UUID's long text: the API writes it short (ADR 0017).
  const fromAddress = params.get(stepParam);
  const asked = (fromAddress && toShort(fromAddress)) ?? focusStep;
  const [opened, setOpened] = useState(!!focusStep);
  const topology = useMemo(() => (draft ? lineTopology(asLine(draft.wf, skillMap)) : undefined), [draft, skillMap]);
  const order = useMemo(() => (draft ? inOrder(draft.wf.steps) : []), [draft]);
  const picked = order.find((s) => s.id === asked)?.id;
  const pick = useCallback(
    (id: string) => {
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.set(stepParam, id);
          return next;
        },
        { replace: true },
      );
      setOpened(true);
    },
    [setParams],
  );

  // The field to focus once it is drawn: a new Step's name, a new outcome's, the Step asked for.
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [focus, setFocus] = useState<string | undefined>(focusStep);
  useEffect(() => {
    if (!focus) return;
    const el = inputs.current.get(focus);
    if (el) {
      el.focus();
      el.scrollIntoView?.({ block: "nearest" });
      setFocus(undefined);
    }
  }, [focus, draft, picked]);
  const nameRef =
    (id: string): RefCallback<HTMLInputElement> =>
    (el) => {
      if (el) inputs.current.set(id, el);
      else inputs.current.delete(id);
    };

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

  if (editor?.query.isError) return <Refusal error={editor.query.error} className="m-6" />;
  if (!draft || !base || !skills) return <Skeleton aria-label="Loading the Workflow" className="m-6 h-[420px]" />;

  const main = order.filter((s) => groups(s) === "main");
  const after = order.filter((s) => groups(s) === "after");
  const numbered = [...main, ...after];
  const step = order.find((s) => s.id === picked);
  const n = step ? numbered.findIndex((s) => s.id === step.id) + 1 : 0;
  const nameOf = (id: string | undefined) => (id ? order.find((s) => s.id === id)?.name.trim() || "New Step" : undefined);

  const insert = (afterId: string | undefined, group: Group) => {
    let made = "";
    apply((d) => {
      const r = insertStep(d, afterId, group);
      made = r.id;
      return r.draft;
    });
    if (made) {
      pick(made);
      setFocus(made);
    }
  };
  const remove = (s: RecordStep) => {
    if (asksBeforeDelete(draft, s.id)) setDeleting(s);
    else removeNow(s, undefined, {});
  };
  const removeNow = (s: RecordStep, moveTo: string | undefined, repoint: Parameters<typeof deleteStep>[3]) => {
    // The panel moves to its neighbour in its own part of the list: the Step below it, else the
    // one above; a Step on the line never hands the panel to one "After a Parent", or back.
    const own = groups(s) === "main" ? main : after;
    const at = own.findIndex((x) => x.id === s.id);
    const next = own[at + 1] ?? own[at - 1];
    apply((d) => deleteStep(d, s.id, moveTo, repoint));
    if (next) pick(next.id);
  };
  const reorder = (id: string, by: -1 | 1) => apply((d) => reorderStep(d, id, by, groups));

  const tags = (s: RecordStep): RowTags => ({
    start: topology?.start === s.id ? s.id : undefined,
    breakdown: topology?.before === s.id ? { start: nameOf(topology.start) } : undefined,
    orgWide: !!s.skill_id && skillMap.get(s.skill_id)?.builtin === true && skillMap.get(s.skill_id)?.name === "skill-review",
  });

  const actions: PanelActions | undefined = step && {
    rename: (id, name) => apply((d) => renameOutcome(d, id, name), `outcome:${id}`),
    settle: () => editor?.settle(),
    target: (id, to) => apply((d) => setTarget(d, id, to)),
    remove: (id) => apply((d) => removeOutcome(d, id)),
    add: (from) => {
      let made = "";
      apply((d) => {
        const r = addOutcome(d, from);
        made = r.id;
        return r.draft;
      });
      if (made) setFocus(made);
    },
    main: (id) => apply((d) => makeMain(d, id)),
    renameStep: (name) => apply((d) => renameStep(d, step.id, name), `name:${step.id}`),
    settleName: () => editor?.settle(),
    skill: (choice) => apply((d) => setSkill(d, step.id, choice)),
    reorder: (by) => reorder(step.id, by),
    insertAfter: () => insert(step.id, groups(step)),
    deleteStep: () => remove(step),
    addTaker: (member, join) => step.skill_id && apply((d) => addTaker(d, member, step.skill_id!, join)),
    removeTaker: (member) => step.skill_id && apply((d) => removeTaker(d, member, step.skill_id!)),
  };
  const group = step ? (groups(step) === "main" ? main : after) : [];
  const canMove = { up: !!step && group[0]?.id !== step.id, down: !!step && group.at(-1)?.id !== step.id };
  const invalid = !!editor?.tried && !!editor.problem;
  const panelShown = !phone || opened;
  const listShown = !phone || !opened;

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
        {(!phone || showLine) && <Preview draft={draft.wf} base={base} skills={skillMap} groups={groups} onStep={pick} className="mx-auto max-w-[1240px] px-2" />}
      </section>
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_560px]">
        {listShown && (
          <div className="min-h-0 overflow-auto px-3 pt-3 pb-24 max-md:px-0 max-md:pt-0">
            <StepList
              draft={draft}
              base={base}
              skills={skills}
              holders={holders}
              groups={groups}
              readOnly={readOnly}
              picked={phone ? undefined : picked}
              onPick={pick}
              onInsert={insert}
              onReorder={reorder}
              onMove={(id, onto) => apply((d) => moveStepTo(d, id, onto))}
              tags={tags}
            />
          </div>
        )}
        {!phone && !step && (
          <div className="min-h-0 overflow-auto border-l pb-24">
            <div role="note" aria-label="No Step picked" className="px-6 pt-8 text-sm text-muted-foreground">
              Pick a Step
            </div>
          </div>
        )}
        {panelShown && step && actions && (
          <div className="min-h-0 overflow-auto border-l pb-24 max-md:border-l-0">
            <StepPanel
              key={step.id}
              project={project}
              step={step}
              n={n}
              draft={draft}
              base={base}
              order={order}
              skills={skills}
              holders={holders}
              roster={roster}
              facts={facts}
              readOnly={readOnly}
              invalid={invalid}
              canMove={canMove}
              actions={actions}
              nameRef={nameRef}
              onBack={phone ? () => setOpened(false) : undefined}
            />
          </div>
        )}
      </div>
      {deleting && editor && (
        <DeleteStepDialog
          draft={draft}
          step={deleting}
          order={order}
          skills={skillMap}
          onClose={() => setDeleting(undefined)}
          onDelete={(moveTo, repoint) => {
            removeNow(deleting, moveTo, repoint);
            setDeleting(undefined);
          }}
        />
      )}
      {said && <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3 [&>*]:pointer-events-auto">{said}</div>}
    </div>
  );
}
