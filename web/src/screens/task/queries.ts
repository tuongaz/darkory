// The Task screens' own reads. Every key sits under a root queries.ts names, so an Activity entry
// about the record refetches it; Activity history is joined with what the stream has brought.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, call, type Activity } from "@/api/client";
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

// How far back a Task's path is read: pages of its Project's path entries until its filing.
const pathPages = 6;

/**
 * The entries that trace a Task through its Workflow (`pathKinds`), with what the stream has
 * brought since. `/v1/activity` reads by Project, not by Task, so the Project's pages are read
 * back from the newest until the Task's filing is found, at most six pages of 500.
 */
export function useTaskPath(projectId: string | undefined, taskId: string | undefined) {
  const history = useQuery({
    queryKey: ["activity", { project: projectId, kind: pathKinds, task: taskId }],
    queryFn: async () => {
      const out: Activity[] = [];
      let before = newestActivity;
      for (let i = 0; i < pathPages; i++) {
        const page = await call(api.GET("/v1/activity", { params: { query: { project: projectId, kind: [...pathKinds], before, limit: 500 } } }));
        out.push(...page.items.filter((e) => e.subject_id === taskId));
        if (out.some((e) => e.kind === "task.filed") || page.first_seq === undefined || page.items.length < 500) break;
        before = page.first_seq;
      }
      return out;
    },
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
