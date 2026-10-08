// The Tasks' axes: what each token means for a Task, as `GET /v1/tasks?filter=` reads it, the
// values each axis offers, and old links turned into tokens.
import { describe, expect, it } from "vitest";
import type { Activity, Task } from "@/api/client";
import { ada, bob, bug, builder, clientX, engineer, ops, parentTask, review, skills, step, subtask, task, web, workflow } from "@/test/fixtures";
import type { FilterPill } from "./filterState";
import { usablePills } from "./operators";
import {
  claimTrails,
  kindValue,
  labelOptions,
  matches,
  nobody,
  parentOptions,
  projectTaskFields,
  stepOptions,
  stepsOf,
  takeableByValues,
  taskFields,
  taskFilterOptions,
  type FilterContext,
} from "./taskAxes";
import { legacyTaskPills } from "./useTaskFilter";

const now = Date.parse("2026-10-08T10:00:00Z");
const hour = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const pill = (field: string, op: string, ...values: string[]): FilterPill => ({ field, op, values });

// WEB's default Workflow: builder (agent) takes Build, ada (human) Review and Skill review. OPS's
// Build is taken by both.
const wf = workflow(web);
const opsWf = workflow(ops, { build: { takers: [{ id: builder.id, name: builder.name, kind: "agent" }, { id: bob.id, name: bob.name, kind: "human" }] } });
const ctx: FilterContext = { now, steps: stepsOf([wf, opsWf]) };

const held = (t: Task, holder = builder.id, extra: Partial<NonNullable<Task["claim"]>> = {}): Task => ({
  ...t,
  claim: { id: `c-${t.id}`, task_id: t.id, holder_id: holder, session_id: "s-1", started_at: iso(now - hour), ...extra },
});

const pass = (t: Task, ...pills: FilterPill[]) => matches(t, pills, ctx);

describe("what a token means for a Task", () => {
  it("Step: the Step it is at; is not also takes a Task at no Step", () => {
    const atBuild = task(1);
    const parent = parentTask(2, { open: 1, working: 0, done: 0, dropped: 0 });
    expect(pass(atBuild, pill("step", "is", step.build))).toBe(true);
    expect(pass(atBuild, pill("step", "in", step.review, step.build))).toBe(true);
    expect(pass(atBuild, pill("step", "not", step.build))).toBe(false);
    expect(pass(parent, pill("step", "is", step.build))).toBe(false);
    expect(pass(parent, pill("step", "not", step.build))).toBe(true);
  });

  it("Label: any Label it carries; is none of means none of them", () => {
    const t = task(1, { labels: [bug.id, clientX.id] });
    expect(pass(t, pill("label", "is", bug.id))).toBe(true);
    expect(pass(t, pill("label", "nin", bug.id))).toBe(false);
    expect(pass(task(2), pill("label", "nin", bug.id))).toBe(true);
    expect(pass(task(2), pill("label", "is", bug.id))).toBe(false);
  });

  it("Parent: its Parent, or none for a Task with no Parent", () => {
    const parent = parentTask(1, { open: 1, working: 0, done: 0, dropped: 0 });
    const sub = subtask(2, parent);
    expect(pass(sub, pill("parent", "is", parent.id))).toBe(true);
    expect(pass(parent, pill("parent", "is", nobody))).toBe(true);
    expect(pass(sub, pill("parent", "is", nobody))).toBe(false);
    expect(pass(sub, pill("top", "is", "true"))).toBe(false);
    expect(pass(parent, pill("top", "is", "true"))).toBe(true);
  });

  it("Kind: a work Task aimed at a Member is a question; Acceptance is a kind", () => {
    expect(kindValue(task(1, { aimed_at_id: bob.id, step_id: undefined }))).toBe("question");
    expect(kindValue(task(1))).toBe("work");
    expect(pass(task(1, { kind: "acceptance" }), pill("kind", "is", "acceptance"))).toBe(true);
    expect(pass(task(1, { aimed_at_id: bob.id }), pill("kind", "is", "work"))).toBe(false);
  });

  it("Claim: held, unheld, a lapse in the last 24 hours, a live session; several at once", () => {
    const t = task(1);
    const lapsedNow = held(task(2), builder.id, { expires_at: iso(now - hour) });
    expect(pass(held(t), pill("claim", "is", "held"))).toBe(true);
    expect(pass(t, pill("claim", "is", "unheld"))).toBe(true);
    // A Claim past its expiry that the sweep has not ended lapsed at its expiry: unheld and lapsed.
    expect(pass(lapsedNow, pill("claim", "is", "unheld"), pill("claim", "is", "lapsed"))).toBe(true);
    const trails = new Map([[t.id, { lastLapseAt: iso(now - 2 * hour) }]]);
    expect(matches(held(t), [pill("claim", "is", "lapsed")], { ...ctx, trails })).toBe(true);
    expect(matches(t, [pill("claim", "is", "lapsed")], { ...ctx, trails: new Map([[t.id, { lastLapseAt: iso(now - 25 * hour) }]]) })).toBe(false);
    expect(matches(t, [pill("claim", "is", "session")], { ...ctx, sessions: new Set([t.id]) })).toBe(true);
  });

  it("Held by: the live Claim's holder, or none", () => {
    expect(pass(held(task(1)), pill("holder", "is", builder.id))).toBe(true);
    expect(pass(task(1), pill("holder", "is", nobody))).toBe(true);
    expect(pass(task(1, { state: "done", claim: held(task(1)).claim }), pill("holder", "is", nobody))).toBe(true);
  });

  it("Owner, Filed by, Aimed at, Blocked and Project read the record", () => {
    const t = task(1, { owner_id: bob.id, filed_by: ada.id, aimed_at_id: bob.id, blocked: true });
    expect(pass(t, pill("owner", "is", bob.id), pill("filed_by", "is", ada.id), pill("aimed_at", "is", bob.id), pill("blocked", "is", "true"))).toBe(true);
    expect(pass(t, pill("project", "is", web.id))).toBe(true);
    expect(pass(t, pill("project", "is", ops.id))).toBe(false);
    // Darkory's own Subtasks have no filer: "is not ada" passes them.
    expect(pass(task(2, { kind: "acceptance", filed_by: undefined }), pill("filed_by", "not", ada.id))).toBe(true);
  });

  it("Takeable by: who in the Project holds its Step's Skill; both when an agent and a human do", () => {
    expect(takeableByValues(task(1), ctx.steps)).toEqual(["agents"]);
    expect(takeableByValues(task(1, { step_id: step.review }), ctx.steps)).toEqual(["humans"]);
    expect(takeableByValues(task(1, { step_id: `ops-${step.build}` }), ctx.steps)).toEqual(["agents", "humans", "both"]);
    // A hold carries no Skill, and Plan's breakdown nobody in WEB holds.
    expect(takeableByValues(task(1, { step_id: step.backlog }), ctx.steps)).toEqual([]);
    expect(takeableByValues(task(1, { step_id: step.plan }), ctx.steps)).toEqual([]);
    expect(takeableByValues(parentTask(1, { open: 1, working: 0, done: 0, dropped: 0 }), ctx.steps)).toEqual([]);
    expect(pass(task(1), pill("takeable_by", "is", "humans"))).toBe(false);
    expect(pass(task(1), pill("takeable_by", "in", "agents", "both"))).toBe(true);
  });

  it("Filed and Completed: the record's times; a dropped Task was never completed", () => {
    const done = task(1, { state: "done", ended_at: iso(now - hour), created_at: iso(now - 40 * 24 * hour) });
    const dropped = task(2, { state: "dropped", ended_at: iso(now - hour) });
    expect(pass(done, pill("completed_at", "last", "7d"))).toBe(true);
    expect(pass(dropped, pill("completed_at", "last", "7d"))).toBe(false);
    expect(pass(done, pill("filed_at", "last", "30d"))).toBe(false);
    expect(pass(dropped, pill("ended_at", "last", "7d"))).toBe(true);
  });

  it("Search: the key or the title, ignoring case; the axes AND, a pill's values OR", () => {
    const t = task(12, { title: "Payment form" });
    expect(pass(t, pill("q", "contains", "PAYMENT"))).toBe(true);
    expect(pass(t, pill("q", "contains", "web-12"))).toBe(true);
    expect(pass(t, pill("q", "contains", "payment"), pill("step", "is", step.review))).toBe(false);
  });

  it("Rank: its place, both ends included; an axis it does not know narrows nothing", () => {
    expect(pass(task(3), pill("rank", "lte", "3"))).toBe(true);
    expect(pass(task(4), pill("rank", "lte", "3"))).toBe(false);
    expect(pass(task(4), pill("colour", "is", "red"))).toBe(true);
  });
});

describe("the axes", () => {
  it("are the server's words, Project only across Projects", () => {
    expect(taskFields.map((f) => f.key)).toEqual([
      "step",
      "label",
      "parent",
      "kind",
      "claim",
      "blocked",
      "holder",
      "aimed_at",
      "owner",
      "filed_by",
      "takeable_by",
      "project",
      "workspace",
      "filed_at",
      "completed_at",
      "q",
    ]);
    expect(projectTaskFields.some((f) => f.key === "project")).toBe(false);
    // An old Status pill in the address is not one this list can apply.
    expect(usablePills([pill("status", "is", "st-todo"), pill("step", "is", step.build)], projectTaskFields)).toEqual([pill("step", "is", step.build)]);
  });
});

describe("the values each axis offers", () => {
  const skillMap = new Map(skills.map((s) => [s.id, s]));

  it("Steps in the Workflow's order with their Skill or Hold, grouped by Project with its name only across Projects", () => {
    const one = stepOptions([web], new Map([[web.id, wf]]), skillMap);
    expect(one.map((o) => [o.label, o.hint])).toEqual([
      ["Backlog", "Hold"],
      ["Plan", "breakdown"],
      ["Build", "engineer"],
      ["Review", "review"],
      ["Retro", "retro"],
      ["Skill review", "skill-review"],
    ]);
    expect(one.every((o) => o.groupLabel === undefined)).toBe(true);
    const two = stepOptions([web, ops], new Map([[web.id, wf], [ops.id, opsWf]]), skillMap);
    expect(two[0]).toMatchObject({ value: step.backlog, group: web.id, groupLabel: "Web" });
    expect(two[6]).toMatchObject({ value: `ops-${step.backlog}`, group: ops.id, groupLabel: "Ops" });
  });

  it("Labels: the Project's own, then the Organisation's under its heading", () => {
    const options = labelOptions([web], [bug, clientX]);
    expect(options.map((o) => [o.label, o.groupLabel])).toEqual([
      ["client-x", undefined],
      ["bug", "Organisation"],
    ]);
    expect(labelOptions([ops], [bug, clientX]).map((o) => [o.label, o.groupLabel])).toEqual([["bug", undefined]]);
  });

  it("Parents: No Parent, the open ones by Rank, then the ended ones under their heading", () => {
    const counts = { open: 0, working: 0, done: 1, dropped: 0 };
    const options = parentOptions([parentTask(5, counts), task(1), parentTask(2, counts, { state: "done" }), parentTask(3, counts)]);
    expect(options.map((o) => [o.value, o.groupLabel])).toEqual([
      [nobody, undefined],
      ["k-3", undefined],
      ["k-5", undefined],
      ["k-2", "Done and dropped"],
    ]);
  });

  it("Members: active ones, the signed-in Member first and marked Me", () => {
    const options = taskFilterOptions({
      projects: [web],
      workflows: new Map([[web.id, wf]]),
      tasks: [],
      labels: [],
      members: new Map([ada, bob, builder, { ...bob, id: "m-gone", name: "gone", deactivated_at: iso(now) }].map((m) => [m.id, m])),
      skills: new Map([engineer, review].map((s) => [s.id, s])),
      workspaces: [],
      me: bob.id,
    });
    expect(options.get("owner")!.map((o) => [o.label, o.hint])).toEqual([
      ["bob", "Me"],
      ["ada", undefined],
      ["builder", undefined],
    ]);
    expect(options.get("holder")![0]).toMatchObject({ value: nobody, label: "Nobody" });
    expect(options.get("kind")!.map((o) => o.value)).toEqual(["work", "question", "breakdown", "acceptance", "retrospective"]);
    expect(options.get("takeable_by")!.map((o) => o.value)).toEqual(["agents", "humans", "both"]);
  });
});

describe("the Claim trail", () => {
  const entry = (seq: number, kind: Activity["kind"], subject: string, at: number, actor?: string): Activity => ({
    seq,
    at: iso(at),
    kind,
    subject_type: "task",
    subject_id: subject,
    actor_id: actor,
    payload: {},
  });

  it("keeps the last lapse though the Task was claimed again, and who completed it", () => {
    const trails = claimTrails([entry(3, "task.claimed", "k-1", now), entry(1, "task.claimed", "k-1", now - 3 * hour), entry(2, "task.lapsed", "k-1", now - 2 * hour), entry(4, "task.completed", "k-2", now, ada.id)]);
    expect(trails.get("k-1")).toEqual({ lapsedAt: undefined, lastLapseAt: iso(now - 2 * hour) });
    expect(trails.get("k-2")).toEqual({ completedBy: ada.id });
  });
});

describe("old links", () => {
  const lookup = {
    members: new Map([ada, bob, builder].map((m) => [m.id, m])),
    skills: new Map(skills.map((s) => [s.id, s])),
    steps: wf.steps,
    tasks: [parentTask(4, { open: 1, working: 0, done: 0, dropped: 0 })],
  };
  const pills = (search: string) => legacyTaskPills(new URLSearchParams(search), lookup);

  it("turns names into ids: a Skill is the Steps carrying it, a Feature the Parent with its key", () => {
    expect(pills("?skill=engineer&holder=builder&blocked=1&feature=web-4&owner=ada")).toEqual([
      pill("step", "is", step.build),
      pill("holder", "is", builder.id),
      pill("owner", "is", ada.id),
      pill("blocked", "is", "true"),
      pill("parent", "is", "k-4"),
    ]);
  });

  it("drops a Status, a Team, and a name that matches nothing", () => {
    expect(pills("?status=st-todo&team=WEB&skill=nobody-has&holder=zed&feature=WEB-99")).toEqual([]);
  });
});
