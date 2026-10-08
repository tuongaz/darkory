// The Task screens' own reads. Every key sits under a root queries.ts names, so an Activity entry
// about the record refetches it; Activity history is joined with what the stream has brought.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, call, type Activity, type ActivityKind } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { keys, newestActivity, useProjects, useWorkflow } from "@/api/queries";
import { findProject } from "@/app/currentProject";
import { stepsInOrder } from "../board/derive";
import { pathKinds } from "./path";

/**
 * The ids of the Tasks the signed-in Member can take now: Claim shows only on those. Its own key
 * under the `takeable` root: the Inbox caches the Tasks themselves under `keys.takeable`.
 */
export function useTakeableIds() {
  return useQuery({
    queryKey: [...keys.takeable, { ids: true }],
    queryFn: () => call(api.GET("/v1/tasks/takeable", { params: { query: { limit: 500 } } })).then((r) => new Set(r.items.map((t) => t.id))),
  });
}

// How far back a Task's Activity is read: pages of its Project's until the Task's filing.
const taskPages = 6;

/**
 * A Task's Activity of `kinds`, oldest page last. This is the one place that knows
 * /v1/activity reads by Project and not by Task: it reads the Project's pages back from the newest
 * until the Task's filing is among them, at most six pages of 500, and keeps the Task's entries.
 * When /v1 takes `task`, this becomes one call with it.
 */
export async function taskActivity(project: string, task: string, kinds: readonly ActivityKind[]): Promise<Activity[]> {
  const out: Activity[] = [];
  let before = newestActivity;
  for (let i = 0; i < taskPages; i++) {
    const page = await call(api.GET("/v1/activity", { params: { query: { project, kind: [...kinds], before, limit: 500 } } }));
    out.push(...page.items.filter((e) => e.subject_type === "task" && e.subject_id === task));
    if (out.some((e) => e.kind === "task.filed") || page.first_seq === undefined || page.items.length < 500) break;
    before = page.first_seq;
  }
  return out;
}

/** The entries that trace a Task through its Workflow (`pathKinds`), with what the stream has brought since. */
export function useTaskPath(projectId: string | undefined, taskId: string | undefined) {
  const history = useQuery({
    queryKey: ["activity", { project: projectId, kind: pathKinds, task: taskId }],
    queryFn: () => taskActivity(projectId!, taskId!, pathKinds),
    enabled: !!projectId && !!taskId,
  });
  const live = useLiveEntries();
  return useMemo(() => {
    const kinds: readonly string[] = pathKinds;
    return [...(history.data ?? []), ...live.filter((e) => e.subject_id === taskId && kinds.includes(e.kind))];
  }, [history.data, live, taskId]);
}

export function useSkillDetail(ref: string | undefined) {
  return useQuery({
    queryKey: keys.skill(ref ?? ""),
    queryFn: () => call(api.GET("/v1/skills/{skill}", { params: { path: { skill: ref! } } })),
    enabled: !!ref,
  });
}

export function useSkillVersions(ref: string | undefined) {
  return useQuery({
    queryKey: keys.skillVersions(ref ?? ""),
    queryFn: () => call(api.GET("/v1/skills/{skill}/versions", { params: { path: { skill: ref! } } })).then((r) => r.items),
    enabled: !!ref,
  });
}

/** A Parent's Observations, its Subtasks' included, reviewed or not: what its Retrospective reads. */
export function useObservations(task: string | undefined) {
  return useQuery({
    queryKey: ["task", task ?? "", "observations"],
    queryFn: () =>
      call(api.GET("/v1/tasks/{task}/observations", { params: { path: { task: task! }, query: { reviewed: true } } })).then((r) => r.items),
    enabled: !!task,
  });
}

/** The Task's Project and its Workflow's Steps in order, with their live facts. */
export function useTaskWorkflow(projectId: string | undefined) {
  const project = findProject(useProjects().data ?? [], projectId);
  const workflow = useWorkflow(project?.key);
  return { project, steps: stepsInOrder(workflow.data?.steps ?? []), connectors: workflow.data?.connectors ?? [] };
}
