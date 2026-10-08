// Binds the record to the Subtask graph's shapes (components/workflow/graph.ts): a Parent's
// Subtasks over its Project's Steps.
import type { Member, RunnerSession, Skill, Task, WorkflowStep } from "@/api/client";
import type { GraphStep, GraphSubtask } from "@/components/workflow/graph";
import { workingOf } from "@/lib/work";
import { liveClaim } from "@/work";

/** The Workflow's Steps, in order, as the graph's columns. */
export function graphSteps(steps: readonly WorkflowStep[], skills: Map<string, Skill>): GraphStep[] {
  return [...steps]
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const skill = s.skill_id ? skills.get(s.skill_id) : undefined;
      return { id: s.id, name: s.name, skill: skill && { id: skill.id, name: skill.name } };
    });
}

/**
 * A Parent's Subtasks as the graph draws them: each at its Step (none when aimed at a Member or
 * ended), its holder under a live Claim and how they work (an agent's Runner session, a live Claim
 * with no session counting as running; a human's still ring), the Member it is aimed at, and the
 * open Tasks blocking it.
 */
export function graphSubtasks(
  subtasks: readonly Task[],
  ctx: { members: Map<string, Member>; now: number; sessions: Map<string, RunnerSession> },
): GraphSubtask[] {
  return subtasks.map((t) => {
    const claim = liveClaim(t, ctx.now);
    const holder = claim ? ctx.members.get(claim.holder_id) : undefined;
    const aimed = t.aimed_at_id && t.state === "open" ? ctx.members.get(t.aimed_at_id) : undefined;
    return {
      id: t.id,
      key: t.key,
      title: t.title,
      stepId: t.state === "open" ? (t.step_id ?? null) : null,
      state: t.state,
      holder: holder && { name: holder.name, kind: holder.kind },
      working: holder ? workingOf(holder.kind, ctx.sessions.get(t.id)?.state) : undefined,
      aimedAt: aimed && { name: aimed.name, kind: aimed.kind },
      blockedBy: t.state === "open" ? (t.open_blockers ?? []).map((b) => b.id) : [],
      kind: t.kind,
    };
  });
}
