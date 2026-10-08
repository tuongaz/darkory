import { describe, expect, it } from "vitest";
import { tidy } from "@/components/workflow/layout";
import { ada, bob, builder, engineer, review, skills, step, task, workflow } from "@/test/fixtures";
import { adoptIds, changeAcross, isNew, newIds, toBody, toCanvas, workingAt } from "./bind";
import {
  addConnector,
  addStep,
  deleteStep,
  layoutSteps,
  placeStep,
  problem,
  reconnect,
  removeConnector,
  renameConnector,
  renameStep,
  reorderConnector,
  reorderStep,
  restore,
  setStepSkill,
} from "./edits";

const wf = () => workflow();
const skillMap = new Map(skills.map((s) => [s.id, s]));
const at = (body: ReturnType<typeof toBody>, name: string) => body.steps.find((s) => s.name === name)!;
const out = (body: ReturnType<typeof toBody>, from: string) => body.connectors.filter((c) => c.from === from);

describe("binding the record to the canvas", () => {
  it("names each Step's Skill, leads a Connector without to_step_id into Done, and keeps the counts", () => {
    const record = workflow(undefined, { build: { tasks: 3, working: 1, median_ms: 60_000 } });
    const canvas = toCanvas(record, skillMap);
    const build = canvas.steps.find((s) => s.id === step.build)!;
    expect(build).toMatchObject({ name: "Build", skill: { id: engineer.id, name: "engineer" }, tasks: 3, working: 1, medianMs: 60_000 });
    expect(canvas.steps.find((s) => s.id === step.backlog)!.skill).toBeUndefined();
    expect(canvas.connectors.find((c) => c.id === `${step.review}-c3`)).toMatchObject({ from: step.review, to: null, name: "pass" });
    expect(canvas.connectors.find((c) => c.id === `${step.review}-c4`)).toMatchObject({ to: step.build, name: "needs changes" });
  });

  it("rings a taker working at the Step: an agent in its session's state, running without one; a human held", () => {
    const now = Date.parse("2026-10-08T10:00:00Z");
    const claim = (n: number, holder: string) => ({ id: `c${n}`, task_id: `k-${n}`, holder_id: holder, session_id: "s", started_at: "2026-10-08T09:00:00Z" });
    const tasks = [
      task(1, { claim: claim(1, builder.id) }),
      task(2, { step_id: step.review, claim: claim(2, ada.id) }),
      task(3, { step_id: step.review, claim: { ...claim(3, bob.id), ended_at: "2026-10-08T09:30:00Z" } }),
    ];
    const kinds = new Map([ada, bob, builder].map((m) => [m.id, m.kind]));
    const sessions = [{ task_id: "k-1", member_id: builder.id, session_id: "s", host: "h", started_at: "", state: "stalled" as const, log_path: "" }];
    const working = workingAt(tasks, sessions, (id) => kinds.get(id), now);
    expect(working.get(step.build)?.get(builder.id)).toBe("stalled");
    expect(working.get(step.review)?.get(ada.id)).toBe("held");
    expect(working.get(step.review)?.has(bob.id)).toBe(false);
    expect(workingAt([tasks[0]], [], (id) => kinds.get(id), now).get(step.build)?.get(builder.id)).toBe("running");

    const canvas = toCanvas(workflow(), skillMap, working);
    expect(canvas.steps.find((s) => s.id === step.build)!.takers).toEqual([{ id: builder.id, name: "builder", kind: "agent", working: "stalled" }]);
  });
});

describe("each change as the PUT body", () => {
  it("sends the whole Workflow as GET gave it: ids, Skills, positions 1…n, places, Connectors by id", () => {
    const body = toBody(wf());
    expect(body.steps).toHaveLength(6);
    expect(at(body, "Backlog")).toEqual({ id: step.backlog, name: "Backlog", position: 1, x: 0, y: 0 });
    expect(at(body, "Build")).toEqual({ id: step.build, name: "Build", skill: engineer.id, position: 3, x: 0, y: 256 });
    expect(out(body, step.review)).toEqual([
      { id: `${step.review}-c3`, from: step.review, name: "pass", position: 1 },
      { id: `${step.review}-c4`, from: step.review, to: step.build, name: "needs changes", position: 2 },
    ]);
    expect(body.moves).toBeUndefined();
  });

  it("renames a Step", () => {
    const c = renameStep(wf(), step.build, "  Make ");
    expect(c.label).toBe("Renamed Build to Make");
    expect(at(toBody(c.next), "Make")).toMatchObject({ id: step.build, position: 3 });
  });

  it("changes a Step's Skill, and makes a hold of it", () => {
    expect(at(toBody(setStepSkill(wf(), step.build, review).next), "Build").skill).toBe(review.id);
    const hold = setStepSkill(wf(), step.build, undefined);
    expect(at(toBody(hold.next), "Build")).not.toHaveProperty("skill");
    expect(hold.label).toBe("Build is now a hold");
  });

  it("adds a Step after another, connected from it, named by name until /v1 gives it an id", () => {
    const c = addStep(wf(), step.build);
    expect(isNew(c.select!)).toBe(true);
    const body = toBody(c.next);
    expect(body.steps.map((s) => s.name)).toEqual(["Backlog", "Plan", "Build", "New Step", "Review", "Retro", "Skill review"]);
    // Right of Build, below Review and Skill review, which stand there.
    expect(at(body, "New Step")).toEqual({ name: "New Step", position: 4, x: 448, y: 512 });
    expect(at(body, "Review").position).toBe(5);
    // Build has "pass" already: the new outcome is "next", by the new Step's name.
    expect(out(body, step.build)).toEqual([
      { id: `${step.build}-c2`, from: step.build, to: step.review, name: "pass", position: 1 },
      { from: step.build, to: "New Step", name: "next", position: 2 },
    ]);
    expect(addStep(c.next).next.steps.find((s) => s.name === "New Step 2")).toBeDefined();
  });

  it("deletes a Step with its Connectors, and moves its Tasks where asked", () => {
    const record = workflow(undefined, { review: { tasks: 2 } });
    const c = deleteStep(record, step.review, step.build);
    const body = toBody(c.next, c.moves);
    expect(body.steps.map((s) => [s.name, s.position])).toEqual([
      ["Backlog", 1],
      ["Plan", 2],
      ["Build", 3],
      ["Retro", 4],
      ["Skill review", 5],
    ]);
    expect(body.connectors.some((x) => x.from === step.review || x.to === step.review)).toBe(false);
    expect(body.moves).toEqual({ [step.review]: step.build });
    expect(c.label).toBe("Deleted Review; its 2 Tasks moved to Build");
    expect(c.undoNote).toBe("Undo brings Review back; its Tasks stay at Build.");
  });

  it("moves Tasks of a deleted Step to a new Step by its name", () => {
    const added = addStep(workflow(undefined, { review: { tasks: 1 } }), step.build);
    const c = deleteStep(added.next, step.review, added.select);
    expect(toBody(c.next, c.moves).moves).toEqual({ [step.review]: "New Step" });
  });

  it("adds, renames, retargets, reorders and removes a Connector", () => {
    const added = addConnector(wf(), step.backlog, step.build, "start");
    expect(out(toBody(added.next), step.backlog)).toEqual([{ from: step.backlog, to: step.build, name: "start", position: 1 }]);
    expect(added.label).toBe("Connected Backlog to Build: start");

    const renamed = renameConnector(wf(), `${step.review}-c4`, "rework");
    expect(out(toBody(renamed.next), step.review)[1]).toMatchObject({ id: `${step.review}-c4`, name: "rework" });

    const intoDone = reconnect(wf(), `${step.review}-c4`, { from: step.review, to: undefined });
    expect(out(toBody(intoDone.next), step.review)[1]).not.toHaveProperty("to");

    const moved = reconnect(wf(), `${step.build}-c2`, { from: step.plan, to: step.review });
    expect(out(toBody(moved.next), step.plan)).toEqual([
      { id: `${step.plan}-c1`, from: step.plan, name: "done", position: 1 },
      { id: `${step.build}-c2`, from: step.plan, to: step.review, name: "pass", position: 2 },
    ]);

    const reordered = reorderConnector(wf(), `${step.review}-c4`, -1);
    expect(out(toBody(reordered.next), step.review).map((x) => x.name)).toEqual(["needs changes", "pass"]);

    const removed = removeConnector(wf(), `${step.review}-c4`);
    expect(out(toBody(removed.next), step.review).map((x) => x.name)).toEqual(["pass"]);
    expect(removed.label).toBe("Removed needs changes from Review to Build");
  });

  it("moves a Step on the canvas, and in the order", () => {
    expect(at(toBody(placeStep(wf(), step.plan, 101, 203).next), "Plan")).toMatchObject({ x: 101, y: 203, position: 2 });
    expect(toBody(reorderStep(wf(), step.build, -1).next).steps.map((s) => s.name).slice(1, 3)).toEqual(["Build", "Plan"]);
  });

  it("tidies up: every Step at dagre's place", () => {
    const record = wf();
    const positions = tidy(toCanvas(record, skillMap));
    const body = toBody(layoutSteps(record, positions).next);
    for (const s of body.steps) expect({ x: s.x, y: s.y }).toEqual(positions[s.id!]);
  });
});

describe("what /v1 would refuse, in words", () => {
  const current = workflow(undefined, { build: { tasks: 2 } });
  it.each([
    ["a blank name", renameStep(current, step.plan, " ").next, "A Step needs a name."],
    ["a name used twice", renameStep(current, step.plan, "build").next, "Two Steps are called build"],
    ["an outcome used twice out of one Step", addConnector(current, step.review, step.plan, "PASS").next, "Two outcomes out of Review are called pass"],
    ["a blank outcome", renameConnector(current, `${step.review}-c3`, "").next, "An outcome out of Review needs a name."],
    ["a Connector into its own step", reconnect(current, `${step.review}-c3`, { from: step.review, to: step.review }).next, "A Connector leads out of Review into another Step or Done."],
    ["a deleted step's Tasks with nowhere to go", deleteStep(current, step.build).next, "2 Tasks are at Build: say which Step they move to."],
  ])("refuses %s", (_, next, words) => {
    expect(problem(next, current)).toContain(words);
  });

  it("takes a deleted step's Tasks moved to a Step it keeps, and refuses one it deletes", () => {
    const c = deleteStep(current, step.build, step.review);
    expect(problem(c.next, current, c.moves)).toBeUndefined();
    expect(problem(c.next, current, { [step.build]: step.build })).toBe("Build's Tasks must move to a Step the Workflow keeps.");
  });
});

describe("undo and new ids", () => {
  it("puts a deleted Step back as a new one, its Connectors with it", () => {
    const before = wf();
    const after = deleteStep(before, step.retro).next;
    const undo = restore(after, before, "Deleted Retro");
    const body = toBody(undo.next);
    expect(undo.label).toBe("Undid: Deleted Retro");
    expect(at(body, "Retro")).toEqual({ name: "Retro", skill: "s-retro", position: 5, x: 0, y: 384 });
    expect(out(body, "Retro").map((c) => [c.name, c.to])).toEqual([
      ["done", undefined],
      ["propose", step.skillReview],
    ]);
    expect(body.connectors.find((c) => c.name === "needs changes" && c.from === step.skillReview)).toMatchObject({ to: "Retro" });
  });

  it("gives a new Step and Connector the ids /v1 answered with, a Step renamed since included", () => {
    const c = addStep(wf(), step.build);
    const reply = {
      ...c.next,
      steps: c.next.steps.map((s) => (isNew(s.id) ? { ...s, id: "st-new" } : s)),
      connectors: c.next.connectors.map((x) => (isNew(x.id) ? { ...x, id: "c-new", from_step_id: step.build, to_step_id: "st-new" } : x)),
    };
    const renamed = renameStep(c.next, c.select!, "Docs").next;
    const adopted = adoptIds(renamed, newIds(c.next, reply));
    expect(adopted.steps.find((s) => s.name === "Docs")!.id).toBe("st-new");
    expect(adopted.connectors.find((x) => x.name === "next")).toMatchObject({ id: "c-new", to_step_id: "st-new" });
  });

  it("applies a change made by a new Step's new:… id after /v1 named it, by the id it has now", () => {
    const c = addStep(wf(), step.build);
    const was = c.select!;
    const reply = adoptIds(c.next, newIds(c.next, { ...c.next, steps: c.next.steps.map((s) => (s.id === was ? { ...s, id: "st-new" } : s)) }));
    const renamed = new Map([[was, "st-new"]]);
    // Enter in its name as the reply lands: the field still knows it as new:….
    const change = changeAcross(reply, renamed, (w) => renameStep(w, was, "QA"));
    expect(change.next.steps.find((s) => s.id === "st-new")).toMatchObject({ name: "QA" });
    expect(change.next.steps.some((s) => isNew(s.id))).toBe(false);
    // Moves name Steps by the record's ids too.
    const gone = changeAcross(reply, renamed, (w) => deleteStep(w, was, step.review));
    expect(gone.next.steps.some((s) => s.id === "st-new")).toBe(false);
    // With nothing renamed, the change is made as it is.
    expect(changeAcross(wf(), new Map(), (w) => renameStep(w, step.build, "Make")).next.steps.find((s) => s.id === step.build)!.name).toBe("Make");
  });
});
