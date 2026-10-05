import { createContext, useContext } from "react";
import type { Me, Member } from "./api/client";

export const MeContext = createContext<Me | null>(null);

/** The signed-in Member, from /v1/me. Only rendered inside the signed-in shell. */
export function useCurrentMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("MeContext is not provided");
  return me;
}

/** Whether `who` is `of` or directs `of` along the Reporting line, at any distance. */
export function isOnReportingLine(members: Map<string, Member>, who: string, of: string): boolean {
  const seen = new Set<string>();
  for (let id: string | undefined = of; id && !seen.has(id); id = members.get(id)?.manager_id) {
    if (id === who) return true;
    seen.add(id);
  }
  return false;
}
