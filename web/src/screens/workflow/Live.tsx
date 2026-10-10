import { useMemo, useState } from "react";
import type { Project, Task } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { useMembers } from "@/api/queries";
import { projectPath } from "@/app/currentProject";
import { stepFilterSearch, type FilterPill } from "@/components/filters/filterState";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BlockingView } from "@/components/workflow/blocking";
import { scopePills, useLineData, WorkflowLine, type LineData } from "@/components/workflowLine";
import { branchSkills } from "@/components/workflowLine/model";
import { useNow } from "@/clock";
import { lineText, onDrawnLine, trailLine, type FlowContext } from "./flowEvents";
import { LineText } from "./LineText";
import { useFirstMove, useOpenTask } from "./lineMoves";
import type { LineView } from "./lineView";
import { NeedsYouPanel, StoriesPanel, useStoriesQuiet } from "./panels";
import { useLiveFlow, useReducedMotion } from "./useLiveFlow";

/**
 * The Project's Workflow as it stands and as it moves (Direction D): the line on top, every open
 * Task in the scope a token at its Step, a pickup tagged "now" and a move travelling its
 * Connector; under it Needs you (left) and What's happening (right), whose rows ring their Task's
 * token. Selecting a token draws its Blocking chain. The Blocking view and the Text view take the
 * line's place. Fills the page's Content.
 */
export function LiveWorkflow({
  project,
  workflowId,
  view,
  scope,
  onView,
  filter,
  pills,
}: {
  project: Project;
  /** The Workflow drawn, of a Project of several (`usePickedWorkflow`); the first when unsaid. */
  workflowId?: string;
  view: LineView;
  scope: string | null;
  onView?: (v: LineView) => void;
  /** The Filter bar's test: Tasks it leaves out leave the line, counted into their Step's "+N". */
  filter?: (task: Task) => boolean;
  /** The Filter's pills `filter` applies: what a Step's list link carries on to the Tasks list. */
  pills?: readonly FilterPill[];
}) {
  const { data, error } = useLineData(project.key, workflowId, scope, filter);
  // Of a Project of several Workflows the page is the drawn one's: its panels list its Tasks.
  const shown = data?.shown;
  const now = useNow();
  const openTask = useOpenTask();
  const [selected, setSelected] = useState<string | null>(null);
  const [ringed, setRinged] = useState<string | null>(null);
  const quiet = useStoriesQuiet(project, shown);

  if (error) return <Refusal error={error} className="m-6" />;
  if (!data) return <Skeleton aria-label="Loading the Workflow" className="m-6 h-[420px]" />;

  const panels = {
    needs: <NeedsYouPanel project={project} workflow={shown} onHover={setRinged} />,
    // A story opened into its path selects its token on the line, as F2 draws it.
    stories: <StoriesPanel project={project} workflow={shown} onHover={setRinged} onOpen={setSelected} />,
  };

  if (view === "blocking") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-4 sm:px-6">
        <BlockingView
          project={project}
          scope={data.scope.kind === "parent" ? data.scope.id : undefined}
          shown={data.shown}
          onShowOnLine={(id) => {
            setSelected(id);
            onView?.("line");
          }}
        />
      </div>
    );
  }
  if (view === "text") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <LineText data={data} now={now} onTask={openTask} />
      </div>
    );
  }
  return (
    // A phone reads it top to bottom: Needs you, the line, What's happening. Wider, the line sits
    // on top and the panels side by side under it; when nothing has happened lately What's
    // happening folds to one line over Needs you, which takes the full width. The line is never
    // cut: when it leaves the panels less than their 280px, the page scrolls.
    <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:grid lg:grid-rows-[auto_minmax(280px,1fr)]">
      <div className="order-2 flex-none px-2 pt-2 sm:px-5 lg:order-none lg:px-5">
        <LiveLine project={project} data={data} now={now} selected={selected} onSelect={setSelected} ringed={ringed} onOpenTask={openTask} pills={pills} />
      </div>
      {/* One tree whether quiet or not, so neither panel remounts when What's happening folds. */}
      <div className={cn("contents lg:grid lg:min-h-0 lg:border-t", quiet ? "lg:grid-cols-1 lg:grid-rows-[auto_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,1fr)_440px]")}>
        <div className={cn("order-1 border-b lg:min-h-0 lg:border-b-0", quiet ? "lg:order-2" : "lg:order-none")}>{panels.needs}</div>
        <div className={cn("order-3 border-t lg:min-h-0 lg:border-t-0", quiet ? "lg:order-1 lg:border-b" : "lg:order-none")}>{panels.stories}</div>
      </div>
    </div>
  );
}

/** The line with the moments playing on it: each Activity entry about this Project's Tasks as it arrives. */
function LiveLine({
  project,
  data,
  now,
  selected,
  onSelect,
  ringed,
  onOpenTask,
  pills,
}: {
  project: Project;
  data: LineData;
  now: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  ringed: string | null;
  onOpenTask: (key: string) => void;
  pills?: readonly FilterPill[];
}) {
  const members = useMembers();
  const reduced = useReducedMotion();
  const ctx = useMemo<FlowContext>(() => {
    const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
    const tasks = new Map(data.records.map((t) => [t.id, t]));
    return { projectId: project.id, workflow: data.facts, drawn: data.drawnSteps, task: (id) => tasks.get(id), member: (id) => byId.get(id) };
  }, [project.id, data.facts, data.drawnSteps, data.records, members.data]);
  const flow = useLiveFlow(ctx, reduced);
  const announced = useAnnouncement(ctx);
  const actionFor = useFirstMove(data.records);
  const s = data.scoped;
  // A Step's list links to the Tasks list at the Step, under the scope and Filter its count was made
  // under: one pill per field, the scope's Parent over a Filter's.
  const narrowed = [...scopePills(data.scope), ...(pills ?? [])];
  return (
    <>
      <WorkflowLine
        label="Workflow"
        workflow={data.facts}
        tasks={s.drawn}
        all={data.all}
        hidden={s.hidden}
        done={s.done}
        ghosts={s.ghosts}
        branchLabel={s.branchLabel}
        doneToday={data.doneToday}
        trace={data.trace}
        noBranch={!!data.trace && !data.trace.stays.some((st) => data.facts.steps.some((x) => x.id === st.stepId && branchSkills.includes(x.skill?.name ?? "")))}
        flow={flow}
        now={now}
        selected={selected}
        onSelect={onSelect}
        ringed={ringed}
        onOpenTask={onOpenTask}
        me={data.me}
        actionFor={actionFor}
        stepHref={(stepId) => `${projectPath(project, "tasks")}?${stepFilterSearch(stepId, narrowed)}`}
      />
      {/* The tags are drawn for the eye; a screen reader hears each move as it arrives. */}
      <p role="status" className="sr-only">
        {announced}
      </p>
    </>
  );
}

/** The newest flow entry about the line drawn that arrived since the page opened, in the trail's words. */
function useAnnouncement(ctx: FlowContext): string {
  const live = useLiveEntries();
  const [opened] = useState(() => live[0]?.seq ?? 0);
  for (const e of live) {
    if (e.seq <= opened) break;
    const line = onDrawnLine(e, ctx) && trailLine(e, ctx);
    if (line) return lineText(line);
  }
  return "";
}
