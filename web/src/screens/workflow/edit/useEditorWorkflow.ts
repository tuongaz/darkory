import { useCallback } from "react";
import { useSearchParams } from "react-router";
import type { Project } from "@/api/client";
import { usePickedWorkflow, workflowParam } from "@/components/pickedWorkflow";
import { toShort } from "@/lib/shortid";
import { isNew } from "../bind";
import { stepParam } from "../StepPeek";
import type { Draft } from "./draft";

/**
 * The Workflow the editor shows, of the draft's: the one `?workflow=` names, else that of the
 * Step `?step=` names (Edit from a Step on the live page), else the one this browser last picked,
 * else the first (`usePickedWorkflow`). Picking another clears the picked Step, which is of the
 * Workflow left, unless a Step of the one picked is named with it; a Workflow not saved yet is not remembered, having no id the record knows.
 */
export function useEditorWorkflow(project: Pick<Project, "key">, draft: Draft | undefined): { id: string | undefined; pick: (id: string, step?: string) => void } {
  const [params] = useSearchParams();
  const workflows = draft?.wf.workflows;
  const picked = usePickedWorkflow(project, workflows);
  const named = params.get(workflowParam);
  const fromAddress = !!named && !!workflows?.some((w) => w.id === toShort(named));
  const step = params.get(stepParam);
  const ofStep = step ? draft?.wf.steps.find((s) => s.id === toShort(step))?.workflow_id : undefined;
  const id = fromAddress ? picked.id : (ofStep ?? picked.id);
  const set = picked.set;
  const pick = useCallback(
    (next: string, step?: string) =>
      set(next, {
        remember: !isNew(next),
        // As a Step's pick: Back leaves the editor rather than walking the picks.
        replace: true,
        also: (p) => {
          if (step) p.set(stepParam, step);
          else if (next !== id) p.delete(stepParam);
        },
      }),
    [set, id],
  );
  return { id, pick };
}
