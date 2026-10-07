import type { Claim, Member, Task } from "./api/client";

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
 * The glyph for a Task from its state and Claim, until Statuses reach /v1: done and dropped as
 * themselves, held as In progress, any other open Task as Todo.
 */
export function taskGlyph(task: Task, now: number): "todo" | "inprogress" | "done" | "dropped" {
  if (task.state !== "open") return task.state;
  return liveClaim(task, now) ? "inprogress" : "todo";
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
