import { describe, expect, it } from "vitest";
import { engineer, review, skills, step, workflow } from "@/test/fixtures";
import { isNew, toBody } from "../bind";
import {
  addOutcome,
  countChanges,
  deadEndsAfterDelete,
  deleteStep,
  firstOutcome,
  fromRecord,
  groupOf,
  insertStep,
  problem,
  removeOutcome,
  renameOutcome,
  renameStep,
  reorderStep,
  setSkill,
  setTarget,
  tasksAt,
  wasTarget,
} from "./draft";

const skillMap = new Map(skills.map((s) => [s.id, s]));
const groups = (s: Parameters<typeof groupOf>[0]) => groupOf(s, skillMap);
const base = () => workflow();
const d0 = () => fromRecord(base());

describe("the list's groups", () => {
  it("lists the Steps carrying acceptance, retro and skill-review after a Parent; breakdown stays on the main line", () => {
    const wf = base();
    expect(wf.steps.filter((s) => groups(s) === "after").map((s) => s.name)).toEqual(["Retro", "Skill review"]);
    expect(wf.steps.find((s) => s.id === step.plan)!.skill_id).toBeDefined();
    expect(groups(wf.steps.find((s) => s.id === step.plan)!)).toBe("main");
  });
});

describe("inserting a Step", () => {
  it("re-points the Step before it, and leads on with pass to where that went", () => {
    const { draft, id } = insertStep(d0(), step.build, groups);
    const wf = draft.wf;
    expect(wf.steps.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(wf.steps.find((s) => s.id === id)).toMatchObject({ position: 4, name: "" });
    expect(wf.steps.find((s) => s.id === id)!.skill_id).toBeUndefined();
    expect(firstOutcome(wf, step.build)).toMatchObject({ name: "pass", to_step_id: id });
    expect(firstOutcome(wf, id)).toMatchObject({ name: "pass", to_step_id: step.review });
    expect(wasTarget(base(), firstOutcome(wf, step.build)!)).toEqual({ to: step.review });
    expect(countChanges(base(), wf)).toBe(2);
  });

  it("after a Step with no outcome, leads on to the next Step of its group", () => {
    const { draft, id } = insertStep(d0(), step.backlog, groups);
    expect(firstOutcome(draft.wf, step.backlog)).toBeUndefined();
    expect(firstOutcome(draft.wf, id)).toMatchObject({ to_step_id: step.plan });
  });

  it("after the last main Step into Done skips the Steps after a Parent", () => {
    const wf = base();
    wf.connectors = wf.connectors.filter((c) => c.from_step_id !== step.review);
    const { draft, id } = insertStep(fromRecord(wf), step.review, groups);
    expect(firstOutcome(draft.wf, id)!.to_step_id).toBeUndefined();
  });

  it("sends the new Step by name and its outcomes from it by name", () => {
    const { draft, id } = insertStep(d0(), step.review, groups);
    const body = toBody(renameStep(draft, id, "Security review").wf);
    expect(body.steps[4]).toEqual({ name: "Security review", position: 5, x: 448, y: 256 });
    expect(body.connectors.filter((c) => c.from === "Security review")).toEqual([{ from: "Security review", name: "pass", position: 1 }]);
    expect(body.connectors.find((c) => c.id === `${step.review}-c3`)).toMatchObject({ to: "Security review" });
  });
});

describe("deleting a Step", () => {
  it("leads a first outcome into it on where its own first led; drops the others into it", () => {
    const d = deleteStep(d0(), step.review);
    expect(firstOutcome(d.wf, step.build)).toMatchObject({ id: `${step.build}-c2` });
    expect(firstOutcome(d.wf, step.build)!.to_step_id).toBeUndefined();
    expect(d.wf.connectors.some((c) => c.to_step_id === step.review || c.from_step_id === step.review)).toBe(false);
    expect(countChanges(base(), d.wf)).toBe(2);
  });

  it("drops a first outcome into a Step that had none, which strands its Step", () => {
    const wf = base();
    wf.connectors = wf.connectors.filter((c) => c.from_step_id !== step.review);
    expect(deadEndsAfterDelete(fromRecord(wf), step.review).map((s) => s.name)).toEqual(["Build"]);
    expect(deleteStep(fromRecord(wf), step.review).wf.connectors.some((c) => c.from_step_id === step.build)).toBe(false);
  });

  it("sends Tasks moved to a Step deleted after to where that Step's go", () => {
    const record = workflow(undefined, { build: { tasks: 2 }, review: { tasks: 1 } });
    let d = deleteStep(fromRecord(record), step.build, step.review);
    expect(tasksAt(d, step.review)).toBe(3);
    d = deleteStep(d, step.review, step.plan);
    expect(d.moves).toEqual({ [step.build]: step.plan, [step.review]: step.plan });
    expect(problem(d, record, skills)).toBeUndefined();
    expect(toBody(d.wf, d.moves).moves).toEqual({ [step.build]: step.plan, [step.review]: step.plan });
  });

  it("deletes a new Step without a move, and counts nothing left", () => {
    const { draft, id } = insertStep(d0(), step.build, groups);
    const d = deleteStep(draft, id);
    expect(d.moves).toEqual({});
    expect(firstOutcome(d.wf, step.build)!.to_step_id).toBe(step.review);
    expect(countChanges(base(), d.wf)).toBe(0);
  });
});

describe("Skills", () => {
  it("carries a new Skill by a placeholder until Save, and forgets it when no Step carries it", () => {
    let d = setSkill(d0(), step.review, { create: { name: "security", body: "Look for holes." } });
    expect(d.wf.steps.find((s) => s.id === step.review)!.skill_id).toBe("new-skill:security");
    expect(d.skills).toEqual({ "new-skill:security": { name: "security", body: "Look for holes." } });
    expect(countChanges(base(), d.wf)).toBe(1);
    d = setSkill(d, step.review, { id: review.id });
    expect(d.skills).toEqual({});
    expect(countChanges(base(), d.wf)).toBe(0);
  });

  it("refuses a new Skill whose name is taken or not a Skill's name", () => {
    expect(problem(setSkill(d0(), step.review, { create: { name: "engineer", body: "x" } }), base(), skills)).toBe(
      "There is a Skill called engineer already: pick it instead.",
    );
    expect(problem(setSkill(d0(), step.review, { create: { name: "Sec Review", body: "x" } }), base(), skills)).toContain("lower-case");
  });

  it("drops a Step's takers with its Skill", () => {
    const d = setSkill(d0(), step.build, { id: review.id });
    expect(d.wf.steps.find((s) => s.id === step.build)!.takers).toEqual([]);
    expect(setSkill(d0(), step.build, { id: engineer.id }).wf.steps.find((s) => s.id === step.build)!.takers).toHaveLength(1);
  });
});

describe("outcomes and order", () => {
  it("adds an outcome last out of its Step, unnamed, into Done", () => {
    const { draft, id } = addOutcome(d0(), step.review);
    expect(draft.wf.connectors.find((c) => c.id === id)).toMatchObject({ from_step_id: step.review, name: "", position: 3 });
    expect(draft.wf.connectors.find((c) => c.id === id)!.to_step_id).toBeUndefined();
    expect(isNew(id)).toBe(true);
    expect(problem(draft, base(), skills)).toBe("An outcome out of Review needs a name.");
    expect(countChanges(base(), renameOutcome(draft, id, "fail").wf)).toBe(1);
  });

  it("renumbers the outcomes left when one is removed: the next becomes the first", () => {
    const d = removeOutcome(d0(), `${step.review}-c3`);
    expect(firstOutcome(d.wf, step.review)).toMatchObject({ name: "needs changes", position: 1 });
  });

  it("counts a target put back as no change", () => {
    const d = setTarget(setTarget(d0(), `${step.review}-c3`, step.plan), `${step.review}-c3`, undefined);
    expect(countChanges(base(), d.wf)).toBe(0);
  });

  it("swaps within a group only, and counts the fewest Steps moved", () => {
    expect(reorderStep(d0(), step.review, 1, groups)).toEqual(d0());
    expect(reorderStep(d0(), step.backlog, -1, groups)).toEqual(d0());
    let d = reorderStep(d0(), step.backlog, 1, groups);
    d = reorderStep(d, step.backlog, 1, groups);
    expect(d.wf.steps.map((s) => s.name)).toEqual(["Plan", "Build", "Backlog", "Review", "Retro", "Skill review"]);
    expect(countChanges(base(), d.wf)).toBe(1);
  });
});
