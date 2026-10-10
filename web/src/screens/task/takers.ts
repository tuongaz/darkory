import type { Member, Task, TaskDetail, WorkflowStep } from "@/api/client";
import { allShiftsBusy, liveClaim } from "@/work";

/**
 * Who could take the Task now by its Step's Skill, leaving out whether it is blocked: the
 * Project's Members holding the Skill (the Workflow's takers), less anyone who held it under
 * another Skill (no one judges their own work); with none, its Owner (CONTEXT.md, Takeable).
 */
export function takersOf(detail: Pick<TaskDetail, "task" | "claims">, step: WorkflowStep | undefined): string[] {
  if (detail.task.aimed_at_id) return [detail.task.aimed_at_id];
  if (!step?.skill_id) return [];
  const heldUnderOther = (id: string) => detail.claims.some((c) => c.holder_id === id && c.skill_id !== step.skill_id);
  const by = step.takers.filter((t) => !heldUnderOther(t.id)).map((t) => t.id);
  if (by.length) return by;
  return heldUnderOther(detail.task.owner_id) ? [] : [detail.task.owner_id];
}

/**
 * Whom an open Task nobody holds waits for at its Step: when every Member who could take it there
 * (the Step's takers less anyone who held it under another Skill; the Member it is aimed at)
 * holds as many other Tasks as it runs Shifts, the one whose Shift ends soonest (its Claim lapsing
 * first), else the one holding longest. No one while a taker is free, when the Step has no taker,
 * or when the Task is blocked, at a hold, a Parent or held.
 */
export function waitsFor(
  detail: Pick<TaskDetail, "task" | "claims">,
  step: WorkflowStep | undefined,
  open: readonly Task[],
  members: Map<string, Pick<Member, "agent">>,
  now: number,
): string | undefined {
  const { task } = detail;
  if (task.state !== "open" || task.blocked || task.subtask_counts || liveClaim(task, now) || !step?.skill_id) return undefined;
  const heldUnderOther = (id: string) => detail.claims.some((c) => c.holder_id === id && c.skill_id !== step.skill_id);
  const takers = task.aimed_at_id ? [task.aimed_at_id] : step.takers.map((t) => t.id).filter((id) => !heldUnderOther(id));
  if (takers.length === 0) return undefined;
  const claimsOf = (id: string) => open.filter((t) => t.id !== task.id).flatMap((t) => (liveClaim(t, now)?.holder_id === id ? [liveClaim(t, now)!] : []));
  if (!takers.every((id) => allShiftsBusy(members.get(id), claimsOf(id).length))) return undefined;
  const soonest = (id: string) => Math.min(...claimsOf(id).map((c) => (c.expires_at ? Date.parse(c.expires_at) : Infinity)));
  const longest = (id: string) => Math.min(...claimsOf(id).map((c) => Date.parse(c.started_at)));
  return [...takers].sort((a, b) => soonest(a) - soonest(b) || longest(a) - longest(b))[0];
}
