import { useCallback } from "react";
import type { Project } from "@/api/client";
import { workflowsSettingsPath } from "@/app/currentProject";
import { useGoToWorkflow, useWorkflowSegment, workflowNamed } from "../routeWorkflow";
import { stepParam } from "../StepPeek";
import type { Draft } from "./draft";

/**
 * The Workflow the editor shows, of the draft's: the one the address names
 * (`/settings/projects/:key/workflows/:workflow`, by id or name); undefined until the draft is
 * read, and when it names none. `pick` opens another's editor in place of the address, the draft
 * kept: Back leaves the editor rather than walking the picks. The picked Step is cleared, being of
 * the Workflow left, unless `step` names one of the Workflow picked (a Step moved into it).
 */
export function useEditorWorkflow(project: Pick<Project, "key">, draft: Draft | undefined): { id: string | undefined; pick: (id: string, step?: string) => void } {
  const segment = useWorkflowSegment();
  const id = segment && draft ? workflowNamed(draft.wf.workflows, segment)?.id : undefined;
  const goTo = useGoToWorkflow((w) => workflowsSettingsPath(project, w), project, { remember: false });
  const pick = useCallback(
    (next: string, step?: string) =>
      goTo(next, {
        replace: true,
        also: (p) => {
          if (step) p.set(stepParam, step);
          else if (next !== id) p.delete(stepParam);
        },
      }),
    [goTo, id],
  );
  return { id, pick };
}
