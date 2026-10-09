import { describe, expect, it } from "vitest";
import type { Activity, Member, RunnerSession, Task, TaskDetail, Workflows } from "@/api/client";
import { ada, bob, builder, detail, engineer, parentTask, retro, skills, step, subtask, task, web, workflow } from "@/test/fixtures";
import { ageText } from "@/lib/time";
import { shownWorkflow } from "@/components/pickedWorkflow";
import { agentNeedsOf, consequence, needsOf, type NeedsInput } from "./needs";

const now = Date.parse("2026-10-08T10:42:05Z");
const ago = (m: number) => new Date(now - m * 60_000).toISOString();

// The retro agent the Runner starts, paused: the only taker at Retro.
const retroAgent: Member = { id: "m-retro", name: "retro", kind: "agent", admin: false, created_at: ago(9000), agent: { command: "claude", args: [], model: "m", env: {}, unattended: true, paused: true } };
const members = new Map([ada, bob, builder, retroAgent].map((m) => [m.id, m]));

function wf(): Workflows {
  return workflow(web, { retro: { takers: [{ id: retroAgent.id, name: retroAgent.name, kind: "agent" }] } });
}

const skillMap = new Map(skills.map((s) => [s.id, s.id === engineer.id ? { ...s, current_version: 2 } : s]));

function input(open: Task[], extra: Partial<NeedsInput> = {}): NeedsInput {
  return {
    me: ada,
    now,
    open,
    projectId: web.id,
    workflows: new Map([[web.id, wf()]]),
    members,
    projectMembers: new Map([[web.id, [ada, builder, retroAgent]]]),
    details: new Map(),
    skills: skillMap,
    sessions: [],
    lapses: [],
    ...extra,
  };
}

// The mockup's heavy day (r2-final F3), on WEB: a question that unblocks a Task, a Parent whose
// Subtasks have all ended, a Retrospective whose proposal went stale, a Task held in Backlog, a
// Retrospective waiting on a paused agent; and what clears itself (a lapse someone else can take
// up, a Task blocked by work under way).
function heavyDay() {
  const q13 = task(13, { aimed_at_id: ada.id, step_id: undefined, step_since: undefined, skill_id: undefined, filed_by: builder.id, title: "Which export format do coordinators use?", created_at: ago(36) });
  const t4 = task(4, { blocked: true, open_blockers: [{ id: q13.id, key: q13.key, title: q13.title }] });
  const p16 = parentTask(16, { open: 0, working: 0, done: 2, dropped: 1 }, { title: "Coordinator dashboard filters" });
  const r17 = task(17, { kind: "retrospective", step_id: step.retro, skill_id: retro.id, step_since: ago(2 * 24 * 60), title: "Retrospective: Bulk invite" });
  const h5 = task(5, { step_id: step.backlog, skill_id: undefined, step_since: ago(18 * 60), title: "Participant search ignores accents" });
  const r14 = task(14, { kind: "retrospective", step_id: step.retro, skill_id: retro.id, step_since: ago(17 * 60), title: "Retrospective: Saved cards" });
  const t15 = task(15, { step_since: ago(12), title: "Refund email links the wrong order" });
  const t10 = task(10, { claim: { id: "c10", task_id: "k-10", holder_id: builder.id, session_id: "s", started_at: ago(1) } });
  const t11 = task(11, { blocked: true, open_blockers: [{ id: t10.id, key: t10.key, title: t10.title }] });
  const details = new Map<string, TaskDetail>([
    [p16.id, detail(p16, { subtasks: [subtask(20, p16, { state: "done", ended_at: ago(95) }), subtask(21, p16, { state: "done", ended_at: ago(89) }), subtask(22, p16, { state: "dropped", ended_at: ago(120) })] })],
    [r17.id, detail(r17, { proposals: [{ id: "pr", skill_id: engineer.id, task_id: r17.id, based_on_version: 1, body: "", author_id: builder.id, state: "pending", created_at: ago(3000) }] })],
    [r14.id, detail(r14)],
  ]);
  const lapses: Activity[] = [{ seq: 9, at: ago(12), kind: "task.lapsed", subject_type: "task", subject_id: t15.id, payload: { holder_id: builder.id } }];
  return { open: [q13, t4, p16, r17, h5, r14, t15, t10, t11], details, lapses };
}

describe("Needs you", () => {
  it("orders the heavy day as the mockup does: what unblocks first, a question before a Complete, then what only I can move, oldest first", () => {
    const { open, details, lapses } = heavyDay();
    const items = needsOf(input(open, { details, lapses }));
    expect(items.map((i) => [i.task.key, i.act, i.group])).toEqual([
      ["WEB-13", "answer", 1],
      ["WEB-16", "complete", 1],
      ["WEB-17", "review", 2],
      ["WEB-5", "move", 2],
      ["WEB-14", "resume", 2],
    ]);
  });

  it("says why each is with me, what acting on it does beyond itself (nothing for a hold or a paused agent), and how old it is", () => {
    const { open, details, lapses } = heavyDay();
    const items = needsOf(input(open, { details, lapses }));
    expect(items.map((i) => [i.why, consequence(i), i.ageLabel, ageText(now - Date.parse(i.since))])).toEqual([
      ["Question from builder", "unblocks WEB-4", "asked", "36m"],
      ["Subtasks ended · 1 dropped", "lands 2 Subtasks", "ready", "1h 29m"],
      ["engineer proposal stale", undefined, "waiting", "2d"],
      ["Held in Backlog", undefined, "held", "18h"],
      ["retro is paused", undefined, "waiting", "17h"],
    ]);
  });

  it("puts what unblocks most first, whatever it is", () => {
    const q = task(1, { aimed_at_id: ada.id, step_id: undefined, created_at: ago(5) });
    const h = task(2, { step_id: step.backlog, skill_id: undefined, step_since: ago(60) });
    const blocked = (n: number, by: Task) => task(n, { blocked: true, open_blockers: [{ id: by.id, key: by.key, title: by.title }] });
    const items = needsOf(input([q, h, blocked(3, q), blocked(4, h), blocked(5, h)]));
    expect(items.map((i) => [i.task.key, consequence(i)])).toEqual([
      ["WEB-2", "unblocks 2 Tasks"],
      ["WEB-1", "unblocks WEB-3"],
    ]);
  });

  it("puts a hold another human could move after what only I can move", () => {
    const h = task(2, { step_id: step.backlog, skill_id: undefined, step_since: ago(600) });
    const q = task(1, { aimed_at_id: ada.id, step_id: undefined, created_at: ago(5) });
    const items = needsOf(input([h, q], { projectMembers: new Map([[web.id, [ada, bob]]]) }));
    expect(items.map((i) => [i.task.key, i.group])).toEqual([
      ["WEB-1", 2],
      ["WEB-2", 3],
    ]);
  });

  it("leaves out what clears itself: a lapse someone can take up, blocked work, a question someone else holds, a Parent still open", () => {
    const { open, details, lapses } = heavyDay();
    const theirs = task(30, { aimed_at_id: ada.id, step_id: undefined, claim: { id: "c", task_id: "k-30", holder_id: bob.id, session_id: "s", started_at: ago(2) } });
    const going = parentTask(31, { open: 1, working: 1, done: 0, dropped: 0 });
    const keys = needsOf(input([...open, theirs, going], { details, lapses })).map((i) => i.task.key);
    expect(keys).not.toContain("WEB-15");
    expect(keys).not.toContain("WEB-11");
    expect(keys).not.toContain("WEB-30");
    expect(keys).not.toContain("WEB-31");
  });

  it("keeps a question I hold, so an answer whose completion was refused can be finished", () => {
    const mine = task(30, { aimed_at_id: ada.id, step_id: undefined, claim: { id: "c", task_id: "k-30", holder_id: ada.id, session_id: "s", started_at: ago(2) } });
    expect(needsOf(input([mine])).map((i) => i.act)).toEqual(["answer"]);
  });

  it("brings a lapse in only when no Member could take the Task, as mine to take", () => {
    const wfNoTakers = workflow(web, { build: { takers: [] } });
    const t = task(15, { step_since: ago(40) });
    const lapse: Activity = { seq: 3, at: ago(12), kind: "task.lapsed", subject_type: "task", subject_id: t.id, payload: { holder_id: builder.id } };
    const [item] = needsOf(input([t], { workflows: new Map([[web.id, wfNoTakers]]), lapses: [lapse] }));
    expect(item.act).toBe("take");
    expect(item.ageLabel).toBe("lapsed");
    expect(item.why).toMatch(/^Lapsed \d\d:\d\d · held by builder$/);
  });

  it("offers Resume only to an admin, and Move on only to a human", () => {
    const { open, details } = heavyDay();
    expect(needsOf(input(open, { details, me: bob })).map((i) => i.act)).not.toContain("resume");
    const agentMe = { ...builder, admin: true };
    expect(needsOf(input(open, { details, me: agentMe, projectMembers: new Map([[web.id, [agentMe]]]) })).map((i) => i.act)).not.toContain("move");
  });

  it("narrows to the Project, or lists every Project's", () => {
    const here = task(1, { aimed_at_id: ada.id, step_id: undefined });
    const there = task(2, { aimed_at_id: ada.id, step_id: undefined, project_id: "p-ops", key: "OPS-2", id: "k-ops-2" });
    expect(needsOf(input([here, there])).map((i) => i.task.key)).toEqual(["WEB-1"]);
    expect(needsOf(input([here, there], { projectId: undefined })).map((i) => i.task.key).sort()).toEqual(["OPS-2", "WEB-1"]);
  });
});

describe("Needs you on the page of one Workflow of several", () => {
  // As if WEB's Steps were split: the page shows a Workflow of Build and Review only.
  const split = (tasks: Task[], id = "wf-shown") => {
    const graph = workflow(web);
    return shownWorkflow(id, {
      workflows: [{ id: "wf-other", position: 1 }, { id: "wf-shown", position: 2 }],
      steps: graph.steps.map((s) => ({ ...s, workflow_id: s.id === step.build || s.id === step.review ? "wf-shown" : "wf-other" })),
    }, tasks);
  };

  it("lists the Tasks its board shows: a hold or a Retrospective of another Workflow is on its own page", () => {
    const { open, details, lapses } = heavyDay();
    // The page reads the Tasks the board reads, so WEB-16's ended Subtasks with them: the last
    // ended at Review, this Workflow's.
    const ended = details.get("k-16")!.subtasks.map((s) => (s.state === "done" ? { ...s, workflow_id: "wf-shown", last_step_id: step.review } : { ...s, workflow_id: "wf-other", last_step_id: step.plan }));
    const read = [...open, ...ended];
    const items = needsOf(input(open, { details, lapses, shown: split(read) }));
    // WEB-5 waits at Backlog, WEB-17 and WEB-14 at Retro: not this Workflow's. WEB-13 blocks
    // WEB-4, at Build; WEB-16 waits with its Owner, where its Subtasks last ended: here.
    expect(items.map((i) => i.task.key)).toEqual(["WEB-13", "WEB-16"]);
    // On the other Workflow's page WEB-16 is not listed: a Parent has one place, as on the boards.
    expect(needsOf(input(open, { details, lapses, shown: split(read, "wf-other") })).map((i) => i.task.key)).not.toContain("WEB-16");
  });

  it("lists a question beside the Task it blocks, else with its Parent, else on every page", () => {
    const question = (n: number, extra: Partial<Task> = {}) => task(n, { step_id: undefined, step_since: undefined, aimed_at_id: ada.id, skill_id: undefined, ...extra });
    const heldUp = (n: number, at: string, by: Task) => task(n, { step_id: at, blocked: true, open_blockers: [{ id: by.id, key: by.key, title: by.title }] });
    const here = question(30);
    const there = question(31);
    const parent = parentTask(40, { open: 1, working: 0, done: 0, dropped: 0 });
    const under = question(32, { parent_id: parent.id });
    const sibling = task(41, { step_id: step.plan, parent_id: parent.id });
    const loose = question(33);
    const open = [here, heldUp(34, step.review, here), there, heldUp(35, step.plan, there), parent, under, sibling, loose];
    expect(needsOf(input(open, { shown: split(open) })).map((i) => i.task.key)).toEqual(["WEB-30", "WEB-33"]);
  });

  it("lists only the agents waiting on its Tasks", () => {
    const sessionOn = (taskId: string): RunnerSession => ({ task_id: taskId, member_id: builder.id, session_id: "s", host: "h", started_at: ago(3), state: "waiting", state_since: ago(3), log_path: "/l" });
    const here = task(6, { claim: { id: "c", task_id: "k-6", holder_id: builder.id, session_id: "s", started_at: ago(22) } });
    const there = task(7, { step_id: step.retro, claim: { id: "c", task_id: "k-7", holder_id: builder.id, session_id: "s", started_at: ago(5) } });
    const out = agentNeedsOf({ me: ada, open: [here, there], projectId: web.id, shown: split([here, there]), members, sessions: [sessionOn(here.id), sessionOn(there.id)] });
    expect(out.map((a) => a.task.key)).toEqual(["WEB-6"]);
  });
});

describe("Agents need you", () => {
  const session = (taskId: string, state: RunnerSession["state"]): RunnerSession => ({ task_id: taskId, member_id: builder.id, session_id: "s", host: "h", started_at: ago(3), state, state_since: ago(3), log_path: "/l" });

  it("lists the sessions waiting or stalled on this Project's Tasks, with what I may do", () => {
    const t6 = task(6, { claim: { id: "c", task_id: "k-6", holder_id: builder.id, session_id: "s", started_at: ago(22) } });
    const t7 = task(7, { owner_id: bob.id, claim: { id: "c", task_id: "k-7", holder_id: builder.id, session_id: "s", started_at: ago(5) } });
    const t8 = task(8);
    const sessions = [session(t6.id, "waiting"), session(t7.id, "stalled"), session(t8.id, "running")];
    const out = agentNeedsOf({ me: bob, open: [t6, t7, t8], projectId: web.id, members, sessions });
    // bob owns WEB-7; builder reports to ada, not bob.
    expect(out.map((a) => [a.task.key, a.session.state, a.canTakeBack, a.canStop])).toEqual([
      ["WEB-6", "waiting", false, false],
      ["WEB-7", "stalled", true, false],
    ]);
    expect(agentNeedsOf({ me: ada, open: [t6], projectId: web.id, members, sessions }).map((a) => [a.canTakeBack, a.canStop])).toEqual([[true, true]]);
  });

  it("says when the Runner last nudged the agent on the Task, since its Claim began, and puts the longest waiting first", () => {
    const t6 = task(6, { claim: { id: "c", task_id: "k-6", holder_id: builder.id, session_id: "s", started_at: ago(22) } });
    const t7 = task(7, { claim: { id: "c", task_id: "k-7", holder_id: builder.id, session_id: "s", started_at: ago(30) } });
    const nudge = (subject: string, minutes: number) => ({ seq: minutes, at: ago(minutes), kind: "task.nudged" as const, subject_type: "task" as const, subject_id: subject, payload: { nudge: 1 } });
    const sessions = [{ ...session(t6.id, "waiting"), state_since: ago(3) }, { ...session(t7.id, "waiting"), state_since: ago(9) }];
    const out = agentNeedsOf({ me: ada, open: [t6, t7], projectId: web.id, members, sessions, nudges: [nudge("k-6", 2), nudge("k-6", 40), nudge("k-7", 1)] });
    expect(out.map((a) => [a.task.key, a.nudgedAt])).toEqual([
      ["WEB-7", Date.parse(ago(1))],
      ["WEB-6", Date.parse(ago(2))],
    ]);
  });
});
