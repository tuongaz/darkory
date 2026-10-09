import { useQueries } from "@tanstack/react-query";
import { useContext, useMemo } from "react";
import { api, call, type Task } from "@/api/client";
import { keys, useMembers, useRunnerSessions, useTask, useTasks, useWorkflow } from "@/api/queries";
import { useNow } from "@/clock";
import { startOf } from "@/components/filters/dates";
import { MeContext } from "@/me";
import { useTakeableIds, useTaskPath } from "@/screens/task/queries";
import { useLiveCanvas } from "@/screens/workflow/canvasData";
import { lineTasks, scopedLine, scopeMenu, traceOf, type LineScope, type ScopeChoice, type ScopedLine, type ScopeParent, type Trace } from "./data";
import { shownWorkflow, type ShownWorkflow } from "@/components/pickedWorkflow";
import { drawnSteps, drawnWorkflow, type LineFacts, type LineTask } from "./model";

export type LineData = {
  /** The Workflow with its Steps' takers (ringed by how they work there now) and medians. */
  facts: LineFacts;
  /** Every open Task of the Project, the questions with a Member included. */
  all: LineTask[];
  /** The Steps the line draws, by id (the picked Workflow's); none when it draws every Step. */
  drawnSteps?: ReadonlySet<string>;
  /**
   * The Workflow the page shows, of a Project of several: which Tasks its panels, views and counts
   * list, where the server places each (`listedOn`), as its board lists them; and the lines a
   * Parent's open Subtasks are on.
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

  // An ended Parent still holding open Subtasks (its Retrospective) is not among the open Tasks:
  // read it, for its key and title in the scope menu, and where it is listed.
  const missing = useMemo(() => {
    const ids = new Set((open.data ?? []).map((t) => t.id));
    return [...new Set((open.data ?? []).map((t) => t.parent_id).filter((id): id is string => !!id && !ids.has(id)))];
  }, [open.data]);
  const ended = useQueries({
    queries: missing.map((id) => ({ queryKey: keys.task(id), queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: id } } })) })),
  });
  const endedKey = ended.map((q) => q.dataUpdatedAt).join();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `ended` is new each render; `endedKey` stands for it.
  const endedParents = useMemo(() => ended.map((q) => q.data?.task).filter((t): t is Task => !!t), [endedKey]);

  // The Workflow drawn and its Steps, kept the same between ticks of the clock: what reads them
  // (the Blocking view's layout, the panels) recomputes only when the Workflow or its Steps change.
  // (The facts are new on each tick, with their rings; the record is not.)
  const graph = record.data;
  const drawn = useMemo(() => (graph ? drawnWorkflow(graph, workflowId) : undefined), [graph, workflowId]);
  const steps = useMemo(() => (graph ? drawnSteps({ steps: graph.steps, drawn }) : undefined), [graph, drawn]);
  // Which Tasks are this Workflow's page's, where the server lists each (`listedOn`, its
  // `workflow_id`): the one placement every panel, view, count and story of the page reads, as
  // the board's. Of a Project of several Workflows only.
  const shown = useMemo(() => {
    if (!graph || !drawn) return undefined;
    const tasks = new Map<string, Task>();
    for (const t of [...endedParents, ...(done.data ?? []), ...(open.data ?? [])]) tasks.set(t.id, t);
    // The scoped Task's own record only fills a gap: a list read since is fresher.
    if (detail && !tasks.has(detail.task.id)) tasks.set(detail.task.id, detail.task);
    return shownWorkflow(drawn, graph, [...tasks.values()]);
  }, [graph, drawn, endedParents, done.data, open.data, detail]);

  // What reached Done today in the Workflow drawn, where its board's Done column has it.
  const doneToday = useMemo(() => {
    if (!done.data) return undefined;
    return shown ? done.data.filter((t) => shown.shows(t)).length : done.data.length;
  }, [done.data, shown]);

  const data = useMemo<LineData | undefined>(() => {
    if (!facts || !open.data) return undefined;
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

    // The scope menu: the Parents with open Subtasks on this line, and the rest there.
    const recordOf = new Map([...endedParents, ...open.data].map((t) => [t.id, t]));
    const menu = scopeMenu(all, steps, (id) => recordOf.get(id) ?? (detail?.task.id === id ? detail.task : undefined));
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
      ...menu,
      me: { id: me?.member.id ?? "", takeable: takeable.data ?? noTakeable },
    };
  }, [facts, drawn, steps, shown, endedParents, open.data, all, byMember, scopeParam, ref, detail, path, now, doneToday, me, takeable.data, filter]);

  const error = record.error ?? open.error;
  return { data, error, loading: !data && !error };
}
