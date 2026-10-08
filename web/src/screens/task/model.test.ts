import { describe, expect, it } from "vitest";
import type { Activity, RunnerSession } from "@/api/client";
import { ada, bob, builder, detail, parentTask, review, skills, step, subtask, task, workflow } from "@/test/fixtures";
import { liveClaimOf } from "../board/testData";
import { taskActions } from "./actions";
import { taskRecord } from "./record";
import { graphSteps, graphSubtasks } from "./graph";
import { takersOf } from "./takers";

const members = new Map([ada, bob, builder].map((m) => [m.id, m]));
const now = Date.now();
const inWeb = new Set(["p-web"]);

describe("the graph's binding", () => {
  it("lays the Workflow's Steps as columns, with their Skills", () => {
    const cols = graphSteps(workflow().steps, new Map(skills.map((s) => [s.id, s])));
    expect(cols.map((c) => [c.name, c.skill?.name])).toEqual([
      ["Backlog", undefined],
      ["Plan", "breakdown"],
      ["Build", "engineer"],
      ["Review", "review"],
      ["Retro", "retro"],
      ["Skill review", "skill-review"],
    ]);
  });

  it("binds each Subtask's Step, holder and how they work, aim, open blockers and kind", () => {
    const p = parentTask(1, { open: 3, working: 1, done: 1, dropped: 0 });
    const subs = [
      subtask(2, p, { claim: liveClaimOf(builder, "k-2") }),
      subtask(3, p, { claim: liveClaimOf(ada, "k-3"), step_id: step.review }),
      subtask(4, p, { step_id: undefined, aimed_at_id: bob.id, blocked: true, open_blockers: [{ id: "k-9", key: "WEB-9", title: "x" }] }),
      subtask(5, p, { state: "done", step_id: undefined, kind: "acceptance" }),
    ];
    const sessions = new Map<string, RunnerSession>([["k-2", { task_id: "k-2", member_id: builder.id, session_id: "s", host: "h", started_at: "", state: "stalled", state_since: "", log_path: "" }]]);
    const nodes = graphSubtasks(subs, { members, now, sessions });
    expect(nodes.map((n) => [n.key, n.stepId, n.holder?.name, n.working, n.aimedAt?.name, n.blockedBy, n.kind])).toEqual([
      ["WEB-2", step.build, "builder", "stalled", undefined, [], "work"],
      ["WEB-3", step.review, "ada", "held", undefined, [], "work"],
      ["WEB-4", null, undefined, undefined, "bob", ["k-9"], "work"],
      ["WEB-5", null, undefined, undefined, undefined, [], "acceptance"],
    ]);
    // An agent's live Claim with no Runner session counts as running.
    expect(graphSubtasks([subs[0]], { members, now, sessions: new Map() })[0].working).toBe("running");
  });

  it("names the open Tasks outside the Parent a Subtask is joined to by a Blocking, either way", () => {
    const p = parentTask(1, { open: 2, working: 0, done: 0, dropped: 0 });
    const subs = [
      subtask(2, p, { blocked: true, open_blockers: [{ id: "k-3", key: "WEB-3", title: "inside" }, { id: "k-12", key: "WEB-12", title: "Admin can remove a reaction" }] }),
      subtask(3, p),
      subtask(4, p, { state: "done", step_id: undefined, open_blockers: [{ id: "k-12", key: "WEB-12", title: "x" }] }),
    ];
    // Outside: WEB-19 is blocked by WEB-3; WEB-20 by nothing here; WEB-2 is inside.
    const open = [...subs, task(19, { blocked: true, open_blockers: [{ id: "k-3", key: "WEB-3", title: "inside" }] }), task(20)];
    const nodes = graphSubtasks(subs, { members, now, sessions: new Map(), open });
    expect(nodes.map((n) => n.outside)).toEqual([
      [{ direction: "in", id: "k-12", key: "WEB-12", title: "Admin can remove a reaction" }],
      [{ direction: "out", id: "k-19", key: "WEB-19", title: task(19).title }],
      // An ended Subtask carries no stub.
      [],
    ]);
  });
});

describe("who could take a Task", () => {
  const wf = workflow();
  const build = wf.steps.find((s) => s.id === step.build)!;
  it("is its Step's takers, less anyone who held it under another Skill, else its Owner", () => {
    expect(takersOf({ task: task(1), claims: [] }, build)).toEqual([builder.id]);
    const reviewed = { id: "c", task_id: "k-1", holder_id: builder.id, session_id: "s", started_at: "", skill_id: review.id };
    expect(takersOf({ task: task(1), claims: [reviewed] }, build)).toEqual([ada.id]);
    expect(takersOf({ task: task(1, { aimed_at_id: bob.id }), claims: [] }, build)).toEqual([bob.id]);
  });
});

describe("the actions by role", () => {
  const wf = workflow();
  const out = (t: ReturnType<typeof task>) => detail(t, { connectors: wf.connectors.filter((c) => c.from_step_id === t.step_id) });
  const ctx = { members, takeable: new Set<string>(), projects: inWeb, now };

  it("gives the holder Advance along the first outcome, the rest and Release after it", () => {
    const held = task(1, { step_id: step.review, claim: liveClaimOf(builder, "k-1") });
    const a = taskActions({ ...ctx, me: builder.id, detail: out(held) });
    expect(a.primary).toMatchObject({ kind: "advance", connector: { name: "pass" } });
    expect(a.caret.map((c) => (c.kind === "advance" ? c.connector.name : c.kind))).toEqual(["needs changes", "release"]);
    expect(a.menu).toEqual(["observe", "attach-evidence", "add-blocker", "ask-question", "file-subtask", "rank", "drop"]);
    expect(a.splits).toBe(true);
    expect(a.dimmed.drop).toBe("Owner only");
  });

  it("completes a Task aimed at its holder, which has no outcomes", () => {
    const aimed = task(1, { step_id: undefined, aimed_at_id: bob.id, claim: liveClaimOf(bob, "k-1") });
    expect(taskActions({ ...ctx, me: bob.id, projects: new Set(), detail: out(aimed) }).primary).toEqual({ kind: "complete" });
  });

  it("gives a Parent's Owner Complete, dimmed while a Subtask is open", () => {
    const p = parentTask(1, { open: 1, working: 0, done: 2, dropped: 0 });
    const a = taskActions({ ...ctx, me: ada.id, detail: out(p) });
    expect(a.primary).toEqual({ kind: "complete" });
    expect(a.dimmed.complete).toBe("Subtasks open");
    expect(a.menu).toEqual(["file-subtask", "attach-evidence", "rank", "pass-ownership", "drop"]);
  });

  it("offers Claim on a takeable Task, and nothing but a dimmed Drop to someone outside the Project", () => {
    const t = task(1);
    expect(taskActions({ ...ctx, me: bob.id, takeable: new Set(["k-1"]), detail: out(t) }).primary).toEqual({ kind: "claim" });
    const outside = taskActions({ ...ctx, me: bob.id, projects: new Set(), detail: out(t) });
    expect(outside.menu).toEqual(["drop"]);
    expect(outside.notes).toBeNull();
    expect(outside.labels).toBe(false);
  });

  it("gives Take back and Move to whoever may take a held Task back; the Subtask's Owner passes nothing", () => {
    const held = subtask(2, parentTask(1, { open: 1, working: 1, done: 0, dropped: 0 }), { claim: liveClaimOf(builder, "k-2") });
    const a = taskActions({ ...ctx, me: ada.id, detail: out(held) });
    expect(a.menu).toEqual(["take-back", "move", "drop"]);
    expect(a.notes).toEqual({ onlyHolder: builder.id });
  });
});

describe("the record's end", () => {
  const ended = { state: "done" as const, ended_at: new Date(now).toISOString() };
  const completed = (seq: number, subject: string, actor: string, payload: Record<string, unknown> = {}): Activity => ({
    seq,
    at: new Date(now - (10 - seq) * 1000).toISOString(),
    kind: "task.completed",
    subject_type: "task",
    subject_id: subject,
    actor_id: actor,
    payload,
  });

  it("names who completed a Parent by hand, not who completed a Subtask in its trail", () => {
    const p = parentTask(1, { open: 0, working: 0, done: 2, dropped: 0 }, ended);
    const sub = subtask(2, p, { state: "done" });
    // The Parent's trail (GET /v1/activity?task=) carries its Subtasks' entries too.
    const trail = [completed(5, sub.id, builder.id), completed(9, p.id, ada.id)];
    expect(taskRecord(detail(p, { subtasks: [sub] }), trail).at(-1)).toMatchObject({ kind: "ended", by: ada.id });
  });

  it("says a Parent with Auto-complete completed itself when its last Subtask ended, not who ended it", () => {
    const p = parentTask(1, { open: 0, working: 0, done: 2, dropped: 0 }, ended);
    const breakdown = subtask(2, p, { kind: "breakdown", state: "done" });
    const acceptance = subtask(5, p, { kind: "acceptance", state: "done" });
    const trail = [completed(3, breakdown.id, builder.id), completed(9, acceptance.id, bob.id), completed(9, p.id, bob.id, { auto_complete: true })];
    const end = taskRecord(detail(p, { subtasks: [breakdown, acceptance] }), trail).at(-1);
    expect(end).toMatchObject({ kind: "ended", auto: true, after: acceptance.key });
    expect(end).not.toHaveProperty("by");
  });
});
