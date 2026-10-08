import { useQueries, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { api, call, type Activity, type ActivityKind, type ActivityPage, type Project, type Task } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { keys, newestActivity, useDirectory, useTasks } from "@/api/queries";
import { useWorkflows } from "@/components/filters/useTaskFilter";

// The reads of the Inbox, My work, Agents and Activity. Each key sits under the root that names
// what it reads, so an Activity entry about it marks it stale (src/api/queries.ts).

/** The most entries one Activity read returns. */
export const activityLimit = 500;

/**
 * Marks `queryKey` stale whenever an entry matching `when` arrives on the stream: for reads under
 * a root the shell does not refresh on that kind (a Member's Sessions on a Claim).
 */
export function useStaleOn(queryKey: QueryKey, when: (e: Activity) => boolean) {
  const qc = useQueryClient();
  const live = useLiveEntries();
  const seen = useRef(live[0]?.seq ?? 0);
  const hash = JSON.stringify(queryKey);
  const test = useRef(when);
  useEffect(() => {
    test.current = when;
  });
  useEffect(() => {
    const fresh = live.filter((e) => e.seq > seen.current);
    if (fresh.length === 0) return;
    seen.current = live[0].seq;
    if (fresh.some((e) => test.current(e))) void qc.invalidateQueries({ queryKey: JSON.parse(hash) as QueryKey });
  }, [live, qc, hash]);
}

/** The open Tasks aimed at a Member by name, across Projects. */
export function useAimedAt(member: string) {
  return useTasks({ aimed_at: member, state: "open" });
}

/** The Tasks a Member holds a live Claim on, across Projects. */
export function useHeldBy(member: string) {
  return useTasks({ holder: member, state: "open" });
}

/** The open Tasks a Member owns, Parents and Subtasks included, across Projects. */
export function useOwnedOpen(member: string) {
  return useTasks({ state: "open", filter: [`owner:is:${member}`] });
}

/** Every Task of a Project, or of the Organisation with none: the subjects of Activity entries. */
export function useTaskMap(project?: string): Map<string, Task> {
  const q = useTasks(project ? { project } : {});
  return useMemo(() => new Map((q.data ?? []).map((t) => [t.id, t])), [q.data]);
}

/** The full records of these Tasks, by key: a Parent's Subtasks, a Retrospective's proposals. */
export function useTaskDetails(refs: string[]) {
  return useQueries({
    queries: refs.map((ref) => ({
      queryKey: keys.task(ref),
      queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: ref } } })),
    })),
  });
}

/** Each Member's Projects, Skills and reports. */
export function useMemberDetails(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.member(id),
      queryFn: () => call(api.GET("/v1/members/{member}", { params: { path: { member: id } } })),
    })),
  });
}

/**
 * Each Member's open Sessions. Only an admin may read another Member's, so `enabled` is the
 * caller's admin mark. A Session opens without Activity, but a Claim names the Session that made
 * it, so Task entries mark these stale too.
 */
export function useSessions(ids: string[], enabled: boolean) {
  useStaleOn(["member"], (e) => enabled && e.subject_type === "task");
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.memberSessions(id),
      queryFn: () => call(api.GET("/v1/members/{member}/sessions", { params: { path: { member: id }, query: { limit: 500 } } })).then((r) => r.items),
      enabled,
    })),
  });
}

/**
 * The newest Activity matching `filter` (up to `activityLimit` entries) together with whatever
 * the stream has brought since that matches `keep`, newest first. `complete` says the read held
 * every matching entry.
 */
export function useRecentActivity(
  filter: { member?: string; kind?: ActivityKind[]; project?: string },
  keep: (e: Activity) => boolean,
  enabled = true,
) {
  const live = useLiveEntries();
  const query = { ...filter, limit: activityLimit };
  const q = useQuery({
    queryKey: keys.activity(query),
    queryFn: () => call(api.GET("/v1/activity", { params: { query: { ...query, before: newestActivity } } })),
    enabled,
  });
  const bySeq = new Map<number, Activity>();
  for (const e of q.data?.items ?? []) bySeq.set(e.seq, e);
  for (const e of live) if (keep(e)) bySeq.set(e.seq, e);
  const entries = [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  return { query: q, entries, complete: q.isSuccess && q.data.items.length < activityLimit };
}

export type StepName = { name: string; projectId: string; skillId?: string };

/** Every Project's Steps by id, with their names: where a row says what Step a Task is at. */
export function useStepNames(projects?: Project[]): Map<string, StepName> {
  const dir = useDirectory();
  const list = projects ?? dir.projectList;
  const { workflows } = useWorkflows(list);
  return useMemo(() => {
    const out = new Map<string, StepName>();
    for (const [projectId, wf] of workflows) for (const s of wf?.steps ?? []) out.set(s.id, { name: s.name, projectId, skillId: s.skill_id });
    return out;
  }, [workflows]);
}

/** A page of the Activity page's history: its entries that pass the filters, and whether more are before it. */
export type HistoryPage = ActivityPage & { more: boolean; scanned: number };

/**
 * One page of a Project's Activity before `before`, narrowed by the Activity page's filters:
 * `member` and `kind` by /v1, `task` (an id) here, from the `limit` entries read, so a page may
 * hold none of the Task's entries and still not be the last. This is the one place that knows
 * /v1/activity has no `task`: when it does, `task` goes into the query and the narrowing goes.
 */
export async function activityHistoryPage(
  filter: { project: string; member?: string; kind?: ActivityKind; task?: string },
  before: number,
  limit: number,
): Promise<HistoryPage> {
  const { task, kind, ...rest } = filter;
  const page = await call(api.GET("/v1/activity", { params: { query: { ...rest, kind: kind ? [kind] : undefined, before, limit } } }));
  const more = page.items.length >= limit && page.first_seq !== undefined && page.first_seq > 1;
  const items = task ? page.items.filter((e) => e.subject_type === "task" && e.subject_id === task) : page.items;
  return { ...page, items, more, scanned: page.items.length };
}
