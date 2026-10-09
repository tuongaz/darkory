import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import type { RecordStep, WorkflowRecord } from "../bind";
import { stepsIn, workflowsOf } from "./draft";

/**
 * The Steps a Select offers, of a Project's Workflows: of one, the Steps in order; of several,
 * each Workflow's under its name, `first`'s first (the Workflow of the Step being edited), then
 * the others in order. A Workflow none of whose Steps is offered is left out.
 */
export function StepOptions({ wf, first, offered = () => true }: { wf: WorkflowRecord; first?: string; offered?: (s: RecordStep) => boolean }) {
  const item = (s: RecordStep) => (
    <SelectItem key={s.id} value={s.id}>
      {s.name.trim() || "New Step"}
    </SelectItem>
  );
  const workflows = workflowsOf(wf);
  if (workflows.length < 2) return <>{stepsIn(wf, workflows[0]?.id).filter(offered).map(item)}</>;
  const ordered = [...workflows.filter((w) => w.id === first), ...workflows.filter((w) => w.id !== first)];
  return (
    <>
      {ordered.map((w) => {
        const steps = stepsIn(wf, w.id).filter(offered);
        return steps.length === 0 ? null : (
          <SelectGroup key={w.id}>
            <SelectLabel>{w.name.trim() || "New Workflow"}</SelectLabel>
            {steps.map(item)}
          </SelectGroup>
        );
      })}
    </>
  );
}
