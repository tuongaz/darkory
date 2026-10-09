import { describe, expect, it } from "vitest";
import { ada, bob, builder, engineer, skills, step, task, workflow } from "@/test/fixtures";
import { toBody, toCanvas, workingAt } from "./bind";
import { addOutcome, deleteStep, fromRecord, renameOutcome, renameStep, setTarget } from "./edit/draft";
import { problem } from "./edits";

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
    const sessions = [{ task_id: "k-1", member_id: builder.id, session_id: "s", host: "h", started_at: "", state: "stalled" as const, state_since: "", log_path: "" }];
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
  it("sends the whole Workflow as GET gave it: its Workflows, ids, Skills, positions 1…n, places, Connectors by id", () => {
    const body = toBody(wf());
    expect(body.workflows).toEqual([{ id: "wf-work", name: "Work", position: 1 }]);
    expect(body.steps).toHaveLength(6);
    expect(at(body, "Backlog")).toEqual({ id: step.backlog, workflow: "wf-work", name: "Backlog", position: 1, x: 0, y: 0 });
    expect(at(body, "Build")).toEqual({ id: step.build, workflow: "wf-work", name: "Build", skill: engineer.id, position: 3, x: 0, y: 256 });
    expect(out(body, step.review)).toEqual([
      { id: `${step.review}-c3`, from: step.review, name: "pass", position: 1 },
      { id: `${step.review}-c4`, from: step.review, to: step.build, name: "needs changes", position: 2 },
    ]);
    expect(body.moves).toBeUndefined();
  });

});

describe("what /v1 would refuse, in words", () => {
  const current = workflow(undefined, { build: { tasks: 2 } });
  const d = () => fromRecord(current);
  const twin = () => {
    const r = addOutcome(d(), step.review);
    return renameOutcome(r.draft, r.id, "PASS").wf;
  };
  it.each([
    ["a blank name", renameStep(d(), step.plan, " ").wf, "A Step needs a name."],
    ["a name used twice", renameStep(d(), step.plan, "build").wf, "Two Steps are called build"],
    ["an outcome used twice out of one Step", twin(), "Two outcomes out of Review are called pass"],
    ["a blank outcome", renameOutcome(d(), `${step.review}-c3`, "").wf, "An outcome out of Review needs a name."],
    ["a Connector into its own step", setTarget(d(), `${step.review}-c3`, step.review).wf, "A Connector leads out of Review into another Step or Done."],
    ["a deleted step's Tasks with nowhere to go", deleteStep(d(), step.build).wf, "2 Tasks are at Build: say which Step they move to."],
  ])("refuses %s", (_, next, words) => {
    expect(problem(next, current)).toContain(words);
  });

  it("takes a deleted step's Tasks moved to a Step it keeps, and refuses one it deletes", () => {
    const c = deleteStep(d(), step.build, step.review);
    expect(problem(c.wf, current, c.moves)).toBeUndefined();
    expect(problem(c.wf, current, { [step.build]: step.build })).toBe("Build's Tasks must move to a Step the Workflow keeps.");
  });
});
