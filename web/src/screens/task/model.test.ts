import { describe, expect, it } from "vitest";
import type { Activity, Claim, Evidence, RunnerSession } from "@/api/client";
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
    const cols = graphSteps(workflow(), new Map(skills.map((s) => [s.id, s])));
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

  it("gives the Owner Merge while the pull request is open and a Runner is attached; holding the Task, Merge waits in the menu", () => {
    const pr = { number: 7, url: "https://github.com/o/r/pull/7", state: "open" as const };
    const done = task(1, { state: "done", step_id: undefined, pull_request: pr });
    expect(taskActions({ ...ctx, me: ada.id, runner: true, detail: out(done) }).primary).toEqual({ kind: "merge" });
    expect(taskActions({ ...ctx, me: ada.id, runner: false, detail: out(done) }).primary).toBeUndefined();
    expect(taskActions({ ...ctx, me: bob.id, runner: true, detail: out(done) }).primary).toBeUndefined();
    expect(taskActions({ ...ctx, me: ada.id, runner: true, detail: out({ ...done, pull_request: { ...pr, state: "merged" } }) }).primary).toBeUndefined();

    const takeable = taskActions({ ...ctx, me: ada.id, runner: true, takeable: new Set(["k-1"]), detail: out(task(1, { pull_request: pr })) });
    expect(takeable.primary).toEqual({ kind: "merge" });
    expect(takeable.menu[0]).toBe("claim");

    const holding = taskActions({ ...ctx, me: ada.id, runner: true, detail: out(task(1, { step_id: step.review, pull_request: pr, claim: liveClaimOf(ada, "k-1") })) });
    expect(holding.primary).toMatchObject({ kind: "advance" });
    expect(holding.menu[0]).toBe("merge");
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

describe("a Shift's log in the record", () => {
  const t0 = Date.parse("2026-10-10T10:00:00Z");
  const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const claim = (id: string, holder: string, from: number, to?: number, how: Claim["how_ended"] = "advanced"): Claim => ({
    id,
    task_id: "k-1",
    holder_id: holder,
    session_id: `s-${id}`,
    started_at: iso(from),
    ...(to !== undefined ? { ended_at: iso(to), how_ended: how } : {}),
  });
  const evidence = (id: string, by: string, min: number, kind: Evidence["kind"] = "log"): Evidence => ({
    id,
    task_id: "k-1",
    kind,
    filename: kind === "log" ? `shift-WEB-1-${by}-100000.log` : "pw-all.log",
    content_type: "text/plain",
    size: 56_800,
    sha256: "x",
    attached_by: by,
    created_at: iso(min),
  });
  const t = task(1, { created_at: iso(-1) });
  const ends = (r: ReturnType<typeof taskRecord>) => r.filter((e) => e.kind === "claim-ended");

  it("hangs the log on its Claim's end row and lists only the holder's Evidence as Evidence", () => {
    const claims = [claim("a", builder.id, 0, 7)];
    const record = taskRecord(detail(t, { claims, evidence: [evidence("pw", builder.id, 6, "evidence"), evidence("log", builder.id, 7)] }));
    expect(record.filter((e) => e.kind === "evidence").map((e) => e.kind === "evidence" && e.evidence.id)).toEqual(["pw"]);
    expect(ends(record)[0]).toMatchObject({ claim: { id: "a" }, logs: [{ id: "log" }] });
    expect(record.some((e) => e.kind === "log")).toBe(false);
  });

  it("finds the Claim the log belongs to when it came minutes later, after the next holder took the Task", () => {
    const claims = [claim("a", builder.id, 0, 7), claim("b", bob.id, 8, 12), claim("c", builder.id, 13)];
    // builder's log of Claim a, attached at 10, while bob held it; builder holds it again at 13.
    const record = taskRecord(detail(t, { claims, evidence: [evidence("log-a", builder.id, 10), evidence("log-b", bob.id, 12)] }));
    expect(ends(record).map((e) => e.kind === "claim-ended" && [e.claim.id, e.logs?.map((l) => l.id)])).toEqual([
      ["a", ["log-a"]],
      ["b", ["log-b"]],
    ]);
  });

  it("prefers the Claim that just ended to one the same holder holds now", () => {
    const claims = [claim("a", builder.id, 0, 7), claim("c", builder.id, 7.5)];
    const record = taskRecord(detail(t, { claims, evidence: [evidence("log-a", builder.id, 8)] }));
    expect(ends(record)[0]).toMatchObject({ claim: { id: "a" }, logs: [{ id: "log-a" }] });
  });

  it("puts a log on the drop that ended its Claim, and one with no Claim of its own on a row of its own", () => {
    const dropped = { ...t, state: "dropped" as const, ended_at: iso(7) };
    const claims = [claim("a", builder.id, 0, 7, "dropped")];
    const trail: Activity[] = [{ seq: 1, at: iso(7), kind: "task.dropped", subject_type: "task", subject_id: t.id, actor_id: ada.id, payload: {} }];
    const record = taskRecord(detail(dropped, { claims, evidence: [evidence("log-a", builder.id, 8), evidence("stray", bob.id, 9)] }), trail);
    expect(record.find((e) => e.kind === "ended")).toMatchObject({ state: "dropped", logs: [{ id: "log-a" }] });
    expect(record.at(-1)).toMatchObject({ kind: "log", evidence: { id: "stray" } });
  });
});
