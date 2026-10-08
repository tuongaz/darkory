import { useSearchParams } from "react-router";
import type { Project } from "@/api/client";
import { useWorkflow } from "@/api/queries";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkflowCanvas } from "@/components/workflow/WorkflowCanvas";
import { useLiveCanvas } from "./canvasData";
import { StepPeek, stepParam } from "./StepPeek";
import { TextView } from "./TextView";
import type { WorkflowView } from "./view";

/**
 * The Project's Workflow as it stands, read-only: the canvas (or its list) with each Step's
 * counts, its takers ringed while they work there, and a Step's peek on a click (`?step=<id>`).
 * Fills the page's Content.
 */
export function LiveWorkflow({ project, view }: { project: Project; view: WorkflowView }) {
  const record = useWorkflow(project.key);
  const workflow = useLiveCanvas(project.key, record.data);
  const [params, setParams] = useSearchParams();
  const open = params.get(stepParam);
  const setOpen = (id: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (id) next.set(stepParam, id);
      else next.delete(stepParam);
      return next;
    });

  if (record.isError) return <Refusal error={record.error} className="m-6" />;
  if (!workflow) return <Skeleton aria-label="Loading the Workflow" className="m-6 h-[420px]" />;
  const step = workflow.steps.find((s) => s.id === open);
  return (
    <>
      {view === "text" ? (
        <TextView workflow={workflow} mode="live" onStep={(s) => setOpen(s.id)} />
      ) : (
        <WorkflowCanvas workflow={workflow} mode="live" onOpenStep={(s) => setOpen(s.id)} className="h-full" />
      )}
      {step && <StepPeek project={project} workflow={workflow} step={step} onClose={() => setOpen(null)} />}
    </>
  );
}
