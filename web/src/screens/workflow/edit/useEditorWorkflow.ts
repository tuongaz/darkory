import { useCallback } from "react";
import { useSearchParams } from "react-router";
import type { Project } from "@/api/client";
import { workflowsSettingsPath } from "@/app/currentProject";
import { usePickedWorkflow, workflowParam } from "@/components/pickedWorkflow";
import { toShort } from "@/lib/shortid";
import { isNew } from "../bind";
import { useGoToWorkflow, useWorkflowSegment, workflowNamed } from "../routeWorkflow";
import { stepParam } from "../StepPeek";
import type { Draft } from "./draft";

/**
 * The Workflow the editor shows, of the draft's: the one the address names
 * (`/settings/projects/:key/workflows/:workflow`), else `?workflow=`, else that of the Step
 * `?step=` names, else the one this browser last picked, else the first (`usePickedWorkflow`).
 * Picking another clears the picked Step, which is of the Workflow left, unless a Step of the one
 * picked is named with it; a Workflow not saved yet is not remembered, having no id the record knows.
 */
export function useEditorWorkflow(project: Pick<Project, "key">, draft: Draft | undefined): { id: string | undefined; pick: (id: string, step?: string) => void } {
  const [params] = useSearchParams();
  const workflows = draft?.wf.workflows;
  const picked = usePickedWorkflow(project, workflows);
  const segment = useWorkflowSegment();
  const fixed = segment && workflows ? workflowNamed(workflows, segment)?.id : undefined;
  const named = params.get(workflowParam);
  const fromAddress = !!named && !!workflows?.some((w) => w.id === toShort(named));
  const step = params.get(stepParam);
  const ofStep = step ? draft?.wf.steps.find((s) => s.id === toShort(step))?.workflow_id : undefined;
  const id = segment ? fixed : fromAddress ? picked.id : (ofStep ?? picked.id);
  const set = picked.set;
  const goTo = useGoToWorkflow((w) => workflowsSettingsPath(project, w), project, { remember: false });
  const pick = useCallback(
    (next: string, step?: string) => {
      const also = (p: URLSearchParams) => {
        if (step) p.set(stepParam, step);
        else if (next !== id) p.delete(stepParam);
      };
      // As a Step's pick: Back leaves the editor rather than walking the picks.
      if (segment) goTo(next, { also, replace: true });
      else set(next, { remember: !isNew(next), replace: true, also });
    },
    [set, id, segment, goTo],
  );
  return { id, pick };
}
