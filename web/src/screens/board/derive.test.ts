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
  groupTasks,
  listedOn,
  listRows,
  marksOf,
  moveProblem,
  placeOf,
  progressText,
  rankFinder,
  stepLookups,
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
    ...stepLookups(wf.steps),
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
      ...stepLookups(steps),
      children: childrenOf(tasks),
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

  it("puts a Parent where the server lists it: waiting with its Owner in that board's With, ended in that board's Done", () => {
    const shown = { ...defaultDisplay, showParents: true, showDropped: true };
    // Its one Subtask ended at Fix: the server lists the Parent, waiting with ada, in Bugs.
    const waiting = parentTask(5, { open: 0, working: 0, done: 1, dropped: 0 }, { workflow_id: wfId.bugs });
    const fixed = subtask(6, waiting, { state: "done", step_id: undefined, workflow_id: wfId.bugs, last_step_id: wfStep.fix, ended_at: "2026-10-04T09:00:00Z" });
    expect(keys(board([waiting, fixed], wfId.bugs, shown), `with:${ada.id}`)).toEqual(["WEB-5"]);
    expect(keys(board([waiting, fixed], wfId.triage, shown), `with:${ada.id}`)).toBeUndefined();
    // Ended, with its Retrospective at Triage: in Bugs' Done, where the server lists it, not Triage's.
    const ended = parentTask(7, { open: 1, working: 0, done: 1, dropped: 0 }, { state: "done", workflow_id: wfId.bugs, ended_at: "2026-10-05T09:00:00Z" });
    const retro = subtask(8, ended, { kind: "retrospective", step_id: wfStep.triage, workflow_id: wfId.triage });
    expect(keys(board([ended, retro], wfId.bugs, shown), "done")).toEqual(["WEB-7"]);
    expect(keys(board([ended, retro], wfId.triage, shown), "done")).toEqual([]);
    expect(keys(board([ended, retro], wfId.triage, shown), wfStep.triage)).toEqual(["WEB-8"]);
  });

  it("shows a question where the server lists it; with no Workflow, on every board while open and the first Workflow's Done once ended", () => {
    const withBob = (cols: ReturnType<typeof boardColumns>) => keys(cols, `with:${bob.id}`);
    // Beside the Task it blocks, as the server says: Bugs' board only.
    const asked = task(3, { step_id: undefined, step_since: undefined, aimed_at_id: bob.id, workflow_id: wfId.bugs });
    expect(withBob(board([asked], wfId.bugs))).toEqual(["WEB-3"]);
    expect(withBob(board([asked], wfId.triage))).toBeUndefined();
    // None from the server (it blocks nothing at a Step and has no Parent placed): every board.
    const loose = { ...asked, workflow_id: undefined };
    for (const w of Object.values(wfId)) expect(withBob(board([loose], w))).toEqual(["WEB-3"]);
    // Ended, it is in the Done of the Workflow listed, else the first Workflow's.
    const answered = { ...asked, state: "done" as const, ended_at: "2026-10-04T09:00:00Z" };
    expect(keys(board([answered], wfId.bugs), "done")).toEqual(["WEB-3"]);
    expect(keys(board([answered], wfId.triage), "done")).toEqual([]);
    const closed = { ...answered, workflow_id: undefined };
    expect(keys(board([closed], wfId.triage), "done")).toEqual(["WEB-3"]);
    expect(keys(board([closed], wfId.bugs), "done")).toEqual([]);
  });

  it("lands an ended Task of no Workflow the Project has (its Step since deleted) on the first Workflow's board", () => {
    const tasks = [ended(1, undefined), ended(2, "wf-gone")];
    expect(keys(board(tasks, wfId.triage), "done")).toEqual(["WEB-1", "WEB-2"]);
    expect(keys(board(tasks, wfId.bugs), "done")).toEqual([]);
    expect(listedOn(task(3, { workflow_id: "wf-gone" }), five)).toBeUndefined();
  });

  it("stands an open Parent at a Step (`placeOf`) of the Workflow the server lists it in", () => {
    // The server's rule and the board's Step rule read the same Subtask: the least advanced open
    // one at a Step, by Workflow position, then Step position. A Parent's `workflow_id` below is
    // what `/v1` serves for it (workflowOfSQL); its card stands at a Step of that Workflow. The
    // server side of the pair is TestEveryTaskListedInAWorkflow in internal/core/workflow_test.go.
    const stepWorkflow = new Map(steps.map((s) => [s.id, s.workflow_id]));
    const cases: [stepIds: string[], listed: string][] = [
      [[wfStep.verify, wfStep.fix], wfId.bugs],
      [[wfStep.support, wfStep.verify], wfId.bugs],
      [[wfStep.release, wfStep.triage, wfStep.sketch], wfId.triage],
      [[wfStep.approve, wfStep.prototypeReview], wfId.prototypes],
    ];
    for (const [stepIds, listed] of cases) {
      const p = parentTask(5, { open: stepIds.length, working: 0, done: 0, dropped: 0 }, { workflow_id: listed });
      const kids = stepIds.map((id, i) => subtask(6 + i, p, { step_id: id, workflow_id: stepWorkflow.get(id) }));
      const place = placeOf(p, { children: childrenOf([p, ...kids]), ...stepLookups(steps) });
      expect(place.kind).toBe("step");
      expect(stepWorkflow.get((place as { stepId: string }).stepId)).toBe(p.workflow_id);
      expect(listedOn(p, five)).toEqual(new Set([listed]));
    }
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
