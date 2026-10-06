import { useQueries, useQuery } from "@tanstack/react-query";
import { api, call, type Member, type TaskDetail } from "@/api/client";
import { keys, useDirectory } from "@/api/queries";
import { whoCanTake } from "./takers";

// The reads of the Task and Feature screens. Every key sits under a root queries.ts already
// names, so an Activity entry about the record refetches it.

/** A Task with its record, by key or id. The peek, the page and the Feature page share it. */
export function useTask(ref: string) {
  return useQuery({
    queryKey: keys.task(ref),
    queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: ref } } })),
  });
}

/** Many Tasks' records at once: the Feature page merges its Tasks' Evidence and marks. */
export function useTasks(refs: string[]) {
  return useQueries({
    queries: refs.map((ref) => ({
      queryKey: keys.task(ref),
      queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: ref } } })),
    })),
    combine: (results) => ({
      byKey: new Map(results.flatMap((r) => (r.data ? [[r.data.task.key, r.data] as [string, TaskDetail]] : []))),
      pending: results.some((r) => r.isPending),
    }),
  });
}

/** The Organisation's Statuses, in their order. Under the `tasks` root: `statuses.changed` refreshes work. */
export function useStatuses() {
  return useQuery({
    queryKey: ["tasks", { statuses: true }],
    queryFn: () => call(api.GET("/v1/statuses")).then((r) => r.items),
    staleTime: 60_000,
  });
}

/** The ids of the Tasks the signed-in Member can take now: Claim shows only on those. */
export function useTakeable() {
  return useQuery({
    queryKey: keys.takeable,
    queryFn: () => call(api.GET("/v1/tasks/takeable", { params: { query: { limit: 500 } } })).then((r) => new Set(r.items.map((t) => t.id))),
  });
}

export function useFeature(ref: string) {
  return useQuery({
    queryKey: keys.feature(ref),
    queryFn: () => call(api.GET("/v1/features/{feature}", { params: { path: { feature: ref } } })),
  });
}

/** A Feature's Observations: the unreviewed ones, or with `all` every one. */
export function useFeatureObservations(ref: string, all = false) {
  return useQuery({
    queryKey: [...keys.featureObservations(ref), { all }],
    queryFn: () =>
      call(api.GET("/v1/features/{feature}/observations", { params: { path: { feature: ref }, query: { reviewed: all } } })).then((r) => r.items),
  });
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

/** A Team's Members, for who could take a Task. */
export function useTeamMembers(ref: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.team(ref ?? ""),
    queryFn: () => call(api.GET("/v1/teams/{team}", { params: { path: { team: ref! } } })),
    enabled: enabled && !!ref,
    select: (d) => d.members,
  });
}

/** The Skills of each of `members`, by Member id; undefined until every one has answered. */
export function useMemberSkills(members: Member[], enabled = true) {
  return useQueries({
    queries: members.map((m) => ({
      queryKey: keys.member(m.id),
      queryFn: () => call(api.GET("/v1/members/{member}", { params: { path: { member: m.id } } })),
      enabled,
    })),
    combine: (results) =>
      results.every((r) => r.data)
        ? new Map(results.map((r) => [r.data!.member.id, new Set(r.data!.skills.map((s) => s.id))]))
        : undefined,
  });
}

/**
 * Who could take the Task by `skillId` (default: the Skill it needs now) or by its aim, leaving
 * out whether it is blocked: Member ids, or undefined while their Skills load.
 */
export function useTakers(detail: TaskDetail, skillId?: string): string[] | undefined {
  const { task, feature, claims } = detail;
  const want = skillId ?? task.skill_id;
  const aimedAt = skillId ? undefined : task.aimed_at_id;
  const { skills, memberList } = useDirectory();
  // skill-review is taken from any Team; every other Skill from the Feature's.
  const anyTeam = skills.get(want ?? "")?.name === "skill-review";
  const team = useTeamMembers(feature.team_id, !aimedAt && !anyTeam);
  const pool = aimedAt || !want ? [] : anyTeam ? memberList : (team.data ?? []);
  const skillsOf = useMemberSkills(pool, pool.length > 0);
  if (aimedAt) return [aimedAt];
  if (!want) return undefined;
  if (!anyTeam && !team.data) return undefined;
  if (!skillsOf) return undefined;
  return whoCanTake({ skillId: want, pool, skillsOf, claims, owner: feature.owner_id });
}
