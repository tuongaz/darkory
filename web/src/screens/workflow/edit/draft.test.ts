import { describe, expect, it } from "vitest";
import { engineer, review, skills, step, workflow } from "@/test/fixtures";
import { isNew, toBody } from "../bind";
import type { Roster } from "./holders";
import {
  addOutcome,
  addTaker,
  countChanges,
  deadEndsAfterDelete,
  deleteStep,
  describeChanges,
  describePeople,
  firstOutcome,
  fromRecord,
  groupsOf,
  holdersAt,
  inbound,
  insertStep,
  makeMain,
  outcomes,
  problem,
  removeOutcome,
  removeTaker,
  renameOutcome,
  renameStep,
  reorderStep,
  saveBody,
  setSkill,
  setTarget,
  tasksAt,
} from "./draft";

const skillMap = new Map(skills.map((s) => [s.id, s]));
const groups = groupsOf(workflow(), skillMap);
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

describe("the groups follow the line's branch", () => {
  it("keeps a Step with a branch Skill on the main line when a main Step leads into it, and its Steps after it", () => {
    const wf = base();
    // Review's pass leads into Retro: Retro joins the main line, and Skill review, led into from Retro, with it.
    wf.connectors = wf.connectors.map((c) => (c.id === `${step.review}-c3` ? { ...c, to_step_id: step.retro } : c));
    const g = groupsOf(wf, skillMap);
    expect(wf.steps.filter((s) => g(s) === "after").map((s) => s.name)).toEqual([]);
  });

  it("moves a Step back to the branch when the outcome into it is pointed elsewhere", () => {
    const wf = base();
    wf.connectors = wf.connectors.map((c) => (c.id === `${step.review}-c3` ? { ...c, to_step_id: step.retro } : c));
    const d = setTarget(fromRecord(wf), `${step.review}-c3`, undefined);
    const g = groupsOf(d.wf, skillMap);
    expect(d.wf.steps.filter((s) => g(s) === "after").map((s) => s.name)).toEqual(["Retro", "Skill review"]);
  });
});

describe("inserting a Step", () => {
  it("places a hold with no outcome after the Step, and wires nothing", () => {
    const { draft, id } = insertStep(d0(), step.build, "main");
    const wf = draft.wf;
    expect(wf.steps.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(wf.steps.find((s) => s.id === id)).toMatchObject({ position: 4, name: "" });
    expect(wf.steps.find((s) => s.id === id)!.skill_id).toBeUndefined();
    expect(firstOutcome(wf, id)).toBeUndefined();
    expect(firstOutcome(wf, step.build)).toMatchObject({ name: "pass", to_step_id: step.review });
    expect(wf.connectors).toEqual(base().connectors);
    expect(describeChanges(base(), wf)).toEqual([{ kind: "Added", text: "New Step" }]);
  });

  it("lists a new hold in the group of the Step it follows, until its Skill places it", () => {
    const { draft, id } = insertStep(d0(), step.skillReview, "after");
    const listed = (d: typeof draft) => groupsOf(d.wf, skillMap, d.placed)(d.wf.steps.find((s) => s.id === id)!);
    expect(listed(draft)).toBe("after");
    expect(listed(setSkill(draft, id, { id: engineer.id }))).toBe("main");
  });

  it("sends the new Step by name, in the Workflow of the Step it follows, with no outcome", () => {
    const { draft, id } = insertStep(d0(), step.review, "main");
    const body = toBody(renameStep(draft, id, "Security review").wf);
    expect(body.steps[4]).toEqual({ workflow: "wf-work", name: "Security review", position: 5 });
    expect(body.connectors.filter((c) => c.from === "Security review")).toEqual([]);
  });

  it("leaves a draft of no Workflow and no Step as it is: there is nowhere to put the Step", () => {
    const d = fromRecord({ ...base(), workflows: [], steps: [], connectors: [] });
    const r = insertStep(d, undefined, "main");
    expect(r.id).toBe("");
    expect(r.draft).toBe(d);
  });
});

describe("making an outcome the main way on", () => {
  it("puts it first and keeps the others in order after it; counts it once", () => {
    const d = makeMain(d0(), `${step.review}-c4`);
    expect(outcomes(d.wf, step.review).map((c) => [c.name, c.position])).toEqual([
      ["needs changes", 1],
      ["pass", 2],
    ]);
    expect(describeChanges(base(), d.wf)).toEqual([{ kind: "Main", text: "Review · needs changes → Build" }]);
    expect(makeMain(d, `${step.review}-c4`)).toBe(d);
    expect(countChanges(base(), makeMain(d, `${step.review}-c3`).wf)).toBe(0);
  });
});

describe("deleting a Step", () => {
  it("removes every outcome into it unless asked to lead it elsewhere, and counts each one", () => {
    // D8: Build's pass into Review was re-pointed, and other outcomes into it dropped, without a word.
    const d = deleteStep(d0(), step.review);
    expect(d.wf.connectors.some((c) => c.to_step_id === step.review || c.from_step_id === step.review)).toBe(false);
    expect(firstOutcome(d.wf, step.build)).toBeUndefined();
    expect(describeChanges(base(), d.wf)).toEqual([
      { kind: "Deleted", text: "Review" },
      { kind: "Removed", text: "Build · pass → Review" },
    ]);
  });

  it("leads an outcome into it where it is asked to, and counts that as the change", () => {
    const d = deleteStep(d0(), step.build, undefined, { [`${step.review}-c4`]: { to: step.plan } });
    expect(d.wf.connectors.find((c) => c.id === `${step.review}-c4`)).toMatchObject({ to_step_id: step.plan, position: 2 });
    expect(describeChanges(base(), d.wf)).toEqual([
      { kind: "Deleted", text: "Build" },
      { kind: "Re-pointed", text: "Review · needs changes → Plan (was Build)" },
    ]);
    // Into Done.
    expect(deleteStep(d0(), step.build, undefined, { [`${step.review}-c4`]: { to: undefined } }).wf.connectors.find((c) => c.id === `${step.review}-c4`)!.to_step_id).toBeUndefined();
  });

  it("lists the outcomes into it in the order of their Steps", () => {
    const wf = base();
    wf.connectors.push({ id: "c-plan-build", from_step_id: step.plan, to_step_id: step.build, name: "ready", position: 2 });
    expect(inbound(wf, step.build).map((c) => c.id)).toEqual(["c-plan-build", `${step.review}-c4`]);
  });

  it("says which Steps it leaves with no way out", () => {
    expect(deadEndsAfterDelete(d0(), step.review).map((s) => s.name)).toEqual(["Build"]);
    expect(deadEndsAfterDelete(d0(), step.review, { [`${step.build}-c2`]: { to: undefined } })).toEqual([]);
  });

  it("says where the Tasks of a deleted Step move", () => {
    const record = workflow(undefined, { review: { tasks: 2 } });
    const d = deleteStep(fromRecord(record), step.review, step.build);
    expect(describeChanges(record, d.wf, d.moves)[0]).toEqual({ kind: "Deleted", text: "Review · its 2 Tasks move to Build" });
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
    const { draft, id } = insertStep(d0(), step.build, "main");
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

  it("counts a target put back as no change, and a Step moved and moved back as none", () => {
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
    expect(describeChanges(base(), d.wf)).toEqual([{ kind: "Moved", text: "Backlog" }]);
  });
});

describe("who takes the Steps, in the draft", () => {
  // builder has engineer and is in the Project; ada has review; bob is in neither and has nothing; skill-review is taken Organisation-wide.
  const roster: Roster = {
    members: [
      { id: "m-ada", name: "ada", kind: "human", skills: new Set([review.id, "sk-skill-review"]) },
      { id: "m-bob", name: "bob", kind: "human", skills: new Set() },
      { id: "m-builder", name: "builder", kind: "agent", skills: new Set([engineer.id]) },
    ],
    inProject: new Set(["m-ada", "m-builder"]),
  };
  const wide = new Set(["sk-skill-review"]);
  const names = (d: ReturnType<typeof d0>, skill: string) => (holdersAt(d, roster, wide)?.get(skill) ?? []).map((h) => h.name);
  const say = (d: ReturnType<typeof d0>) => describePeople(d, (id) => id.slice(2), (id) => skillMap.get(id)?.name ?? id, "Web");

  it("takes a Skill away, drawn at once, listed, and sent as a revoke", () => {
    const d = removeTaker(d0(), "m-builder", engineer.id);
    expect(names(d0(), engineer.id)).toEqual(["builder"]);
    expect(names(d, engineer.id)).toEqual([]);
    expect(say(d)).toEqual([{ kind: "Removed", text: "builder from engineer" }]);
    expect(saveBody(d)).toEqual({ ...toBody(base()), revokes: [{ member: "m-builder", skill: engineer.id }] });
    // Taking it again changes nothing; adding them back undoes it, leaving no change.
    expect(removeTaker(d, "m-builder", engineer.id)).toBe(d);
    const back = addTaker(d, "m-builder", engineer.id, false);
    expect(back.people).toBeUndefined();
    expect(say(back)).toEqual([]);
    expect(saveBody(back)).toEqual(toBody(base()));
  });

  it("gives a Skill to a Member outside the Project, who joins it; removing them takes back both", () => {
    const d = addTaker(d0(), "m-bob", engineer.id, true);
    expect(names(d, engineer.id)).toEqual(["bob", "builder"]);
    expect(say(d)).toEqual([{ kind: "Added", text: "bob to engineer, joins Web" }]);
    expect(saveBody(d)).toMatchObject({ joins: ["m-bob"], grants: [{ member: "m-bob", skill: engineer.id }] });
    expect(addTaker(d, "m-bob", engineer.id, true)).toBe(d);
    expect(removeTaker(d, "m-bob", engineer.id).people).toBeUndefined();
  });

  it("keeps a join while the Member is still given another Skill", () => {
    let d = addTaker(d0(), "m-bob", engineer.id, true);
    d = addTaker(d, "m-bob", review.id, false);
    d = removeTaker(d, "m-bob", engineer.id);
    expect(d.people).toEqual({ grants: [{ member: "m-bob", skill: review.id }], revokes: [], joins: ["m-bob"] });
    expect(names(d, review.id)).toEqual(["ada", "bob"]);
  });

  it("draws a Member who joins under every Step whose Skill they have, and skill-review's takers from the whole Organisation", () => {
    const r: Roster = { ...roster, members: roster.members.map((m) => (m.id === "m-bob" ? { ...m, skills: new Set([review.id, "sk-skill-review"]) } : m)) };
    expect((holdersAt(d0(), r, wide)?.get(review.id) ?? []).map((h) => h.name)).toEqual(["ada"]);
    expect((holdersAt(d0(), r, wide)?.get("sk-skill-review") ?? []).map((h) => h.name)).toEqual(["ada", "bob"]);
    const d = addTaker(d0(), "m-bob", engineer.id, true);
    expect((holdersAt(d, r, wide)?.get(review.id) ?? []).map((h) => h.name)).toEqual(["ada", "bob"]);
  });

  it("gives a new Skill by its name, and drops the grant when no Step carries the Skill any more", () => {
    let d = setSkill(d0(), step.review, { create: { name: "security", body: "x" } });
    d = addTaker(d, "m-ada", "new-skill:security", false);
    expect(names(d, "new-skill:security")).toEqual(["ada"]);
    expect(saveBody(d)).toMatchObject({ skills: [{ name: "security", body: "x" }], grants: [{ member: "m-ada", skill: "security" }] });
    expect(saveBody(d).steps.find((s) => s.name === "Review")!.skill).toBe("security");
    d = setSkill(d, step.review, { id: review.id });
    expect(d.people).toBeUndefined();
    expect(saveBody(d).skills).toBeUndefined();
  });

  it("lists the Workflow's changes and who takes the Steps' changes apart, each with the draft they undo to", () => {
    const before = renameStep(d0(), step.build, "Make");
    const after = removeTaker(before, "m-builder", engineer.id);
    expect(describeChanges(base(), after.wf)).toEqual(describeChanges(base(), before.wf));
    expect(say(before)).toEqual([]);
    expect(say(after)).toHaveLength(1);
  });
});
