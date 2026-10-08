// The Tasks screens' reads and writes. Keys sit under the shell's roots ("tasks"), so they share
// the cache and an Activity entry refetches them. The Claim trail is the Filter's (useClaimTrails).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, call, type Task } from "@/api/client";
import { keys, useTasks } from "@/api/queries";

/** The query every Tasks screen of a Project reads: its whole list, open and ended. */
export const projectTasksQuery = (project: string) => ({ project });

export function useProjectTasks(project: string) {
  // No Project yet (File a Task opened before the Projects load): nothing to ask.
  return useTasks(projectTasksQuery(project), { enabled: project !== "" });
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
