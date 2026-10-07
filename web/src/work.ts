import type { Claim, Member, Task } from "./api/client";
import { glyphFor, type MemberKind, type WorkGlyph } from "./lib/work";

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

/**
 * A Task's WorkGlyph from its record: its state, its live Claim and whether it is blocked. Steps
 * and Parents are not on /v1 yet, so it never draws a hold or a Parent's progress, and an agent's
 * live Claim draws as running.
 */
export function taskWorkGlyph(task: Task, now: number, kindOf: (memberId: string) => MemberKind | undefined): WorkGlyph {
  const claim = liveClaim(task, now);
  return glyphFor({ state: task.state, held: !!claim, holderKind: claim && kindOf(claim.holder_id), blocked: task.blocked });
}

const kindLabels = { breakdown: "Break down", retrospective: "Retrospective" } as const;

/**
 * The kind a pill names on a Break down or a Retrospective, or nothing when the title already
 * says it: Darkory files them as "Break down: Checkout" and "Retrospective: Checkout".
 */
export function kindLabel(task: Pick<Task, "kind" | "title">): "Break down" | "Retrospective" | undefined {
  if (task.kind === "work") return undefined;
  const label = kindLabels[task.kind];
  return task.title.toLowerCase().startsWith(`${label.toLowerCase()}:`) ? undefined : label;
}

/** The agent Members holding a live Claim at `now`: who the sidebar counts as live. */
export function liveAgents(tasks: Task[], members: Map<string, Member>, now: number): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    const c = liveClaim(t, now);
    if (c && members.get(c.holder_id)?.kind === "agent") ids.add(c.holder_id);
  }
  return ids;
}
