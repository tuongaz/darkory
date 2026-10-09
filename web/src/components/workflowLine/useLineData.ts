import { useContext, useMemo } from "react";
import type { Task } from "@/api/client";
import { useMembers, useRunnerSessions, useTask, useTasks, useWorkflow } from "@/api/queries";
import { useNow } from "@/clock";
import { startOf } from "@/components/filters/dates";
import { MeContext } from "@/me";
import { useTakeableIds, useTaskPath } from "@/screens/task/queries";
import { useLiveCanvas } from "@/screens/workflow/canvasData";
import { lineTasks, scopedLine, traceOf, type LineScope, type ScopedLine, type ScopeParent, type Trace } from "./data";
import { shownWorkflow, type ShownWorkflow } from "@/components/pickedWorkflow";
import { drawnSteps, drawnWorkflow, type LineFacts, type LineTask } from "./model";
import { useProjectTasks } from "@/screens/board/queries";

/** A Parent the scope menu offers: its key and title, and how many of its Subtasks are open. */
export type ScopeChoice = { id: string; key: string; title: string; open: number };

export type LineData = {
  /** The Workflow with its Steps' takers (ringed by how they work there now) and medians. */
  facts: LineFacts;
  /** Every open Task of the Project, the questions with a Member included. */
  all: LineTask[];
  /** The Steps the line draws, by id (the picked Workflow's); none when it draws every Step. */
  drawnSteps?: ReadonlySet<string>;
  /**
   * The Workflow the page shows, of a Project of several: which Tasks its panels, views and counts
   * list, placed by the board's rules (`listedOn`) off the Tasks the board reads.
   */
  shown?: ShownWorkflow;
  /** The records behind `all`, for actions that take a Task. */
  records: Task[];
  scope: LineScope;
  /** The line narrowed to the scope. */
  scoped: ScopedLine;
  /** A single Task's path, when the scope is one Task. */
  trace?: Trace;
  /** The Tasks that reached Done today, in the Workflow drawn when it is one of several. */
  doneToday?: number;
  /** For the scope menu: the Parents with open Subtasks on the line (wherever the Parent is listed), and the open Tasks there with no Parent. */
  parents: ScopeChoice[];
  noParent: number;
  me: { id: string; takeable: ReadonlySet<string> };
};

const noTakeable: ReadonlySet<string> = new Set();

/**
 * Everything the Workflow line draws for a Project at a scope, live: the Workflow and its Steps'
 * facts, the open Tasks (Claims, Blocking, Runner sessions), what reached Done today, the scope's
 * Parent or Task, and one Task's path. `workflowId` is the Workflow the line draws (ADR 0019): its
 * Steps, with every Connector, so one into or out of another Workflow is an exit or an entry;
 * unsaid, the first of several, or every Step of a Project's one (`drawnWorkflow`). `scope` is the
 * `?scope=` value: `none`, a Task's id or key, or null for every open Task. `filter` (the Filter
 * bar's `matches`) narrows the tokens further; what it leaves out counts into each Step's "+N".
 */
export function useLineData(
  project: string,
  workflowId: string | undefined,
  scopeParam: string | null,
  filter?: (task: Task) => boolean,
): { data?: LineData; error?: unknown; loading: boolean } {
  const record = useWorkflow(project);
  const facts = useLiveCanvas(project, record.data);
  const open = useTasks({ project, state: "open" });
  const members = useMembers();
  const sessions = useRunnerSessions();
  const takeable = useTakeableIds();
  const me = useContext(MeContext);
  const now = useNow();
  const today = startOf(new Date(now));
  const done = useTasks({ project, state: "done", filter: [`completed_at:gte:${today}`] });
  const ref = scopeParam && scopeParam !== "none" ? scopeParam : undefined;
  const scoped = useTask(ref);
  const detail = scoped.data;
  const path = useTaskPath(detail && !(detail.task.subtask_counts || detail.subtasks.length > 0) ? detail.task.id : undefined);

  const byMember = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m])), [members.data]);
  const all = useMemo(() => {
    const items = sessions.data?.items ?? [];
    return lineTasks(open.data ?? [], {
      member: (id) => byMember.get(id),
      session: (task, member) => items.find((s) => s.task_id === task && s.member_id === member)?.state,
      now,
    });
  }, [open.data, sessions.data, byMember, now]);

  // The Workflow drawn and its Steps, kept the same between ticks of the clock: what reads them
  // (the Blocking view's layout, the panels) recomputes only when the Workflow or its Steps change.
  // (The facts are new on each tick, with their rings; the record is not.)
  const graph = record.data;
  const drawn = useMemo(() => (graph ? drawnWorkflow(graph, workflowId) : undefined), [graph, workflowId]);
  const steps = useMemo(() => (graph ? drawnSteps({ steps: graph.steps, drawn }) : undefined), [graph, drawn]);
  // The Tasks the board reads, its own query (open and ended): where a Parent's Subtasks are and
  // where they ended, so the page places every Task as the board does, in one place. Read only
  // where the page shows one Workflow of several.
  const whole = useProjectTasks(drawn ? project : "");
  // Which Tasks are this Workflow's page's (`listedOn`): the one placement every panel, view,
  // count and story of the page reads.
  const shown = useMemo(() => (graph && drawn && whole.data ? shownWorkflow(drawn, graph, whole.data) : undefined), [graph, drawn, whole.data]);

  // What reached Done today in the Workflow drawn, where its board's Done column has it: an ended
  // Parent where its Subtasks ended, not by its own Step.
  const doneToday = useMemo(() => {
    if (!done.data) return undefined;
    if (!drawn) return done.data.length;
    return shown ? done.data.filter((t) => shown.shows(t)).length : undefined;
  }, [drawn, done.data, shown]);

  const data = useMemo<LineData | undefined>(() => {
    // Of several Workflows, nothing until the page knows which Tasks are this one's.
    if (!facts || !open.data || (drawn && !shown)) return undefined;
    const lineFacts: LineFacts = {
      workflows: facts.workflows,
      steps: facts.steps.map((s) => ({ ...s, takers: s.takers.map((t) => ({ ...t, paused: byMember.get(t.id)?.agent?.paused })) })),
      connectors: facts.connectors,
      ...(drawn ? { drawn } : {}),
    };
    const isParent = (t: Task) => !!t.subtask_counts || false;
    let scope: LineScope = { kind: "all" };
    if (scopeParam === "none") scope = { kind: "none" };
    else if (ref) {
      const id = detail?.task.id ?? open.data.find((t) => t.id === ref || t.key === ref)?.id ?? ref;
      const parent = detail ? !!detail.task.subtask_counts || detail.subtasks.length > 0 : open.data.some((t) => (t.id === ref || t.key === ref) && isParent(t));
      scope = parent ? { kind: "parent", id } : { kind: "task", id };
    }
    let parent: ScopeParent | undefined;
    if (scope.kind === "parent" && detail) {
      parent = {
        id: detail.task.id,
        key: detail.task.key,
        title: detail.task.title,
        ended: detail.task.state !== "open",
        acceptance: detail.task.acceptance,
        subtasks: detail.subtasks.map((s) => ({ id: s.id, key: s.key, title: s.title, kind: s.kind, state: s.state })),
      };
    }
    const passing = filter ? new Set(open.data.filter(filter).map((t) => t.id)) : undefined;
    const narrowed = scopedLine(all, scope, { workflow: lineFacts, parent, passes: passing && ((id) => passing.has(id)) });
    let trace: Trace | undefined;
    if (scope.kind === "task" && detail) trace = traceOf(detail.task, path, detail.claims, lineFacts, (id) => byMember.get(id), now);

    // The scope menu: the Parents with open Subtasks on this line, wherever the Parent itself is
    // listed (an ended one holding its Retrospective here included; one with Subtasks on two
    // Workflows' lines on both), and the rest there. Another Workflow's Tasks are on its own line.
    const onLine = (t: LineTask) => !steps || (!!t.stepId && steps.has(t.stepId));
    const counts = new Map<string, number>();
    for (const t of all) if (t.parentId && onLine(t)) counts.set(t.parentId, (counts.get(t.parentId) ?? 0) + 1);
    const recordOf = new Map([...(whole.data ?? []), ...open.data].map((t) => [t.id, t]));
    const parents: ScopeChoice[] = [...counts].map(([id, n]) => {
      const r = recordOf.get(id) ?? (detail?.task.id === id ? detail.task : undefined);
      return { id, key: r?.key ?? "…", title: r?.title ?? "", open: n };
    });
    return {
      facts: lineFacts,
      all,
      ...(steps ? { drawnSteps: steps } : {}),
      ...(shown ? { shown } : {}),
      records: open.data,
      scope,
      scoped: narrowed,
      trace,
      doneToday,
      parents,
      noParent: all.filter((t) => t.stepId && onLine(t) && !t.parentId).length,
      me: { id: me?.member.id ?? "", takeable: takeable.data ?? noTakeable },
    };
  }, [facts, drawn, steps, shown, whole.data, open.data, all, byMember, scopeParam, ref, detail, path, now, doneToday, me, takeable.data, filter]);

  const error = record.error ?? open.error ?? whole.error;
  return { data, error: error ?? undefined, loading: !data && !error };
}
