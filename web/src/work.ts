import type { Claim, Member, Task } from "./api/client";
import { glyphFor, type MemberKind, type SessionState, type WorkGlyph } from "./lib/work";

/** The Task's Claim while it holds at `now` (Unix ms): not ended and not past its expiry. */
export function liveClaim(task: Task, now: number): Claim | undefined {
  const c = task.claim;
  if (!c || c.ended_at || task.state !== "open") return undefined;
  if (c.expires_at && new Date(c.expires_at).getTime() <= now) return undefined;
  return c;
}

export function boundTo(claim: Claim): string {
  return claim.heartbeat_timeout_seconds ? "Session-bound" : "Member-bound";
}

/** Whether the Task waits at a hold: a Step that carries no Skill, so no one is offered it. */
export function atHold(task: Pick<Task, "step_id" | "skill_id">): boolean {
  return !!task.step_id && !task.skill_id;
}

/**
 * A Task record's WorkGlyph: ended, a Parent's progress, its live Claim in the holder's kind (and
 * the Runner session's state, when one runs it), blocked, at a hold, or waiting (`glyphFor`).
 */
export function taskWorkGlyph(
  task: Task,
  now: number,
  kindOf: (memberId: string) => MemberKind | undefined,
  session?: SessionState,
): WorkGlyph {
  const claim = liveClaim(task, now);
  return glyphFor({
    state: task.state,
    held: !!claim,
    holderKind: claim && kindOf(claim.holder_id),
    session: claim ? session : undefined,
    blocked: task.blocked,
    atHold: atHold(task),
    counts: task.subtask_counts,
  });
}

const kindLabels = { breakdown: "Break down", acceptance: "Acceptance", retrospective: "Retrospective" } as const;

/**
 * The kind a pill names on a Subtask Darkory files itself (a Breakdown, an Acceptance, a
 * Retrospective), or nothing when the title already says it: Darkory files them as "Break down:
 * Checkout", "Acceptance: Checkout" and "Retrospective: Checkout".
 */
export function kindLabel(task: Pick<Task, "kind" | "title">): (typeof kindLabels)[keyof typeof kindLabels] | undefined {
  if (task.kind === "work") return undefined;
  const label = kindLabels[task.kind];
  return task.title.toLowerCase().startsWith(`${label.toLowerCase()}:`) ? undefined : label;
}

/** The agent Members holding a live Claim at `now` on `tasks`: who the sidebar counts as live. */
export function liveAgents(tasks: Task[], members: Map<string, Member>, now: number): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    const c = liveClaim(t, now);
    if (c && members.get(c.holder_id)?.kind === "agent") ids.add(c.holder_id);
  }
  return ids;
}
