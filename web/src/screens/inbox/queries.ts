import { useQueries, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { api, call, type Activity, type ActivityKind, type Feature, type Task } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { allPages } from "@/api/pages";
import { keys, useAllFeatures, useAllTasks } from "@/api/queries";
import type { components } from "@/api/schema.gen";
import { glyphFor, type Glyph, type StatusKind } from "@/lib/status";

// The reads of the Inbox, My work, Agents and Activity. Each key sits under the root that names
// what it reads, so an Activity entry about it marks it stale (src/api/queries.ts).

/** A Member's open Session, as `GET /v1/members/{member}/sessions` lists it. */
export type Session = components["schemas"]["Session"];

/** A `before` past every entry: reads the newest page of Activity. */
export const newest = Number.MAX_SAFE_INTEGER;

/** The most entries one Activity read returns. */
export const activityLimit = 500;

/**
 * Marks `queryKey` stale whenever an entry matching `when` arrives on the stream: for reads under
 * a root the shell does not refresh on that kind (Statuses, Sessions).
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

export type StatusView = { name: string; kind: StatusKind; glyph: Glyph };

/** The Organisation's Statuses by id, each with the glyph it draws. */
export function useStatuses() {
  useStaleOn(["statuses"], (e) => e.kind === "statuses.changed");
  const q = useQuery({ queryKey: ["statuses"], queryFn: () => call(api.GET("/v1/statuses")).then((r) => r.items) });
  return useMemo(() => {
    const byId = new Map<string, StatusView>();
    const nth = new Map<StatusKind, number>();
    for (const s of q.data ?? []) {
      const n = nth.get(s.kind) ?? 0;
      nth.set(s.kind, n + 1);
      byId.set(s.id, { name: s.name, kind: s.kind, glyph: glyphFor(s.kind, n) });
    }
    return byId;
  }, [q.data]);
}

/** Every Feature by id: Feature names and Ranks on rows. */
export function useFeatureMap(): Map<string, Feature> {
  const q = useAllFeatures();
  return useMemo(() => new Map((q.data ?? []).map((f) => [f.id, f])), [q.data]);
}

/** Every Task by id: the subjects of Activity entries, whose payloads rarely name them. */
export function useTaskMap(): Map<string, Task> {
  const q = useAllTasks();
  return useMemo(() => new Map((q.data ?? []).map((t) => [t.id, t])), [q.data]);
}

export function useAimedAt(member: string) {
  return useQuery({
    queryKey: ["tasks", { aimed_at: member, state: "open" }],
    queryFn: () =>
      allPages<Task>((cursor) => call(api.GET("/v1/tasks", { params: { query: { aimed_at: member, state: "open", limit: 500, cursor } } }))),
  });
}

export function useHeldBy(member: string) {
  return useQuery({
    queryKey: keys.heldTasks(member),
    queryFn: () => allPages<Task>((cursor) => call(api.GET("/v1/tasks", { params: { query: { holder: member, limit: 500, cursor } } }))),
  });
}

/**
 * What the caller can take now, in `next` order: the first 100, as `next` would offer them. Its
 * key is its own under the `takeable` root: the Task screens keep the ids under `keys.takeable`.
 */
export function useTakeable() {
  return useQuery({
    queryKey: [...keys.takeable, { queue: 100 }],
    queryFn: () => call(api.GET("/v1/tasks/takeable", { params: { query: { limit: 100 } } })).then((r) => r.items),
  });
}

export function useOwnedFeatures(member: string) {
  return useQuery({
    queryKey: ["features", { owner: member }],
    queryFn: () =>
      allPages<Feature>((cursor) => call(api.GET("/v1/features", { params: { query: { owner: member, limit: 500, cursor } } }))),
  });
}

/** The full records of these Tasks, by key: a Retrospective's proposal. */
export function useTaskDetails(refs: string[]) {
  return useQueries({
    queries: refs.map((ref) => ({
      queryKey: keys.task(ref),
      queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: ref } } })),
    })),
  });
}

/** Each Member's Teams, Skills and reports. */
export function useMemberDetails(ids: string[]) {
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.member(id),
      queryFn: () => call(api.GET("/v1/members/{member}", { params: { path: { member: id } } })),
    })),
  });
}

const sessionsKey = (member: string) => ["member", "sessions", member] as const;

/**
 * Each Member's open Sessions. Only an admin may read another Member's, so `enabled` is the
 * caller's admin mark. A Session opens without Activity, but a Claim names the Session that made
 * it, so Task entries mark these stale too.
 */
export function useSessions(ids: string[], enabled: boolean) {
  useStaleOn(["member", "sessions"], (e) => enabled && e.subject_type === "task");
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: sessionsKey(id),
      queryFn: () => allPages((cursor) => call(api.GET("/v1/members/{member}/sessions", { params: { path: { member: id }, query: { cursor } } }))),
      enabled,
    })),
  });
}

/** A Member's tokens, newest first: the Member's own, or anyone's for an admin. */
export function useTokens(member: string, enabled: boolean) {
  return useQuery({
    queryKey: [...keys.tokens(member), "items"],
    queryFn: () => call(api.GET("/v1/members/{member}/tokens", { params: { path: { member } } })).then((r) => r.items),
    enabled,
  });
}

/**
 * The newest Activity matching `filter` (up to `activityLimit` entries) together with whatever
 * the stream has brought since that matches `keep`, newest first. `complete` says the read held
 * every matching entry.
 */
export function useRecentActivity(filter: { member?: string; kind?: ActivityKind[] }, keep: (e: Activity) => boolean, enabled = true) {
  const live = useLiveEntries();
  const q = useQuery({
    queryKey: ["activity", "recent", filter],
    queryFn: () => call(api.GET("/v1/activity", { params: { query: { ...filter, before: newest, limit: activityLimit } } })),
    enabled,
  });
  const bySeq = new Map<number, Activity>();
  for (const e of q.data?.items ?? []) bySeq.set(e.seq, e);
  for (const e of live) if (keep(e)) bySeq.set(e.seq, e);
  const entries = [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  return { query: q, entries, complete: q.isSuccess && q.data.items.length < activityLimit };
}
