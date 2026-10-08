import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { api, call, type Project, type Task } from "@/api/client";
import { keys, useDirectory, useOpenTasks, useRunnerSessions, useTakeable } from "@/api/queries";
import { peekParam } from "@/app/peek";
import { useNow } from "@/clock";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentMe } from "@/me";
import type { GraphStep } from "../graph";
import { BlockingBoard, type BandParent } from "./BlockingBoard";
import { blockingTasks } from "./bind";

const dataOf = <T,>(results: { data?: T }[]) => results.map((r) => r.data);

/**
 * The Blocking view of `project`, or of `scope` (a Task's id: a Parent's Subtasks with the
 * outside Tasks joined to them, or one Task's chain): `BlockingBoard` over the Organisation's
 * open Tasks, live with the record. A node's Open opens its Task's peek (`?task=`); Show on line
 * hands its id to `onShowOnLine`.
 */
export function BlockingView({ project, scope, onShowOnLine }: { project: Project; scope?: string; onShowOnLine: (taskId: string) => void }) {
  const open = useOpenTasks();
  const { members, projects, skills } = useDirectory();
  const runner = useRunnerSessions().data?.items;
  const takeable = useTakeable().data;
  const now = useNow();
  const me = useCurrentMe().member.id;
  const [, setParams] = useSearchParams();

  const sessions = useMemo(() => new Map((runner ?? []).map((s) => [s.task_id, s])), [runner]);
  const takeableByMe = useMemo(() => new Set((takeable ?? []).map((t) => t.id)), [takeable]);
  const tasks = useMemo(() => blockingTasks(open.data ?? [], { members, now, sessions, takeableByMe }), [open.data, members, now, sessions, takeableByMe]);
  const byId = useMemo(() => new Map((open.data ?? []).map((t) => [t.id, t])), [open.data]);

  // The Workflows of the Projects drawn: this one, and any a Blocking reaches into.
  const projectKeys = useMemo(() => {
    const ids = new Set([project.id]);
    for (const t of tasks)
      for (const b of t.blockedBy)
        if (byId.has(b)) {
          ids.add(t.projectId);
          ids.add(byId.get(b)!.project_id);
        }
    return [...ids].map((id) => projects.get(id)?.key ?? (id === project.id ? project.key : undefined)).filter((k): k is string => !!k);
  }, [tasks, byId, project, projects]);
  const workflowData = useQueries({
    queries: projectKeys.map((key) => ({
      queryKey: keys.workflow(key),
      queryFn: () => call(api.GET("/v1/projects/{project}/workflow", { params: { path: { project: key } } })),
    })),
    combine: dataOf,
  });
  const steps = useMemo(() => {
    const out = new Map<string, GraphStep[]>();
    for (const wf of workflowData) {
      if (!wf) continue;
      out.set(
        wf.project_id,
        [...wf.steps]
          .sort((x, y) => x.position - y.position)
          .map((s) => {
            const skill = s.skill_id ? skills.get(s.skill_id) : undefined;
            return { id: s.id, name: s.name, skill: s.skill_id ? { id: s.skill_id, name: skill?.name ?? "" } : undefined };
          }),
      );
    }
    return out;
  }, [skills, workflowData]);

  // A Parent no longer open (its Retrospective or a question under it still is) is read by itself.
  const missing = useMemo(() => [...new Set(tasks.flatMap((t) => (t.parentId && !byId.has(t.parentId) ? [t.parentId] : [])))], [tasks, byId]);
  const endedData = useQueries({
    queries: missing.map((id) => ({ queryKey: keys.task(id), queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: id } } })) })),
    combine: dataOf,
  });
  const parents = useMemo(() => {
    const out = new Map<string, BandParent>();
    const add = (t: Task | undefined) => t && out.set(t.id, { id: t.id, key: t.key, title: t.title, counts: t.subtask_counts });
    for (const t of open.data ?? []) if (t.subtask_counts) add(t);
    for (const d of endedData) add(d?.task);
    return out;
  }, [open.data, endedData]);
  const projectNames = useMemo(() => new Map([...projects.values()].map((p) => [p.id, { key: p.key, name: p.name }])), [projects]);

  const onOpen = useCallback(
    (id: string) => {
      const key = byId.get(id)?.key;
      if (!key) return;
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set(peekParam, key);
        return next;
      });
    },
    [byId, setParams],
  );

  if (open.isError) return <Refusal error={open.error} className="m-6" />;
  if (!open.data) return <Skeleton aria-label="Loading the Blocking" className="h-[420px]" />;
  return (
    <BlockingBoard
      tasks={tasks}
      projectId={project.id}
      scope={scope}
      me={me}
      now={now}
      steps={steps}
      parents={parents}
      projects={projectNames}
      onOpen={onOpen}
      onShowOnLine={onShowOnLine}
      graphLink={(key) => `/tasks/${encodeURIComponent(key)}?view=graph`}
    />
  );
}
