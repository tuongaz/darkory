import { useSearchParams } from "react-router";
import type { Member, Skill } from "@/api/client";

// Settings' addresses. Members are named by id: a name may hold a dot.

export const membersPath = "/settings/organisation/members";
export const agentsPath = "/settings/organisation/agents";

/** A Member's page: an agent's under Agents, where its Runner settings are, a human's under Members. */
export function memberPath(m: Pick<Member, "id" | "kind">): string {
  return `${m.kind === "agent" ? agentsPath : membersPath}/${encodeURIComponent(m.id)}`;
}

export function skillPath(s: Pick<Skill, "name">): string {
  return `/settings/organisation/skills/${encodeURIComponent(s.name)}`;
}

export const skillsPath = "/settings/organisation/skills";

/** `?new=1` opens New Member, `&kind=agent` as an agent. */
export function useNewParam() {
  const [params, setParams] = useSearchParams();
  const open = params.get("new") === "1";
  const setOpen = (o: boolean) =>
    setParams(
      (p) => {
        p.delete("new");
        p.delete("kind");
        if (o) p.set("new", "1");
        return p;
      },
      { replace: !o },
    );
  return { open, setOpen, kind: params.get("kind") === "agent" ? ("agent" as const) : ("human" as const) };
}
