import type { To } from "react-router";
import type { Member, Project, RunnerSession, Task } from "@/api/client";
import { projectPath } from "@/app/currentProject";
import { sessionAnchor } from "@/app/peek";
import { isOnReportingLine } from "@/me";

/** The search parameter that opens an agent's peek over the Agents page. */
export const agentParam = "agent";

/**
 * What the ⋯ menu offers about an agent: a page to open, an admin's Pause or Resume of the
 * Runner's sessions for it, or an admin's Nudge or Stop of the session it runs now.
 */
export type AgentAction =
  | { label: string; to: To }
  | { label: string; paused: boolean }
  | { label: string; session: "nudge" | "stop"; taskKey: string };

/** A Task's peek over a Project's Agents page, closing any agent's peek: one sheet at a time. */
export function taskOverAgents(project: Pick<Project, "key">, key: string): { pathname: string; search: string } {
  return { pathname: projectPath(project, "agents"), search: `?task=${encodeURIComponent(key)}` };
}

/** The same peek, opened at its Session panel. */
export function sessionOverAgents(project: Pick<Project, "key">, key: string): To {
  return { ...taskOverAgents(project, key), hash: sessionAnchor };
}

/** An agent's page in Settings, where its command, model and tokens are. */
export function agentSettingsPath(agent: Pick<Member, "name">): string {
  return `/settings/organisation/agents/${encodeURIComponent(agent.name)}`;
}

/**
 * What the caller may do about an agent. Take back opens a held Task's peek (its Owner, or someone
 * on the agent's Reporting line). An admin may Nudge or Stop each Shift the Runner runs for it
 * (named by its Task when it runs several),
 * and Pause or Resume an agent the Runner starts (one with agent settings): paused, it starts no
 * new session, and one running carries on. An admin's Settings opens the agent's page there.
 */
export function agentActions({
  agent,
  held,
  me,
  members,
  shifts,
  project,
}: {
  agent: Member;
  held: Task[];
  me: Member;
  members: Map<string, Member>;
  /** The Shifts the Runner runs for the agent, each with its Task's key when known. */
  shifts: { session: RunnerSession; taskKey: string | undefined }[];
  project: Pick<Project, "key">;
}): AgentAction[] {
  const actions: AgentAction[] = [];
  const directs = isOnReportingLine(members, me.id, agent.id);
  for (const t of held) {
    if (directs || t.owner_id === me.id) actions.push({ label: `Take back ${t.key}`, to: taskOverAgents(project, t.key) });
  }
  const live = me.admin ? shifts.filter((s) => s.taskKey && s.session.state !== "ending") : [];
  for (const { taskKey } of live) {
    const key = taskKey!;
    if (live.length === 1) actions.push({ label: "Nudge", session: "nudge", taskKey: key }, { label: "Stop Shift", session: "stop", taskKey: key });
    else actions.push({ label: `Nudge ${key}`, session: "nudge", taskKey: key }, { label: `Stop ${key}`, session: "stop", taskKey: key });
  }
  if (me.admin && agent.agent && !agent.deactivated_at) {
    actions.push(agent.agent.paused ? { label: "Resume", paused: false } : { label: "Pause", paused: true });
  }
  if (me.admin) actions.push({ label: "Open in Settings", to: agentSettingsPath(agent) });
  return actions;
}
