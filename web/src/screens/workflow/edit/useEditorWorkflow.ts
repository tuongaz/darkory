import { useCallback } from "react";
import type { Project } from "@/api/client";
import { workflowEditPath } from "@/app/currentProject";
import { toShort } from "@/lib/shortid";
import { useGoToWorkflow, useWorkflowSegment, workflowNamed } from "../routeWorkflow";
import { stepParam } from "../StepPeek";
import type { RecordWorkflow, Draft } from "./draft";
import type { WorkflowRecord } from "../bind";

/**
 * The Workflow the editor shows (`/projects/:key/workflows/:workflow/edit`): the segment read
 * against the record as read (`base`), by id, long or short, or by name ignoring case; else, by
 * its id, one only the draft has (a Step moved into a Workflow not saved yet). Read against the
 * record, a rename in the draft never loses the address. `redirect` is the id when the segment
 * said it otherwise (a name, a long id): the page goes there in place before drawing the editor.
 * `id` is undefined until both are read, and when the segment names none. `pick` opens another's
 * editor in place of the address, the draft kept: Back leaves the editor rather than walking the
 * picks. The picked Step is cleared, being of the Workflow left, unless `step` names one of the
 * Workflow picked (a Step moved into it).
 */
export function useEditorWorkflow(
  project: Pick<Project, "key">,
  draft: Draft | undefined,
  base: Pick<WorkflowRecord, "workflows"> | undefined,
): { id: string | undefined; workflow: RecordWorkflow | undefined; redirect: string | undefined; pick: (id: string, step?: string) => void } {
  const segment = useWorkflowSegment();
  const read = segment && base && draft ? workflowNamed(base.workflows, segment) : undefined;
  const id = read?.id ?? (segment && draft ? draft.wf.workflows.find((w) => w.id === toShort(segment) || w.id === segment)?.id : undefined);
  const workflow = id ? draft?.wf.workflows.find((w) => w.id === id) : undefined;
  const redirect = read && segment !== read.id ? read.id : undefined;
  const goTo = useGoToWorkflow((w) => workflowEditPath(project, w), project, { remember: false });
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
  return { id, workflow, redirect, pick };
}
