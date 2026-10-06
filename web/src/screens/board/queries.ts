// The Board screens' reads and writes. Keys sit under the shell's roots ("tasks", "features"), so
// an Activity entry refetches them; the two that do not are kept live here.
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api, call, type Activity, type Feature, type Task } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { allPages } from "@/api/pages";
import { keys } from "@/api/queries";
import { claimTrails, inOrder, trailKinds, type Status } from "./derive";

export const boardKeys = {
  statuses: ["statuses"] as const,
  teamTasks: (team: string) => ["tasks", { team }] as const,
  teamFeatures: (team: string) => keys.features(team),
  trail: (team: string) => ["activity", { team, kinds: trailKinds }] as const,
};

/**
 * The Organisation's Statuses in their order. The shell refetches work on `statuses.changed` but
 * has no root for the list itself, so this refetches it when one arrives.
 */
export function useStatuses() {
  const qc = useQueryClient();
  const changed = useLiveEntries().find((e) => e.kind === "statuses.changed")?.seq;
  useEffect(() => {
    if (changed !== undefined) void qc.invalidateQueries({ queryKey: boardKeys.statuses });
  }, [changed, qc]);
  return useQuery({
    queryKey: boardKeys.statuses,
    queryFn: () => call(api.GET("/v1/statuses")).then((r) => inOrder(r.items)),
  });
}

/** Every Task of a Team, open and ended, in `next` order. */
export function useTeamTasks(team: string | undefined) {
  return useQuery({
    queryKey: boardKeys.teamTasks(team ?? ""),
    queryFn: () => allPages<Task>((cursor) => call(api.GET("/v1/tasks", { params: { query: { team, limit: 500, cursor } } }))),
    enabled: !!team,
  });
}

/** Every Feature of a Team, open and ended, in Rank order. */
export function useTeamFeatures(team: string | undefined) {
  return useQuery({
    queryKey: boardKeys.teamFeatures(team ?? ""),
    queryFn: () =>
      allPages<Feature>((cursor) => call(api.GET("/v1/features", { params: { query: { team, limit: 500, cursor } } }))).then((items) =>
        [...items].sort((a, b) => a.rank - b.rank),
      ),
    enabled: !!team,
  });
}

const latest = 9007199254740991;

/**
 * Who last claimed, lapsed and completed each of a Team's Tasks: the latest 500 such entries of
 * the Activity, joined by what the stream has brought since.
 */
export function useClaimTrails(team: string | undefined) {
  const history = useQuery({
    queryKey: boardKeys.trail(team ?? ""),
    queryFn: () =>
      call(api.GET("/v1/activity", { params: { query: { team, kind: [...trailKinds], before: latest, limit: 500 } } })).then((r) => r.items),
    enabled: !!team,
  });
  const live = useLiveEntries();
  return useMemo(() => {
    const kinds: readonly string[] = trailKinds;
    const fresh = live.filter((e: Activity) => kinds.includes(e.kind));
    return claimTrails([...(history.data ?? []), ...fresh]);
  }, [history.data, live]);
}

/** The Tasks the signed-in Member can take now; read when a refused drag needs to know. */
export function fetchTakeable(qc: QueryClient): Promise<Task[]> {
  return qc.fetchQuery({
    queryKey: keys.takeable,
    queryFn: () => call(api.GET("/v1/tasks/takeable", { params: { query: { limit: 500 } } })).then((r) => r.items),
  });
}

/**
 * Moves a Task to an open-kind Status. A move between open kinds shows at once and is undone if
 * refused; a drop on Done or Dropped waits for the answer, which refuses it.
 */
export function useSetStatus(team: string) {
  const qc = useQueryClient();
  const key = boardKeys.teamTasks(team);
  return useMutation({
    mutationFn: ({ task, status }: { task: Task; status: Status }) =>
      call(api.POST("/v1/tasks/{task}/status", { params: { path: { task: task.key } }, body: { status: status.id } })),
    onMutate: async ({ task, status }) => {
      if (status.kind === "done" || status.kind === "dropped") return { before: undefined };
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<Task[]>(key);
      qc.setQueryData<Task[]>(key, (old) => old?.map((t) => (t.id === task.id ? { ...t, status_id: status.id } : t)));
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

/** Claims a Task for the signed-in Member, with no heartbeat timeout: a browser's Claim. */
export function useClaim() {
  return useMutation({
    mutationFn: (taskKey: string) => call(api.POST("/v1/tasks/{task}/claim", { params: { path: { task: taskKey } }, body: {} })),
  });
}

/** Moves a Feature to a position in its Team's Rank, shown at once and undone if refused. */
export function useRankFeature(team: string) {
  const qc = useQueryClient();
  const key = boardKeys.teamFeatures(team);
  return useMutation({
    mutationFn: ({ feature, position }: { feature: Feature; position: number; next: Feature[] }) =>
      call(api.POST("/v1/features/{feature}/rank", { params: { path: { feature: feature.key } }, body: { position } })),
    onMutate: async ({ next }) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<Feature[]>(key);
      qc.setQueryData<Feature[]>(key, next);
      return { before };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
    },
  });
}
