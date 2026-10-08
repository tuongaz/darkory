import { describe, expect, it } from "vitest";
import type { Activity, Task } from "@/api/client";
import { claimTrails } from "@/components/filters/taskAxes";
import { ada, bob, builder, bug, clientX, parentTask, skills, step, subtask, task, workflow } from "@/test/fixtures";
import {
  boardColumns,
  childrenOf,
  compareTasks,
  defaultDisplay,
  defaultFileStep,
  dropProblem,
  groupTasks,
  listRows,
  marksOf,
  moveProblem,
  placeOf,
  progressText,
  rankFinder,
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
    steps: wf.steps,
    children: childrenOf(tasks),
    members,
    labels: new Map([bug, clientX].map((l) => [l.id, l])),
    byId: new Map(tasks.map((t) => [t.id, t])),
  };
}

describe("filing", () => {
  it("starts at the first Step whose Skill is the Project's own work, then any Skill, then the first", () => {
    expect(defaultFileStep(wf.steps, skillName)?.name).toBe("Build");
    const own = wf.steps.filter((s) => ["Backlog", "Plan", "Retro"].includes(s.name));
    expect(defaultFileStep(own, skillName)?.name).toBe("Plan");
    expect(defaultFileStep(wf.steps.filter((s) => s.name === "Backlog"), skillName)?.name).toBe("Backlog");
    expect(defaultFileStep([], skillName)).toBeUndefined();
  });

  it("finds the Steps carrying breakdown and acceptance", () => {
    expect(stepWithSkill(wf.steps, "breakdown", skillName)?.id).toBe(step.plan);
    expect(stepWithSkill(wf.steps, "acceptance", skillName)).toBeUndefined();
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
