import { useQueries } from "@tanstack/react-query";
import type { MemberKind, Skill } from "@/api/client";
import { api, call } from "@/api/client";
import { keys, useMembers, useProject } from "@/api/queries";

/** A Member who could take a Step's Tasks by its Skill. */
export type Holder = { id: string; name: string; kind: MemberKind };

/** The skill-review Skill, whose takers are the Organisation's, not the Project's. */
export const orgWide = (skill: Pick<Skill, "name" | "builtin">) => skill.builtin && skill.name === "skill-review";

/**
 * Who could take a Task at a Step carrying each Skill: the Project's active Members holding it, or
 * the Organisation's for skill-review. Read from each Member's Skills; undefined until known.
 */
export function useSkillHolders(project: string, skills: Skill[] | undefined) {
  const members = useMembers();
  const detail = useProject(project);
  const active = (members.data ?? []).filter((m) => !m.deactivated_at);
  const details = useQueries({
    queries: active.map((m) => ({
      queryKey: keys.member(m.id),
      queryFn: () => call(api.GET("/v1/members/{member}", { params: { path: { member: m.id } } })),
    })),
  });
  const ready = !!members.data && !!detail.data && details.every((d) => d.data);
  if (!ready || !skills) return undefined;
  const inProject = new Set((detail.data?.members ?? []).map((m) => m.id));
  const holders = new Map<string, Holder[]>();
  for (const { data: d } of details) {
    if (!d) continue;
    for (const s of d.skills) {
      if (!orgWide(s) && !inProject.has(d.member.id)) continue;
      holders.set(s.id, [...(holders.get(s.id) ?? []), { id: d.member.id, name: d.member.name, kind: d.member.kind }]);
    }
  }
  for (const list of holders.values()) list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "human" ? -1 : 1));
  return holders;
}

