import { useQueries, useQuery } from "@tanstack/react-query";
import { api, call, type MemberDetail, type TaskDetail } from "@/api/client";
import { keys, useMembers, useTasks } from "@/api/queries";

// Settings' reads. Each key starts with a root of src/api/queries.ts, so Activity keeps it live.

function getMember(ref: string) {
  return call(api.GET("/v1/members/{member}", { params: { path: { member: ref } } }));
}

/**
 * Every Member's Projects and Skills, by Member id. /v1 lists Members without them, so this reads
 * each Member's record: the Members and Agents tables and a Skill's holders derive from it.
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

/** The open Tasks a Member holds a live Claim on. */
export function useHeldTasks(member: string) {
  return useTasks({ holder: member, state: "open" });
}

/** The open Tasks at a Step carrying a Skill (by id): who is waiting for its holders. */
export function useSkillTasks(skillId: string | undefined) {
  return useTasks({ state: "open", filter: [`skill:is:${skillId}`] }, { enabled: !!skillId });
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
 * The open Retrospectives' records. /v1 lists no proposals on their own, so a Skill's pending
 * proposals are found on the open Retrospectives that carry them (`TaskDetail.proposals`).
 */
export function useRetrospectives(): { details: TaskDetail[]; pending: boolean } {
  const open = useTasks({ state: "open", filter: ["kind:is:retrospective"] });
  const details = useQueries({
    queries: (open.data ?? []).map((t) => ({
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

/** How many Tasks, open or ended, carry a Label: what deleting it takes away. Read when asked. */
export function useLabelUse(label: string | undefined) {
  return useTasks({ filter: [`label:in:${label}`] }, { enabled: !!label });
}
