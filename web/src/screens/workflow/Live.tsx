import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { Project, Task } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { useMembers } from "@/api/queries";
import { peekParam } from "@/app/peek";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { BlockingView } from "@/components/workflow/blocking";
import { useLineData, WorkflowLine, type Chain, type LineData } from "@/components/workflowLine";
import { useNow } from "@/clock";
import { AnswerButton, ClaimButton } from "@/screens/inbox/parts";
import { lineText, trailLine, type FlowContext } from "./flowEvents";
import { LineText } from "./LineText";
import type { LineView } from "./lineView";
import { NeedsYouPanel, StoriesPanel } from "./panels";
import { useLiveFlow, useReducedMotion } from "./useLiveFlow";

/**
 * The Project's Workflow as it stands and as it moves (Direction D): the line on top, every open
 * Task in the scope a token at its Step, a pickup tagged "now" and a move travelling its
 * Connector; under it Needs you (left) and What's happening (right), whose rows ring their Task's
 * token. Selecting a token draws its Blocking chain. The Blocking view and the Text view take the
 * line's place. Fills the page's Content.
 */
export function LiveWorkflow({ project, view, scope, onView }: { project: Project; view: LineView; scope: string | null; onView?: (v: LineView) => void }) {
  const { data, error } = useLineData(project.key, scope);
  const now = useNow();
  const [, setParams] = useSearchParams();
  const openTask = useCallback(
    (key: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set(peekParam, key);
        return next;
      }),
    [setParams],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [ringed, setRinged] = useState<string | null>(null);

  if (error) return <Refusal error={error} className="m-6" />;
  if (!data) return <Skeleton aria-label="Loading the Workflow" className="m-6 h-[420px]" />;

  const keyOf = (id: string) => data.all.find((t) => t.id === id)?.key;
  const panels = {
    needs: <NeedsYouPanel project={project.key} onHover={setRinged} />,
    stories: <StoriesPanel project={project.key} onHover={setRinged} onOpen={(id) => keyOf(id) && openTask(keyOf(id)!)} />,
  };

  if (view === "blocking") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <BlockingView
          project={project.key}
          scope={data.scope.kind === "parent" ? data.scope.id : undefined}
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
    // on top and the panels side by side under it.
    <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:grid lg:grid-rows-[auto_minmax(280px,1fr)] lg:overflow-hidden">
      <div className="order-2 flex-none px-2 pt-2 sm:px-5 lg:order-none lg:max-h-full lg:overflow-y-auto lg:px-5">
        <LiveLine project={project} data={data} now={now} selected={selected} onSelect={setSelected} ringed={ringed} onOpenTask={openTask} />
      </div>
      <div className="contents lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_440px] lg:border-t">
        <div className="order-1 border-b lg:order-none lg:min-h-0 lg:overflow-y-auto lg:border-b-0">{panels.needs}</div>
        <div className="order-3 border-t lg:order-none lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l">{panels.stories}</div>
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
}: {
  project: Project;
  data: LineData;
  now: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  ringed: string | null;
  onOpenTask: (key: string) => void;
}) {
  const members = useMembers();
  const reduced = useReducedMotion();
  const ctx = useMemo<FlowContext>(() => {
    const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
    const tasks = new Map(data.records.map((t) => [t.id, t]));
    return { projectId: project.id, workflow: data.facts, task: (id) => tasks.get(id), member: (id) => byId.get(id) };
  }, [project.id, data.facts, data.records, members.data]);
  const flow = useLiveFlow(ctx, reduced);
  const announced = useAnnouncement(ctx);
  const recordOf = useMemo(() => new Map<string, Task>(data.records.map((t) => [t.id, t])), [data.records]);
  const actionFor = (first: Chain["first"]) => {
    if (first.kind === "none") return null;
    const task = recordOf.get(first.task.id);
    if (!task) return null;
    return first.kind === "answer" ? <AnswerButton task={task} /> : <ClaimButton task={task} />;
  };
  const s = data.scoped;
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
        fold={s.fold}
        doneToday={data.doneToday}
        trace={data.trace}
        compactHeads={!!data.trace}
        noBranch={!!data.trace && !data.trace.stays.some((st) => data.facts.steps.some((x) => x.id === st.stepId && ["acceptance", "retro", "skill-review"].includes(x.skill?.name ?? "")))}
        flow={flow}
        now={now}
        selected={selected}
        onSelect={onSelect}
        ringed={ringed}
        onOpenTask={onOpenTask}
        me={data.me}
        actionFor={actionFor}
      />
      {/* The tags are drawn for the eye; a screen reader hears each move as it arrives. */}
      <p role="status" className="sr-only">
        {announced}
      </p>
    </>
  );
}

/** The newest flow entry that arrived since the page opened, in the trail's words. */
function useAnnouncement(ctx: FlowContext): string {
  const live = useLiveEntries();
  const [opened] = useState(() => live[0]?.seq ?? 0);
  for (const e of live) {
    if (e.seq <= opened) break;
    const line = trailLine(e, ctx);
    if (line) return lineText(line);
  }
  return "";
}
