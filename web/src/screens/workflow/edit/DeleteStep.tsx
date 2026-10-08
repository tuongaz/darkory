import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { countTasks } from "@/components/workflow/model";
import type { RecordStep } from "../bind";
import { deadEndsAfterDelete, tasksAt, type Draft } from "./draft";

/**
 * Delete a Step, asked first when it matters: with Tasks at it (or moved to it by this editing),
 * which Step they go to, as `/v1` requires; and, said not refused, the Steps it leaves with no
 * way out.
 */
export function DeleteStepDialog({
  draft,
  step,
  order,
  onClose,
  onDelete,
}: {
  draft: Draft;
  step: RecordStep;
  order: RecordStep[];
  onClose: () => void;
  onDelete: (moveTo: string | undefined) => void;
}) {
  const name = step.name.trim() || "the new Step";
  const others = order.filter((s) => s.id !== step.id);
  const stranded = deadEndsAfterDelete(draft, step.id);
  const tasks = tasksAt(draft, step.id);
  const moving = tasks > 0;
  const [to, setTo] = useState<string | undefined>();
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Delete ${name}`}
      description={
        moving
          ? `${countTasks(tasks)} ${tasks === 1 ? "is" : "are"} at ${name}. Say which Step ${tasks === 1 ? "it moves" : "they move"} to on Save; a Claim on ${tasks === 1 ? "it" : "them"} stays.`
          : `No Task is at ${name}.`
      }
      submitLabel={`Delete ${name}`}
      destructive
      submitDisabled={moving && !to}
      onSubmit={() => onDelete(moving ? to : undefined)}
    >
      {moving && (
        <FormRows>
          <FormRow label="Move them to">
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
          </FormRow>
        </FormRows>
      )}
      {stranded.length > 0 && (
        <p role="note" className="flex items-start gap-1.5 text-xs font-medium text-state-claimed">
          <TriangleAlertIcon aria-hidden className="mt-px size-3.5 flex-none" />
          <span>
            {listNames(stranded.map((s) => s.name))} {stranded.length === 1 ? "leads" : "lead"} out only into {name}: without it,{" "}
            {stranded.length === 1 ? "it has" : "they have"} no way out, and {stranded.length === 1 ? "its" : "their"} Tasks can only be moved by hand.
          </span>
        </p>
      )}
    </FormDialog>
  );
}

/** "Build", "Build and QA", "Plan, Build and QA". */
function listNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
