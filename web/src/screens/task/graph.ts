// Binds the record to the Subtask graph's shapes (components/workflow/graph.ts): a Parent's
// Subtasks over its Project's Steps.
import type { Member, RunnerSession, Skill, Task, WorkflowStep } from "@/api/client";
import type { GraphStep, GraphSubtask, OutsideLink } from "@/components/workflow/graph";
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
 * with no session counting as running; a human's still ring), the Member it is aimed at, the
 * open Tasks blocking it, and the open Tasks outside the Parent it is joined to by a Blocking:
 * its blockers from its own record, the Tasks it blocks from `open` (the Organisation's open
 * Tasks, since a Blocking may cross Parents and Projects).
 */
export function graphSubtasks(
  subtasks: readonly Task[],
  ctx: { members: Map<string, Member>; now: number; sessions: Map<string, RunnerSession>; open?: readonly Task[] },
): GraphSubtask[] {
  const inside = new Set(subtasks.map((t) => t.id));
  const blocks = new Map<string, OutsideLink[]>();
  for (const o of ctx.open ?? []) {
    if (inside.has(o.id)) continue;
    for (const b of o.open_blockers ?? [])
      if (inside.has(b.id)) blocks.set(b.id, [...(blocks.get(b.id) ?? []), { direction: "out", id: o.id, key: o.key, title: o.title }]);
  }
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
      outside:
        t.state === "open"
          ? [
              ...(t.open_blockers ?? []).filter((b) => !inside.has(b.id)).map((b): OutsideLink => ({ direction: "in", id: b.id, key: b.key, title: b.title })),
              ...(blocks.get(t.id) ?? []),
            ]
          : [],
      kind: t.kind,
    };
  });
}
