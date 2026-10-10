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
 * Whom an open Task nobody holds waits for at its Step: its takers, when every one of them holds
 * as many other Tasks as it runs Shifts; none while one is free, or when the Task is blocked, at a
 * hold, or held.
 */
export function waitsFor(
  detail: Pick<TaskDetail, "task" | "claims">,
  step: WorkflowStep | undefined,
  open: readonly Task[],
  members: Map<string, Pick<Member, "agent">>,
  now: number,
): string[] {
  const { task } = detail;
  if (task.state !== "open" || task.blocked || task.subtask_counts || liveClaim(task, now) || !step?.skill_id) return [];
  const takers = takersOf(detail, step);
  if (takers.length === 0) return [];
  const holds = (id: string) => open.filter((t) => t.id !== task.id && liveClaim(t, now)?.holder_id === id).length;
  return takers.every((id) => allShiftsBusy(members.get(id), holds(id))) ? takers : [];
}
