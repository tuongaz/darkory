import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import type { Skill } from "@/api/client";
import { FormDialog } from "@/components/FormDialog";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { countTasks } from "@/components/workflow/model";
import { lineTopology } from "@/components/workflowLine";
import type { RecordStep } from "../bind";
import { asLine, deadEndsAfterDelete, deleteStep, inbound, outcomes, tasksAt, type Draft, type Repoint } from "./draft";
import { andList } from "./reach";

const REMOVE = "@remove";
const DONE = "@done";

/**
 * Delete a Step, asked first when it matters, saying everything the delete does: which Step its
 * Tasks move to (as `/v1` requires); each outcome into it, removed unless led to another Step; and
 * what follows — where New Tasks start when they started here, its own outcomes going with it, and
 * the Steps it leaves with no way out.
 */
export function DeleteStepDialog({
  draft,
  step,
  order,
  skills,
  onClose,
  onDelete,
}: {
  draft: Draft;
  step: RecordStep;
  order: RecordStep[];
  skills: Map<string, Pick<Skill, "name">>;
  onClose: () => void;
  onDelete: (moveTo: string | undefined, repoint: Repoint) => void;
}) {
  const name = step.name.trim() || "the new Step";
  const nameOf = (id: string | undefined) => (id ? order.find((s) => s.id === id)?.name.trim() || "New Step" : "Done");
  const others = order.filter((s) => s.id !== step.id);
  const tasks = tasksAt(draft, step.id);
  const into = inbound(draft.wf, step.id);
  const [to, setTo] = useState<string | undefined>();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const repoint: Repoint = Object.fromEntries(
    Object.entries(choice)
      .filter(([, v]) => v !== REMOVE)
      .map(([id, v]) => [id, { to: v === DONE ? undefined : v }]),
  );
  const stranded = deadEndsAfterDelete(draft, step.id, repoint);
  const before = lineTopology(asLine(draft.wf, skills));
  const after = lineTopology(asLine(deleteStep(draft, step.id, to, repoint).wf, skills));
  const own = outcomes(draft.wf, step.id);
  const also: string[] = [];
  if (before.start === step.id) {
    also.push(
      after.start
        ? `New Tasks start at ${nameOf(after.start)}${after.before ? `, and ${nameOf(after.before)}'s Subtasks too` : ""}.`
        : "No Step is left where New Tasks start.",
    );
  }
  if (own.length > 0) also.push(`${name}'s own outcomes go: ${own.map((c) => `${c.name.trim() || "outcome"} → ${nameOf(c.to_step_id)}`).join(", ")}.`);

  const description =
    tasks > 0 && into.length > 0
      ? `${name} holds Tasks and other Steps lead into it.`
      : tasks > 0
        ? `${countTasks(tasks)} ${tasks === 1 ? "is" : "are"} at ${name}.`
        : into.length > 0
          ? `Other Steps lead into ${name}.`
          : `No Task is at ${name}.`;

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${name}`}
      description={description}
      submitLabel={`Delete ${name}`}
      destructive
      size="md"
      submitDisabled={tasks > 0 && !to}
      onSubmit={() => onDelete(tasks > 0 ? to : undefined, repoint)}
    >
      {tasks > 0 && (
        <section aria-label={`Tasks at ${name}`} className="flex flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold">
            {countTasks(tasks)} at {name}
          </h3>
          <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2">
            <span className="text-[13px]">Move them to</span>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger aria-label={`Step that receives the Tasks at ${name}`} className="w-full">
                <SelectValue placeholder="Pick a Step" />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {others.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name.trim() || "New Step"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>
      )}
      {into.length > 0 && (
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
                  </span>
                  <Select value={choice[c.id] ?? REMOVE} onValueChange={(v) => setChoice((x) => ({ ...x, [c.id]: v }))}>
                    <SelectTrigger aria-label={`Where ${c.name.trim() || "the outcome"} out of ${from} leads instead`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" align="start">
                      <SelectItem value={REMOVE}>Remove this outcome</SelectItem>
                      <SelectSeparator />
                      {others
                        .filter((s) => s.id !== c.from_step_id)
                        .map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name.trim() || "New Step"}
                          </SelectItem>
                        ))}
                      <SelectItem value={DONE}>Done</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
          <span className="text-xs text-muted-foreground">Or lead each to another Step.</span>
        </section>
      )}
      {also.length > 0 && (
        <section aria-label="Also" className="flex flex-col gap-1">
          <h3 className="text-[13px] font-semibold">Also</h3>
          <ul className="list-disc pl-5 text-[13px]">
            {also.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      )}
      {stranded.length > 0 && (
        <p role="note" className="flex items-start gap-1.5 text-xs font-medium text-state-claimed">
          <TriangleAlertIcon aria-hidden className="mt-px size-3.5 flex-none" />
          <span>
            {andList(stranded.map((s) => s.name))} {stranded.length === 1 ? "leads" : "lead"} out only into {name}: without it,{" "}
            {stranded.length === 1 ? "it has" : "they have"} no way out, and {stranded.length === 1 ? "its" : "their"} Tasks can only be moved by hand.
          </span>
        </p>
      )}
    </FormDialog>
  );
}
