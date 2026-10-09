import { useState } from "react";
import { FormDialog } from "@/components/FormDialog";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { countTasks } from "@/components/workflow/model";
import { describeChanges, deleteWorkflow, inboundWorkflow, stepsIn, tasksAt, type Draft, type RecordWorkflow, type Repoint } from "./draft";
import { StepOptions } from "./StepOptions";

const REMOVE = "@remove";
const DONE = "@done";

/**
 * Delete a Workflow, saying everything the delete does: its Steps go; the Tasks at each move to a
 * Step of another Workflow (as `/v1` requires); each outcome into them from another Workflow is
 * removed unless led to another Step or Done; how many changes that makes. A Project keeps one
 * Workflow at least: the last is not deleted.
 */
export function DeleteWorkflowDialog({
  draft,
  workflow,
  onClose,
  onDelete,
}: {
  draft: Draft;
  workflow: RecordWorkflow;
  onClose: () => void;
  onDelete: (moves: Record<string, string>, repoint: Repoint) => void;
}) {
  const name = workflow.name.trim() || "New Workflow";
  const last = draft.wf.workflows.length < 2;
  const steps = stepsIn(draft.wf, workflow.id);
  const held = steps.filter((s) => tasksAt(draft, s.id) > 0);
  const into = inboundWorkflow(draft.wf, workflow.id);
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});
  const repoint: Repoint = Object.fromEntries(
    Object.entries(choice)
      .filter(([, v]) => v !== REMOVE)
      .map(([id, v]) => [id, { to: v === DONE ? undefined : v }]),
  );
  const nameOf = (id: string) => draft.wf.steps.find((s) => s.id === id)?.name.trim() || "New Step";
  const elsewhere = (s: { workflow_id: string }) => s.workflow_id !== workflow.id;
  const changes = last ? 0 : describeChanges(draft.wf, deleteWorkflow(draft, workflow.id, moves, repoint).wf).length;

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${name}`}
      description={
        last
          ? "A Project keeps one Workflow at least."
          : steps.length === 0
            ? `${name} has no Steps.`
            : `The Steps of ${name} go with it: ${steps.map((s) => s.name.trim() || "New Step").join(", ")}.`
      }
      submitLabel={`Delete ${name}`}
      destructive
      size="md"
      submitDisabled={last || held.some((s) => !moves[s.id])}
      onSubmit={() => onDelete(moves, repoint)}
    >
      {!last && held.length > 0 && (
        <section aria-label={`Tasks in ${name}`} className="flex flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold">Move their Tasks to</h3>
          <div className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-2">
            {held.map((s) => (
              <div key={s.id} className="contents">
                <span className="truncate text-[13px]">
                  {countTasks(tasksAt(draft, s.id))} at {s.name.trim() || "New Step"}
                </span>
                <Select value={moves[s.id]} onValueChange={(v) => setMoves((m) => ({ ...m, [s.id]: v }))}>
                  <SelectTrigger aria-label={`Step that receives the Tasks at ${s.name.trim() || "New Step"}`} className="w-full">
                    <SelectValue placeholder="Pick a Step" />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <StepOptions wf={draft.wf} offered={elsewhere} />
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </section>
      )}
      {!last && into.length > 0 && (
        <section aria-label={`Outcomes into ${name}`} className="flex flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold">
            {into.length} {into.length === 1 ? "outcome leads" : "outcomes lead"} into {name}
          </h3>
          <div className="grid grid-cols-1 items-center gap-x-2.5 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {into.map((c) => {
              const from = nameOf(c.from_step_id);
              return (
                <div key={c.id} className="contents">
                  <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
                    <span className="truncate">{from} ·</span>
                    <span className="truncate rounded-full border px-2 text-xs leading-5">{c.name.trim() || "outcome"}</span>
                    <span className="truncate text-muted-foreground">→ {nameOf(c.to_step_id!)}</span>
                  </span>
                  <Select value={choice[c.id] ?? REMOVE} onValueChange={(v) => setChoice((x) => ({ ...x, [c.id]: v }))}>
                    <SelectTrigger aria-label={`Where ${c.name.trim() || "the outcome"} out of ${from} leads instead`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="start">
                      <SelectItem value={REMOVE}>Remove this outcome</SelectItem>
                      <SelectSeparator />
                      <StepOptions wf={draft.wf} offered={(s) => elsewhere(s) && s.id !== c.from_step_id} />
                      <SelectSeparator />
                      <SelectItem value={DONE}>Done</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {!last && (
        <p className="text-xs text-muted-foreground">
          {changes} {changes === 1 ? "change" : "changes"}
        </p>
      )}
    </FormDialog>
  );
}
