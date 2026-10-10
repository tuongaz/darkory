import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { MemberKind, Skill } from "@/api/client";
import { api, call } from "@/api/client";
import { keys, useMembers, useProject } from "@/api/queries";

/** A Member who could take a Step's Tasks by its Skill. */
export type Holder = { id: string; name: string; kind: MemberKind };

/** The skill-review Skill, whose takers are the Organisation's, not the Project's. */
export const orgWide = (skill: Pick<Skill, "name" | "builtin">) => skill.builtin && skill.name === "skill-review";

/** Every active Member with their Skills, and who is in the Project: what who takes a Step is read from. */
export type Roster = { members: (Holder & { skills: ReadonlySet<string> })[]; inProject: ReadonlySet<string> };

/** Each Member's detail as read, in order: one array while none of them changes (a stable `combine`). */
const detailsOf = <T,>(results: { data?: T }[]) => results.map((r) => r.data);

/** The Project's roster, read from each active Member's Skills; undefined until known. The same object until a read changes. */
export function useRoster(project: string): Roster | undefined {
  const members = useMembers();
  const detail = useProject(project);
  const active = (members.data ?? []).filter((m) => !m.deactivated_at);
  const details = useQueries({
    queries: active.map((m) => ({
      queryKey: keys.member(m.id),
      queryFn: () => call(api.GET("/v1/members/{member}", { params: { path: { member: m.id } } })),
    })),
    combine: detailsOf,
  });
  return useMemo(() => {
    if (!members.data || !detail.data || !details.every((d) => d)) return undefined;
    return {
      members: details.map((d) => ({ id: d!.member.id, name: d!.member.name, kind: d!.member.kind, skills: new Set(d!.skills.map((s) => s.id)) })),
      inProject: new Set((detail.data.members ?? []).map((m) => m.id)),
    };
  }, [members.data, detail.data, details]);
}
