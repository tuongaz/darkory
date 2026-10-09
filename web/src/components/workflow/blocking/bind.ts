// Binds the record to the Blocking view's shapes: the Organisation's open Tasks as `BlockingTask`s.
import type { Member, RunnerSession, Task } from "@/api/client";
import type { ShownWorkflow } from "@/components/pickedWorkflow";
import { workingOf } from "@/lib/work";
import { liveClaim } from "@/work";
import type { BlockingTask } from "./layout";

/**
 * Each open Task as the view reads it: its open blockers, its Step and how long it has been
 * there, its holder under a live Claim and how they work, the Member it is aimed at, and who can
 * take it now. A Subtask takes its Parent's Rank.
 */
export function blockingTasks(
  open: readonly Task[],
  ctx: { members: Map<string, Member>; now: number; sessions: Map<string, RunnerSession>; takeableByMe: Set<string> },
): BlockingTask[] {
  const byId = new Map(open.map((t) => [t.id, t]));
  return open
    .filter((t) => t.state === "open")
    .map((t) => {
      const claim = liveClaim(t, ctx.now);
      const holder = claim ? ctx.members.get(claim.holder_id) : undefined;
      const aimed = t.aimed_at_id ? ctx.members.get(t.aimed_at_id) : undefined;
      const blockedBy = (t.open_blockers ?? []).map((b) => b.id);
      const rank = t.rank ?? (t.parent_id ? byId.get(t.parent_id)?.rank : undefined) ?? Number.MAX_SAFE_INTEGER;
      return {
        id: t.id,
        key: t.key,
        title: t.title,
        projectId: t.project_id,
        parentId: t.parent_id,
        parent: !!t.subtask_counts,
        rank,
        blockedBy,
        stepId: t.step_id,
        since: Date.parse(t.step_since ?? t.waiting_since),
        holder: holder && { id: holder.id, name: holder.name, kind: holder.kind, working: workingOf(holder.kind, ctx.sessions.get(t.id)?.state) },
        aimedAt: aimed && { id: aimed.id, name: aimed.name, kind: aimed.kind },
        takeable: !t.subtask_counts && !claim && blockedBy.length === 0 && (t.step_id ? !!t.skill_id : !!t.aimed_at_id),
        takeableByMe: ctx.takeableByMe.has(t.id),
      };
    });
}


/**
 * Whether a Task, by id, is the page's own, of the Workflow `shown` (`ShownWorkflow.shows`) read
 * off its record; every Task when none is shown, and a Task with no record here.
 */
export function shownBy(shown: ShownWorkflow | undefined, byId: ReadonlyMap<string, Task>): ((id: string) => boolean) | undefined {
  if (!shown) return undefined;
  return (id) => {
    const task = byId.get(id);
    return !task || shown.shows(task);
  };
}
