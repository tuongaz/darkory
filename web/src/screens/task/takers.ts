import type { TaskDetail, WorkflowStep } from "@/api/client";

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
