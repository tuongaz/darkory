import type { To } from "react-router";
import type { Feature, Member, Task } from "@/api/client";
import { isOnReportingLine } from "@/me";
import type { Session } from "./queries";

/** The search parameter that opens an agent's peek over the Agents page. */
export const agentParam = "agent";

export type AgentAction = { label: string; to: To };

/** A Task's peek over the Agents page, closing any agent's peek: one sheet at a time. */
export function taskOverAgents(key: string): To {
  return { pathname: "/agents", search: `?task=${encodeURIComponent(key)}` };
}

/**
 * What the caller may do about an agent, each sent to the page that already does it: Take back
 * opens the held Task's peek (the Feature owner, or someone on the agent's Reporting line); an
 * admin's Close Session, Revoke token and Deactivate open the agent's Admin page.
 */
export function agentActions({
  agent,
  held,
  me,
  members,
  features,
  sessions,
}: {
  agent: Member;
  held: Task[];
  me: Member;
  members: Map<string, Member>;
  features: Map<string, Feature>;
  sessions: Session[] | undefined;
}): AgentAction[] {
  const actions: AgentAction[] = [];
  const directs = isOnReportingLine(members, me.id, agent.id);
  for (const t of held) {
    if (directs || features.get(t.feature_id)?.owner_id === me.id) {
      actions.push({ label: `Take back ${t.key}`, to: taskOverAgents(t.key) });
    }
  }
  if (me.admin && !agent.deactivated_at) {
    const page = `/admin/members/${encodeURIComponent(agent.name)}`;
    if (sessions === undefined || sessions.length > 0) actions.push({ label: "Close Session", to: page });
    actions.push({ label: "Revoke token", to: page }, { label: "Deactivate", to: page });
  }
  return actions;
}
