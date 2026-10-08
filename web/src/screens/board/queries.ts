// The Tasks screens' reads and writes. Keys sit under the shell's roots ("tasks", "activity"), so
// they share the cache and an Activity entry refetches them; Activity history is never refetched,
// so the trail joins what the stream has brought since.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, call, type Task } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { keys, newestActivity, useTasks } from "@/api/queries";
import { taskTrails, trailKinds } from "./derive";

/** The query every Tasks screen of a Project reads: its whole list, open and ended. */
export const projectTasksQuery = (project: string) => ({ project });

export function useProjectTasks(project: string) {
  return useTasks(projectTasksQuery(project));
}

/**
 * Each of a Project's Tasks' trail (a lapse since its last Claim, its Evidence count): the newest
 * 500 such entries of the Project's Activity, with what the stream has brought since. `/v1/tasks`
 * carries neither.
 */
export function useTaskTrails(project: string) {
  const query = { project, kind: [...trailKinds], limit: 500 };
  const history = useQuery({
    queryKey: keys.activity(query),
    queryFn: () => call(api.GET("/v1/activity", { params: { query: { ...query, before: newestActivity } } })).then((r) => r.items),
  });
  const live = useLiveEntries();
  return useMemo(() => {
    const kinds: readonly string[] = trailKinds;
    return taskTrails([...(history.data ?? []), ...live.filter((e) => kinds.includes(e.kind))]);
  }, [history.data, live]);
}

/**
 * Moves a Task to a Step by hand (`POST /v1/tasks/{task}/step`). The card shows at its new Step at
 * once and goes back if the move is refused.
 */
export function useMoveTask(project: string) {
  const qc = useQueryClient();
  const key = keys.tasks(projectTasksQuery(project));
  return useMutation({
    mutationFn: ({ task, step }: { task: Task; step: string }) =>
      call(api.POST("/v1/tasks/{task}/step", { params: { path: { task: task.id } }, body: { step } })),
    onMutate: async ({ task, step }) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<Task[]>(key);
      qc.setQueryData<Task[]>(key, (old) =>
        old?.map((t) => (t.id === task.id ? { ...t, step_id: step, aimed_at_id: undefined, claim: undefined, step_since: new Date().toISOString() } : t)),
      );
      return { before };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
    },
    onSuccess: (moved) => {
      qc.setQueryData<Task[]>(key, (old) => old?.map((t) => (t.id === moved.id ? moved : t)));
    },
  });
}
