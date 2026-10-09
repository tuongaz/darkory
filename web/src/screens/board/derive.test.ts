import { describe, expect, it } from "vitest";
import type { Activity, Task } from "@/api/client";
import { claimTrails } from "@/components/filters/taskAxes";
import { ada, bob, builder, bug, clientX, parentTask, skills, step, subtask, task, wfId, wfStep, workflow, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import {
  blocking,
  boardColumns,
  childrenOf,
  compareTasks,
  defaultDisplay,
  defaultFileStep,
  dropProblem,
  endedWorkflowOf,
  groupTasks,
  listRows,
  marksOf,
  moveProblem,
  placeOf,
  progressText,
  rankFinder,
  stepsInOrder,
  stepWithSkill,
} from "./derive";

const skillName = (id: string) => skills.find((s) => s.id === id)?.name;
const members = new Map([ada, bob, builder].map((m) => [m.id, m]));
const wf = workflow();
const position = new Map(wf.steps.map((s) => [s.id, s.position]));
const claim = (holder: string, extra: Partial<NonNullable<Task["claim"]>> = {}): Task["claim"] => ({
  id: `c-${holder}`,
  task_id: "",
  holder_id: holder,
  session_id: "s-1",
  started_at: "2026-10-01T09:00:00Z",
  ...extra,
});

function ctx(tasks: Task[]) {
  return {
    workflows: wf.workflows,
    workflow: wf.workflows[0].id,
    steps: wf.steps,
    children: childrenOf(tasks),
    members,
    labels: new Map([bug, clientX].map((l) => [l.id, l])),
    byId: new Map(tasks.map((t) => [t.id, t])),
    blocks: blocking(tasks),
  };
}

describe("filing", () => {
  it("starts at the first Step whose Skill is the Project's own work, then any Skill, then the first", () => {
    const only = (names: string[]) => ({ ...wf, steps: wf.steps.filter((s) => names.includes(s.name)) });
    expect(defaultFileStep(wf, skillName)?.name).toBe("Build");
    expect(defaultFileStep(only(["Backlog", "Plan", "Retro"]), skillName)?.name).toBe("Plan");
    expect(defaultFileStep(only(["Backlog"]), skillName)?.name).toBe("Backlog");
    expect(defaultFileStep({ ...wf, steps: [] }, skillName)).toBeUndefined();
  });

  it("reads the Project's order: the first Workflow's first work Step, whatever the Steps' own positions", () => {
    const five = workflowsFixture();
    const name = (id: string) => workflowsSkills.find((s) => s.id === id)?.name;
    expect(defaultFileStep(five, name)?.name).toBe("Triage");
    // Bugs moved first; the Steps stay as they came, Triage's first.
    const bugsFirst = { ...five, workflows: five.workflows.map((w) => ({ ...w, position: w.id === wfId.bugs ? 1 : w.id === wfId.triage ? 2 : w.position })) };
    expect(defaultFileStep(bugsFirst, name)?.name).toBe("Investigate");
    expect(stepsInOrder(bugsFirst).slice(0, 5).map((s) => s.name)).toEqual(["Investigate", "Fix", "Review", "Verify", "Triage"]);
  });

  it("finds the Steps carrying breakdown and acceptance", () => {
    expect(stepWithSkill(wf, "breakdown", skillName)?.id).toBe(step.plan);
    expect(stepWithSkill(wf, "acceptance", skillName)).toBeUndefined();
  });
});

describe("where a Task stands", () => {
  it("is its Step, the Member it is aimed at, or how it ended", () => {
    const children = new Map<string, Task[]>();
    expect(placeOf(task(1), { children, position })).toEqual({ kind: "step", stepId: step.build });
    expect(placeOf(task(2, { step_id: undefined, aimed_at_id: bob.id }), { children, position })).toEqual({ kind: "with", memberId: bob.id });
    expect(placeOf(task(3, { state: "done", step_id: undefined }), { children, position })).toEqual({ kind: "done" });
  });

  it("puts an open Parent where its least advanced open Subtask is, else with its Owner", () => {
    const p = parentTask(1, { open: 2, working: 0, done: 1, dropped: 0 });
    const subs = [
      subtask(2, p, { step_id: step.review }),
      subtask(3, p, { step_id: step.build }),
      subtask(4, p, { state: "done", step_id: undefined }),
    ];
    expect(placeOf(p, { children: childrenOf(subs), position })).toEqual({ kind: "step", stepId: step.build });
    const ended = subs.map((s) => ({ ...s, state: "done" as const, step_id: undefined }));
    expect(placeOf(p, { children: childrenOf(ended), position })).toEqual({ kind: "with", memberId: ada.id });
  });

  it("reads a Parent's progress as done out of those not dropped", () => {
    expect(progressText({ open: 2, working: 1, done: 3, dropped: 4 })).toBe("3/5");
  });
});

describe("the list", () => {
  const p = parentTask(5, { open: 1, working: 0, done: 0, dropped: 0 });
  const tasks = [
    task(1, { step_id: step.backlog, skill_id: undefined, labels: [clientX.id, bug.id] }),
    task(2, { step_id: step.review, owner_id: bob.id }),
    task(3, { step_id: undefined, aimed_at_id: bob.id }),
    task(4, { state: "done", step_id: undefined, ended_at: "2026-10-02T09:00:00Z" }),
    p,
    subtask(6, p, { step_id: step.review }),
    task(7, { state: "dropped", step_id: undefined }),
  ];

  it("groups by Step in the Workflow's order, then With <Member>, then Done and Dropped", () => {
    const rows = listRows(tasks, { ...defaultDisplay, showDropped: true });
    const groups = groupTasks(rows, "step", ctx(tasks));
    expect(groups.map((g) => g.id)).toEqual([step.backlog, step.review, bob.id, "done", "dropped"]);
    // The Parent stands at Review with its open Subtask, which opens under its row.
    expect(groups[1].tasks.map((t) => t.key)).toEqual(["WEB-2", "WEB-5"]);
  });

  it("hides Dropped unless shown, and leaves Subtasks to their Parent's row", () => {
    expect(listRows(tasks, defaultDisplay).map((t) => t.key)).toEqual(["WEB-1", "WEB-2", "WEB-3", "WEB-4", "WEB-5"]);
  });

  it("groups by Parent: each Parent's Subtasks, then the Tasks with none", () => {
    const rows = listRows(tasks, { ...defaultDisplay, group: "parent" });
    const groups = groupTasks(rows, "parent", ctx(tasks));
    expect(groups.map((g) => [g.id, g.tasks.map((t) => t.key)])).toEqual([
      [p.id, ["WEB-6"]],
      ["", ["WEB-1", "WEB-2", "WEB-3", "WEB-4"]],
    ]);
  });

  it("groups by Owner and by first Label by name", () => {
    const rows = listRows(tasks, defaultDisplay);
    expect(groupTasks(rows, "owner", ctx(tasks)).map((g) => g.id)).toEqual([ada.id, bob.id]);
    const labels = groupTasks(rows, "label", ctx(tasks));
    expect(labels.map((g) => [g.id, g.tasks.length])).toEqual([
      [bug.id, 1],
      ["", 4],
    ]);
  });

  it("orders by Rank (a Subtask after its Parent), by Updated and by Filed", () => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const rank = [...tasks].sort(compareTasks("rank", rankFinder(byId))).map((t) => t.key);
    expect(rank.indexOf("WEB-6")).toBe(rank.indexOf("WEB-5") + 1);
    const filed = [task(1, { created_at: "2026-10-01T09:00:00Z" }), task(2, { created_at: "2026-10-03T09:00:00Z" })];
    expect(filed.sort(compareTasks("filed", rankFinder(byId))).map((t) => t.key)).toEqual(["WEB-2", "WEB-1"]);
    const updated = [task(1), task(2, { step_since: "2026-10-04T09:00:00Z" })];
    expect(updated.sort(compareTasks("updated", rankFinder(byId))).map((t) => t.key)).toEqual(["WEB-2", "WEB-1"]);
  });
});

describe("the board", () => {
  it("has every Step, With columns, Done and a collapsed Dropped; Parents only when shown", () => {
    const p = parentTask(5, { open: 1, working: 0, done: 0, dropped: 0 });
    const tasks = [task(1), task(3, { step_id: undefined, aimed_at_id: bob.id }), p, subtask(6, p, { step_id: step.review })];
    const c = { ...ctx(tasks), display: defaultDisplay };
    const cols = boardColumns(tasks, c);
    expect(cols.map((x) => x.id)).toEqual([...wf.steps.map((s) => s.id), `with:${bob.id}`, "done", "dropped"]);
    expect(cols.find((x) => x.id === "dropped")).toMatchObject({ collapsed: true });
    expect(cols.find((x) => x.id === step.review)?.tasks.map((t) => t.key)).toEqual(["WEB-6"]);
    const shown = boardColumns(tasks, { ...c, display: { ...defaultDisplay, showParents: true } });
    expect(shown.find((x) => x.id === step.review)?.tasks.map((t) => t.key)).toEqual(["WEB-5", "WEB-6"]);
  });

  it("says why a drop on Done, Dropped or a Member's column is not sent", () => {
    const cols = boardColumns([], { ...ctx([]), display: defaultDisplay });
    expect(dropProblem(task(1), cols.find((c) => c.id === "done")!, true)).toBe("Advance WEB-1 into Done from its page, or complete it.");
    expect(dropProblem(task(1), cols.find((c) => c.id === "dropped")!, false)).toBe("Only the Owner drops WEB-1, from its page.");
    expect(dropProblem(task(1), cols.find((c) => c.id === step.review)!, false)).toBeUndefined();
  });
});

describe("the board of one Workflow among several", () => {
  const five = workflowsFixture();
  const steps = stepsInOrder(five);
  const at = (n: number, stepId: string, workflowId: string, extra: Partial<Task> = {}) => task(n, { step_id: stepId, workflow_id: workflowId, ...extra });
  const ended = (n: number, workflowId: string | undefined, extra: Partial<Task> = {}) =>
    task(n, { state: "done", step_id: undefined, step_since: undefined, workflow_id: workflowId, ended_at: "2026-10-03T09:00:00Z", ...extra });
  const board = (tasks: Task[], workflow: string, display = defaultDisplay) =>
    boardColumns(tasks, {
      workflows: five.workflows,
      workflow,
      steps,
      children: childrenOf(tasks),
      byId: new Map(tasks.map((t) => [t.id, t])),
      blocks: blocking(tasks),
      members,
      display,
    });
  const keys = (cols: ReturnType<typeof boardColumns>, id: string) => cols.find((c) => c.id === id)?.tasks.map((t) => t.key);

  it("has the picked Workflow's Steps in order, then With, Done and Dropped", () => {
    const tasks = [at(1, wfStep.triage, wfId.triage), at(2, wfStep.fix, wfId.bugs), task(3, { step_id: undefined, aimed_at_id: bob.id })];
    const triage = board(tasks, wfId.triage);
    expect(triage.map((c) => c.id)).toEqual([wfStep.triage, `with:${bob.id}`, "done", "dropped"]);
    expect(keys(triage, wfStep.triage)).toEqual(["WEB-1"]);
    const bugs = board(tasks, wfId.bugs);
    expect(bugs.map((c) => c.id)).toEqual([wfStep.investigate, wfStep.fix, wfStep.review, wfStep.verify, `with:${bob.id}`, "done", "dropped"]);
    expect(keys(bugs, wfStep.fix)).toEqual(["WEB-2"]);
  });

  it("puts a done Task in the Done of the Workflow it ended in, and in no other", () => {
    const tasks = [ended(1, wfId.bugs, { last_step_id: wfStep.verify }), ended(2, wfId.triage), ended(3, wfId.support, { state: "dropped" })];
    expect(keys(board(tasks, wfId.bugs), "done")).toEqual(["WEB-1"]);
    expect(keys(board(tasks, wfId.triage), "done")).toEqual(["WEB-2"]);
    expect(keys(board(tasks, wfId.support), "dropped")).toEqual(["WEB-3"]);
    expect(keys(board(tasks, wfId.features), "done")).toEqual([]);
  });

  it("shows an open Parent on the board of its least advanced Subtask's Step only", () => {
    const p = parentTask(5, { open: 2, working: 0, done: 0, dropped: 0 });
    const tasks = [p, subtask(6, p, { step_id: wfStep.verify, workflow_id: wfId.bugs }), subtask(7, p, { step_id: wfStep.fix, workflow_id: wfId.bugs })];
    const shown = { ...defaultDisplay, showParents: true };
    expect(keys(board(tasks, wfId.bugs, shown), wfStep.fix)).toEqual(["WEB-5", "WEB-7"]);
    expect(board(tasks, wfId.triage, shown).flatMap((c) => c.tasks.map((t) => t.key))).toEqual([]);
  });

  it("lands an ended Parent where its most recently ended Subtask ended, else on the first Workflow", () => {
    const p = parentTask(5, { open: 0, working: 0, done: 2, dropped: 0 }, { state: "done", ended_at: "2026-10-05T09:00:00Z" });
    const early = subtask(6, p, { state: "done", step_id: undefined, workflow_id: wfId.triage, ended_at: "2026-10-02T09:00:00Z" });
    const late = subtask(7, p, { state: "done", step_id: undefined, workflow_id: wfId.bugs, ended_at: "2026-10-04T09:00:00Z" });
    const ctxOf = (tasks: Task[]) => ({ workflows: five.workflows, children: childrenOf(tasks) });
    // The later in time, not the later in the list.
    expect(endedWorkflowOf(p, ctxOf([p, late, early]))).toBe(wfId.bugs);
    // No ended_at to go by: the least advanced in the Project's order.
    const undated = [p, { ...late, ended_at: undefined }, { ...early, ended_at: undefined }];
    expect(endedWorkflowOf(p, ctxOf(undated))).toBe(wfId.triage);
    // A question aimed at a Member ended at no Step: the Subtask before it says where the work ended.
    const asked = subtask(8, p, { state: "done", step_id: undefined, aimed_at_id: bob.id, ended_at: "2026-10-04T10:00:00Z" });
    expect(endedWorkflowOf(p, ctxOf([p, early, late, asked]))).toBe(wfId.bugs);
    expect(endedWorkflowOf(p, ctxOf([p]))).toBe(wfId.triage);
    const shown = { ...defaultDisplay, showParents: true };
    expect(keys(board([p, early, late], wfId.bugs, shown), "done")).toEqual(["WEB-5", "WEB-7"]);
    expect(keys(board([p, early, late], wfId.triage, shown), "done")).toEqual(["WEB-6"]);
  });

  it("lands an ended Parent where its work ended, not where the Retrospective filed as it ended did", () => {
    const p = parentTask(5, { open: 0, working: 0, done: 2, dropped: 0 }, { state: "done", ended_at: "2026-10-05T09:00:00Z" });
    const fixed = subtask(6, p, { state: "done", step_id: undefined, workflow_id: wfId.bugs, last_step_id: wfStep.verify, ended_at: "2026-10-04T09:00:00Z" });
    const retro = subtask(7, p, { kind: "retrospective", state: "done", step_id: undefined, workflow_id: wfId.triage, last_step_id: wfStep.triage, ended_at: "2026-10-06T09:00:00Z" });
    const tasks = [p, fixed, retro];
    expect(endedWorkflowOf(p, { workflows: five.workflows, children: childrenOf(tasks) })).toBe(wfId.bugs);
    const shown = { ...defaultDisplay, showParents: true };
    expect(keys(board(tasks, wfId.bugs, shown), "done")).toEqual(["WEB-5", "WEB-6"]);
    expect(keys(board(tasks, wfId.triage, shown), "done")).toEqual(["WEB-7"]);
  });

  it("lands a dropped Parent whose Subtasks dropped with it on the board of the least advanced", () => {
    const when = "2026-10-05T09:00:00Z";
    const p = parentTask(5, { open: 0, working: 0, done: 0, dropped: 3 }, { state: "dropped", ended_at: when });
    const dropped = (n: number, workflowId: string, stepId: string) => subtask(n, p, { state: "dropped", step_id: undefined, workflow_id: workflowId, last_step_id: stepId, ended_at: when });
    const kids = [dropped(6, wfId.support, wfStep.support), dropped(7, wfId.bugs, wfStep.verify), dropped(8, wfId.bugs, wfStep.fix)];
    const steps5 = stepsInOrder(five);
    // Whatever the order of the list, the Parent stays on Bugs, where Fix is the least advanced.
    for (const list of [kids, [...kids].reverse()]) {
      const tasks = [p, ...list];
      expect(endedWorkflowOf(p, { workflows: five.workflows, children: childrenOf(tasks), steps: steps5 })).toBe(wfId.bugs);
    }
    const tasks = [p, ...kids];
    expect(keys(board(tasks, wfId.bugs, { ...defaultDisplay, showDropped: true, showParents: true }), "dropped")).toEqual(["WEB-5", "WEB-7", "WEB-8"]);
  });

  it("shows a question aimed at a Member beside the Task it blocks, else its Parent's Workflow, else on every board", () => {
    const asked = task(3, { step_id: undefined, step_since: undefined, aimed_at_id: bob.id });
    const held = task(4, { step_id: wfStep.fix, workflow_id: wfId.bugs, blocked: true, open_blockers: [{ id: asked.id, key: asked.key, title: asked.title }] });
    const withBob = (cols: ReturnType<typeof boardColumns>) => keys(cols, `with:${bob.id}`);
    // Beside the Task it holds up: Bugs' board only.
    expect(withBob(board([asked, held], wfId.bugs))).toEqual(["WEB-3"]);
    expect(withBob(board([asked, held], wfId.triage))).toBeUndefined();
    // Blocking none: on its Parent's board, where the Parent's least advanced Subtask stands.
    const p = parentTask(5, { open: 2, working: 0, done: 0, dropped: 0 });
    const sub = task(6, { parent_id: p.id, step_id: undefined, step_since: undefined, aimed_at_id: bob.id, rank: undefined });
    const work = subtask(7, p, { step_id: wfStep.sketch, workflow_id: wfId.prototypes });
    expect(withBob(board([p, sub, work], wfId.prototypes))).toEqual(["WEB-6"]);
    expect(withBob(board([p, sub, work], wfId.bugs))).toBeUndefined();
    // Neither: every board, Support's included.
    expect(withBob(board([asked], wfId.support))).toEqual(["WEB-3"]);
    expect(withBob(board([asked], wfId.triage))).toEqual(["WEB-3"]);
    // Ended, it lands on its Parent's Workflow, else the first Workflow's Done.
    const answered = { ...sub, state: "done" as const, ended_at: "2026-10-04T09:00:00Z" };
    expect(keys(board([p, answered, work], wfId.prototypes), "done")).toEqual(["WEB-6"]);
    const closed = { ...asked, state: "done" as const, ended_at: "2026-10-04T09:00:00Z" };
    expect(keys(board([closed], wfId.triage), "done")).toEqual(["WEB-3"]);
    expect(keys(board([closed], wfId.bugs), "done")).toEqual([]);
  });

  it("lands an ended Task of no Workflow (its Step since deleted, or aimed at a Member) on the first Workflow's board", () => {
    const tasks = [ended(1, undefined), ended(2, "wf-gone")];
    expect(keys(board(tasks, wfId.triage), "done")).toEqual(["WEB-1", "WEB-2"]);
    expect(keys(board(tasks, wfId.bugs), "done")).toEqual([]);
  });
});

describe("moving by hand", () => {
  const now = Date.parse("2026-10-01T10:00:00Z");
  const base = { members, now, projectName: "Web" };

  it("is a Project Member's or the Owner's, on an open Task that is not a Parent", () => {
    expect(moveProblem(task(1), { ...base, me: bob.id, projects: [{ id: "p-web" }] })).toBeUndefined();
    expect(moveProblem(task(1), { ...base, me: bob.id, projects: [] })).toBe("Only Members of Web or the Owner move WEB-1.");
    expect(moveProblem(task(1, { owner_id: bob.id }), { ...base, me: bob.id, projects: [] })).toBeUndefined();
    expect(moveProblem(parentTask(2, { open: 1, working: 0, done: 0, dropped: 0 }), { ...base, me: ada.id, projects: [{ id: "p-web" }] })).toMatch(/is a Parent/);
    expect(moveProblem(task(3, { state: "done" }), { ...base, me: ada.id, projects: [{ id: "p-web" }] })).toMatch(/has ended/);
  });

  it("of a held Task, only whoever may take it back: the Owner or above the holder", () => {
    const held = task(1, { owner_id: bob.id, claim: claim(builder.id) });
    // ada directs builder; bob owns the Task; the holder may not move it.
    expect(moveProblem(held, { ...base, me: ada.id, projects: [{ id: "p-web" }] })).toBeUndefined();
    expect(moveProblem(held, { ...base, me: bob.id, projects: [{ id: "p-web" }] })).toBeUndefined();
    expect(moveProblem(held, { ...base, me: builder.id, projects: [{ id: "p-web" }] })).toBe(
      "builder holds WEB-1: only the Owner, bob, or someone above builder moves it.",
    );
  });
});

describe("marks", () => {
  it("reads blocked first, then a lapse since the last Claim", () => {
    const marks = marksOf(task(1, { blocked: true, open_blockers: [{ id: "k-9", key: "WEB-9", title: "Q" }] }), { lapsedAt: "2026-10-01T09:30:00Z" }, Date.now());
    expect(marks).toEqual([
      { kind: "blocked", by: "WEB-9" },
      { kind: "lapsed", at: "2026-10-01T09:30:00Z" },
    ]);
  });
});

describe("the Claim trail the list shares with the Filter", () => {
  it("counts each Task's Evidence once per entry", () => {
    const e = (seq: number, subject: string): Activity => ({ seq, at: "2026-10-01T09:00:00Z", kind: "task.evidence_attached", subject_type: "task", subject_id: subject, payload: {} });
    const trails = claimTrails([e(1, "k-2"), e(2, "k-2"), e(2, "k-2"), e(3, "k-3")]);
    expect(trails.get("k-2")?.evidence).toBe(2);
    expect(trails.get("k-3")?.evidence).toBe(1);
  });
});
