import { describe, expect, it } from "vitest";
import { inProjectOrder } from "@/components/workflowLine/model";
import { parentTask, subtask, wfId, wfStep, workflow, workflowsFixture } from "@/test/fixtures";
import { subtaskLine } from "./subtaskLine";

// Which Workflow a Parent's Subtask line draws, of a Project of several (ADR 0019).
describe("the Subtask line's Workflow", () => {
  const record = workflowsFixture();
  const steps = [...record.steps].sort(inProjectOrder(record.workflows));
  const p = parentTask(1, { open: 3, working: 0, done: 0, dropped: 0 });
  const at = (n: number, stepId: string | undefined, state: "open" | "done" = "open") => subtask(n, p, { step_id: stepId, state });

  it("is the one its open Subtasks share", () => {
    expect(subtaskLine([at(2, wfStep.fix), at(3, wfStep.verify)], steps, record.workflows)).toEqual({ workflow: wfId.bugs, elsewhere: [] });
  });

  it("is the first open Subtask's in the Project's order when they are spread, the others counted by Workflow", () => {
    const line = subtaskLine([at(2, wfStep.support), at(3, wfStep.release), at(4, wfStep.qa), at(5, wfStep.awaitingCustomer)], steps, record.workflows);
    expect(line).toEqual({
      workflow: wfId.features,
      elsewhere: [{ id: wfId.support, name: "Support", n: 2 }],
    });
  });

  it("is none with no open Subtask at a Step, or a Project of one Workflow: the line's own default", () => {
    expect(subtaskLine([at(2, undefined), at(3, wfStep.fix, "done")], steps, record.workflows)).toEqual({ elsewhere: [] });
    const one = workflow();
    expect(subtaskLine([at(2, one.steps[2].id)], one.steps, one.workflows)).toEqual({ elsewhere: [] });
  });
});
