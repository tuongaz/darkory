import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { Project } from "@/api/client";
import { useMembers, useWorkflow } from "@/api/queries";
import { peekParam } from "@/app/peek";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import type { LiveCanvas } from "@/components/workflow/live";
import type { Workflow } from "@/components/workflow/model";
import { WorkflowCanvas } from "@/components/workflow/WorkflowCanvas";
import { useTaskMap } from "@/screens/inbox/queries";
import { useLiveCanvas } from "./canvasData";
import { lineText, type FlowContext } from "./flowEvents";
import { StepPeek, stepParam } from "./StepPeek";
import { TextView } from "./TextView";
import { Trail } from "./Trail";
import { useTrail, type TrailFocus } from "./useTrail";
import { useLiveFlow, useReducedMotion } from "./useLiveFlow";
import type { WorkflowView } from "./view";

const none: Workflow = { steps: [], connectors: [] };

/** The Workflow with the chips a token carries drawn nowhere until it lands. */
function withoutTransit(workflow: Workflow, transit: Set<string>): Workflow {
  if (transit.size === 0) return workflow;
  return { ...workflow, steps: workflow.steps.map((s) => (s.chips?.some((c) => transit.has(c.id)) ? { ...s, chips: s.chips.filter((c) => !transit.has(c.id)) } : s)) };
}

/**
 * The Project's Workflow as it stands, read-only, and as it moves: the canvas (or its list) with
 * each Step's Tasks as chips and its takers ringed while they work there; each pickup, let-go,
 * lapse and take-back called out above its Step as it happens, each move a token travelling its
 * Connector; and beside it the trail of those moves, newest first. A Step opens its peek
 * (`?step=<id>`), a chip or a key its Task's (`?task=<key>`). Fills the page's Content.
 */
export function LiveWorkflow({ project, view }: { project: Project; view: WorkflowView }) {
  const record = useWorkflow(project.key);
  const drawn = useLiveCanvas(project.key, record.data);
  const tasks = useTaskMap(project.key);
  const members = useMembers();
  const reduced = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const open = params.get(stepParam);
  const setOpen = (id: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (id) next.set(stepParam, id);
      else next.delete(stepParam);
      return next;
    });
  const openTask = useCallback(
    (key: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.delete(stepParam);
        next.set(peekParam, key);
        return next;
      }),
    [setParams],
  );

  const ctx = useMemo<FlowContext>(() => {
    const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
    return {
      projectId: project.id,
      workflow: drawn ?? none,
      task: (id) => tasks.get(id),
      member: (id) => byId.get(id),
    };
  }, [project.id, drawn, tasks, members.data]);
  const flow = useLiveFlow(ctx, reduced);
  const trail = useTrail(project, ctx);
  const [focus, setFocus] = useState<TrailFocus | undefined>();
  const live = useMemo<LiveCanvas>(() => ({ ...flow, focus, onOpenTask: openTask }), [flow, focus, openTask]);
  const workflow = useMemo(() => drawn && withoutTransit(drawn, flow.transit), [drawn, flow.transit]);
  const working = drawn?.steps.reduce((n, s) => n + (s.chips?.filter((c) => c.holder).length ?? 0), 0) ?? 0;

  if (record.isError) return <Refusal error={record.error} className="m-6" />;
  if (!workflow) return <Skeleton aria-label="Loading the Workflow" className="m-6 h-[420px]" />;
  const step = workflow.steps.find((s) => s.id === open);
  const newest = trail.lines[0];
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        {view === "text" ? (
          <TextView workflow={workflow} mode="live" onStep={(s) => setOpen(s.id)} onTask={openTask} />
        ) : (
          <WorkflowCanvas workflow={workflow} mode="live" live={live} onOpenStep={(s) => setOpen(s.id)} className="min-h-0 flex-1" />
        )}
      </div>
      {/* The callouts are drawn for the eye; a screen reader hears each move as it arrives. */}
      <p role="status" className="sr-only">
        {newest && trail.fresh.has(newest.seq) ? lineText(newest) : ""}
      </p>
      <Trail trail={trail} working={working} onFocus={setFocus} onOpenTask={openTask} />
      {step && <StepPeek project={project} workflow={workflow} step={step} onClose={() => setOpen(null)} />}
    </div>
  );
}
