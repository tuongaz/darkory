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
 * Who could take an open Task at its Step now, as Darkory's takers rule says: the Member it is
 * aimed at, else the Step's takers less anyone who held it under another Skill (no one judges
 * their own work; `heldUnder` gives the Skills a Member held it under). No owner fallback: a Step
 * with no taker has none.
 */
export function stepTakers(task: Pick<Task, "aimed_at_id">, step: Pick<WorkflowStep, "skill_id" | "takers">, heldUnder: (member: string) => readonly (string | undefined)[]): string[] {
  if (task.aimed_at_id) return [task.aimed_at_id];
  return step.takers.map((t) => t.id).filter((id) => !heldUnder(id).some((skill) => skill !== step.skill_id));
}

/** The live Claims a Member holds on open Tasks other than `except`. */
function claimsOf(id: string, open: readonly Task[], except: string, now: number) {
  return open.filter((t) => t.id !== except).flatMap((t) => {
    const c = liveClaim(t, now);
    return c?.holder_id === id ? [c] : [];
  });
}

/** Whether every one of `takers` holds as many other Tasks as it runs Shifts, so `task` waits. */
export function everyTakerBusy(takers: readonly string[], task: Pick<Task, "id">, open: readonly Task[], members: Map<string, Pick<Member, "agent">>, now: number): boolean {
  return takers.length > 0 && takers.every((id) => allShiftsBusy(members.get(id), claimsOf(id, open, task.id, now).length));
}

/** Whether an open Task stands where a taker could take it: not blocked, at a hold, a Parent or held. */
export function waitsAtStep(task: Task, step: WorkflowStep | undefined, now: number): step is WorkflowStep {
  return task.state === "open" && !task.blocked && !task.subtask_counts && !liveClaim(task, now) && !!step?.skill_id;
}

/**
 * Whom an open Task nobody holds waits for at its Step: when every taker (`stepTakers`) holds as
 * many other Tasks as it runs Shifts, the one whose Shift ends soonest (its Claim lapsing first),
 * else the one holding longest. No one while a taker is free, when the Step has no taker, or when
 * the Task does not wait at its Step (`waitsAtStep`).
 */
export function waitsFor(
  detail: Pick<TaskDetail, "task" | "claims">,
  step: WorkflowStep | undefined,
  open: readonly Task[],
  members: Map<string, Pick<Member, "agent">>,
  now: number,
): string | undefined {
  const { task } = detail;
  if (!waitsAtStep(task, step, now)) return undefined;
  const takers = stepTakers(task, step, (id) => detail.claims.filter((c) => c.holder_id === id).map((c) => c.skill_id));
  if (!everyTakerBusy(takers, task, open, members, now)) return undefined;
  const claims = (id: string) => claimsOf(id, open, task.id, now);
  const soonest = (id: string) => Math.min(...claims(id).map((c) => (c.expires_at ? Date.parse(c.expires_at) : Infinity)));
  const longest = (id: string) => Math.min(...claims(id).map((c) => Date.parse(c.started_at)));
  return [...takers].sort((a, b) => soonest(a) - soonest(b) || longest(a) - longest(b))[0];
}
