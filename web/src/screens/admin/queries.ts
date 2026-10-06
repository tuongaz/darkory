import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, call, type MemberDetail, type Task, type TaskDetail, type TeamDetail } from "@/api/client";
import { allPages } from "@/api/pages";
import { keys, useAllTasks, useMembers, useOpenTasks } from "@/api/queries";

// Admin's reads. Each key starts with a root of src/api/queries.ts, so Activity keeps it live.

function getMember(ref: string) {
  return call(api.GET("/v1/members/{member}", { params: { path: { member: ref } } }));
}

function getTeam(ref: string) {
  return call(api.GET("/v1/teams/{team}", { params: { path: { team: ref } } }));
}

export function useMemberDetail(ref: string) {
  return useQuery({ queryKey: keys.member(ref), queryFn: () => getMember(ref) });
}

/**
 * Every Member's Teams and Skills, by Member id. /v1 lists Members without them, so this reads
 * each Member's record: the Members table, a Skill's holders and a Team's rows derive from it.
 */
export function useMemberDetails() {
  const members = useMembers();
  const details = useQueries({
    queries: (members.data ?? []).map((m) => ({ queryKey: keys.member(m.id), queryFn: () => getMember(m.id) })),
    combine: (results) => ({
      byId: new Map<string, MemberDetail>(results.flatMap((r) => (r.data ? [[r.data.member.id, r.data]] : []))),
      pending: results.some((r) => r.isPending),
    }),
  });
  return { members, details: details.byId, pending: members.isPending || details.pending };
}

export function useTeamDetail(ref: string) {
  return useQuery({ queryKey: keys.team(ref), queryFn: () => getTeam(ref) });
}

/** Every Team's Members, by Team id, for the Teams table. */
export function useTeamDetails(teams: { key: string }[]) {
  return useQueries({
    queries: teams.map((t) => ({ queryKey: keys.team(t.key), queryFn: () => getTeam(t.key) })),
    combine: (results) => new Map<string, TeamDetail>(results.flatMap((r) => (r.data ? [[r.data.team.id, r.data]] : []))),
  });
}

export function useTokens(member: string) {
  return useQuery({
    queryKey: keys.tokens(member),
    queryFn: () => call(api.GET("/v1/members/{member}/tokens", { params: { path: { member } } })).then((r) => r.items),
  });
}

/** A Member's open Sessions, most recently seen first. */
export function useSessions(member: string) {
  return useQuery({
    queryKey: ["member", member, "sessions"],
    queryFn: () =>
      allPages((cursor) => call(api.GET("/v1/members/{member}/sessions", { params: { path: { member }, query: { limit: 500, cursor } } }))),
  });
}

/** The open Tasks a Member holds a live Claim on. */
export function useHeldTasks(member: string) {
  return useQuery({
    queryKey: keys.heldTasks(member),
    queryFn: () =>
      allPages<Task>((cursor) => call(api.GET("/v1/tasks", { params: { query: { holder: member, state: "open", limit: 500, cursor } } }))),
  });
}

/** The open Tasks that need a Skill now. */
export function useSkillTasks(skill: string) {
  return useQuery({
    queryKey: ["tasks", { state: "open", skill }],
    queryFn: () =>
      allPages<Task>((cursor) => call(api.GET("/v1/tasks", { params: { query: { skill, state: "open", limit: 500, cursor } } }))),
  });
}

export function useSkillDetail(ref: string) {
  return useQuery({
    queryKey: keys.skill(ref),
    queryFn: () => call(api.GET("/v1/skills/{skill}", { params: { path: { skill: ref } } })),
  });
}

export function useSkillVersions(ref: string) {
  return useQuery({
    queryKey: keys.skillVersions(ref),
    queryFn: () => call(api.GET("/v1/skills/{skill}/versions", { params: { path: { skill: ref } } })).then((r) => r.items),
  });
}

/**
 * The Organisation's Statuses, in order. Kept under the "tasks" root, which a `statuses.changed`
 * entry marks stale, so another admin's edit shows without a reload.
 */
export const statusesKey = ["tasks", { statuses: true }] as const;

export function useStatuses() {
  return useQuery({ queryKey: statusesKey, queryFn: () => call(api.GET("/v1/statuses")).then((r) => r.items) });
}

/** How many Tasks are in each Status, by Status id: every Task counted once, from the one listing ⌘K reads too. */
export function useTasksByStatus() {
  const tasks = useAllTasks();
  const counts = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of tasks.data ?? []) n.set(t.status_id, (n.get(t.status_id) ?? 0) + 1);
    return n;
  }, [tasks.data]);
  return { tasks, counts };
}

/**
 * The open Retrospectives' records. /v1 lists no proposals, so a Skill's pending proposal is found
 * on the open Retrospective that carries it.
 */
export function useRetrospectives(): { details: TaskDetail[]; pending: boolean } {
  const open = useOpenTasks();
  const retros = (open.data ?? []).filter((t) => t.kind === "retrospective");
  const details = useQueries({
    queries: retros.map((t) => ({
      queryKey: keys.task(t.key),
      queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: t.key } } })),
    })),
    combine: (results) => ({
      details: results.flatMap((r) => (r.data ? [r.data] : [])),
      pending: results.some((r) => r.isPending),
    }),
  });
  return { details: details.details, pending: open.isPending || details.pending };
}
