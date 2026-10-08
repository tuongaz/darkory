// A Project's Tasks for the Tasks screens' tests: WEB with a hold, a held and blocked Task, a
// Parent with three Subtasks, a question aimed at bob, one done and one dropped.
import type { Activity, Claim, Member, Task } from "@/api/client";
import type { Handler } from "@/test/api";
import { ada, bob, builder, bug, clientX, me, parentTask, signedIn, step, subtask, task, web } from "@/test/fixtures";

export const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

export function liveClaimOf(holder: Member, taskId: string, extra: Partial<Claim> = {}): Claim {
  return {
    id: `c-${taskId}`,
    task_id: taskId,
    holder_id: holder.id,
    session_id: "s-1",
    started_at: inFuture(-5),
    expires_at: inFuture(15),
    heartbeat_timeout_seconds: 900,
    ...extra,
  };
}

export const copy = task(1, { title: "Draft the launch copy", step_id: step.backlog, skill_id: undefined, labels: [bug.id] });
export const cart = task(2, {
  title: "Build the cart page",
  blocked: true,
  open_blockers: [{ id: "k-8", key: "WEB-8", title: "Stripe keys for staging?" }],
  claim: liveClaimOf(builder, "k-2", { model_label: "claude-opus-5-5" }),
  labels: [clientX.id],
});
export const checkout = parentTask(3, { open: 2, working: 1, done: 1, dropped: 0 }, { title: "Checkout", owner_id: bob.id });
export const payment = subtask(4, checkout, { title: "Payment form", claim: liveClaimOf(builder, "k-4") });
export const receipt = subtask(5, checkout, { title: "Receipt email", step_id: step.review, skill_id: "s-review" });
export const basket = subtask(6, checkout, { title: "Basket icon", state: "done", step_id: undefined, step_since: undefined, ended_at: "2026-10-02T09:00:00Z" });
export const keysQ = task(8, { title: "Stripe keys for staging?", step_id: undefined, step_since: undefined, skill_id: undefined, aimed_at_id: bob.id, filed_by: builder.id });
export const shipped = task(9, { title: "Landing page", state: "done", step_id: undefined, step_since: undefined, ended_at: "2026-10-03T09:00:00Z" });
export const rate = task(10, { title: "Rate-limit sign-in", state: "dropped", step_id: undefined, step_since: undefined, ended_at: "2026-10-03T10:00:00Z" });

export const projectTasks: Task[] = [copy, cart, checkout, payment, receipt, basket, keysQ, shipped, rate];

const entry = (seq: number, kind: Activity["kind"], subject: string, extra: Partial<Activity> = {}): Activity => ({
  seq,
  at: "2026-10-01T09:30:00Z",
  kind,
  subject_type: "task",
  subject_id: subject,
  payload: {},
  ...extra,
});

export const trail: Activity[] = [
  entry(1, "task.claimed", copy.id),
  entry(2, "task.lapsed", copy.id, { at: "2026-10-01T10:15:00Z" }),
  entry(3, "task.evidence_attached", receipt.id),
  entry(4, "task.evidence_attached", receipt.id),
];

/** What the Tasks screens read, signed in as `member` (ada by default: in WEB, builder's manager). */
export function routes(extra: Record<string, Handler> = {}, member: Member = ada): Record<string, Handler> {
  return {
    ...signedIn(member),
    "GET /v1/me": { ...me(member), projects: member === bob ? [] : [web] },
    "GET /v1/tasks": { items: projectTasks },
    "GET /v1/tasks/takeable": { items: [] },
    "GET /v1/labels": { items: [bug] },
    "GET /v1/projects/:project/labels": { items: [clientX] },
    "GET /v1/activity": { items: trail, last_seq: 4 },
    ...extra,
  };
}
