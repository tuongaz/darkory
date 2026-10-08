import { describe, expect, it } from "vitest";
import { DONE_NODE, DROPPED_NODE, endsOf, routesOf, stepLabel, toEdges, toNodes } from "./flow";
import { RANK_GAP, ROW_GAP, STEP_H, STEP_W, terminals, tidy } from "./layout";
import { connectProblem, deleteProblem, durationText, isHold, outgoing, unstaffed, waitingAt, type Step, type Workflow } from "./model";
import { sampleWorkflow } from "./samples";

const step = (id: string) => sampleWorkflow.steps.find((s) => s.id === id)!;
const pitch = STEP_W + RANK_GAP;

describe("tidy", () => {
  const at = tidy(sampleWorkflow);

  it("places every Step, and only the Steps, on whole pixels from (0, 0)", () => {
    expect(Object.keys(at).sort()).toEqual(sampleWorkflow.steps.map((s) => s.id).sort());
    for (const p of Object.values(at)) {
      expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
    }
    expect(Math.min(...Object.values(at).map((p) => p.x))).toBe(0);
    expect(Math.min(...Object.values(at).map((p) => p.y))).toBe(0);
  });

  it("lays ranks left to right, 240px apart edge to edge", () => {
    expect(at["s-qa"].x - at["s-build"].x).toBe(pitch);
    expect(at["s-review"].x - at["s-qa"].x).toBe(pitch);
    expect(at["s-skill-review"].x - at["s-retro"].x).toBe(pitch);
    for (const p of Object.values(at)) expect(p.x % pitch).toBe(0);
  });

  it("stands a Step nothing leads into in the first rank, not beside Done", () => {
    for (const id of ["s-backlog", "s-plan", "s-build", "s-retro"]) expect(at[id].x).toBe(0);
  });

  it("lays a Connector back into an earlier Step as if it pointed forward", () => {
    // Acceptance → Build "fail" would put Acceptance left of Build if laid as drawn.
    expect(at["s-acceptance"].x).toBeGreaterThan(at["s-build"].x);
    expect(at["s-review"].x).toBeGreaterThan(at["s-build"].x);
  });

  it("keeps a chain level and no two steps overlapping", () => {
    expect(at["s-qa"].y).toBe(at["s-build"].y);
    expect(at["s-review"].y).toBe(at["s-build"].y);
    const boxes = Object.values(at);
    for (const a of boxes)
      for (const b of boxes) {
        if (a === b) continue;
        const apart = a.x + STEP_W <= b.x || b.x + STEP_W <= a.x || a.y + STEP_H + ROW_GAP <= b.y || b.y + STEP_H + ROW_GAP <= a.y;
        expect(apart).toBe(true);
      }
  });
});

describe("terminals", () => {
  it("stands Done one rank right of the rightmost Step, level with what leads into it, Dropped under it", () => {
    const { done, dropped } = terminals(sampleWorkflow);
    const rightmost = Math.max(...sampleWorkflow.steps.map((s) => s.x));
    expect(done.x).toBe(rightmost + pitch);
    expect(dropped.x).toBe(done.x);
    expect(dropped.y).toBeGreaterThan(done.y);
    const feeding = ["s-plan", "s-review", "s-acceptance", "s-retro", "s-skill-review"].map(step);
    const middle = feeding.reduce((n, s) => n + s.y + STEP_H / 2, 0) / feeding.length;
    expect(Math.abs(done.y + 20 - middle)).toBeLessThanOrEqual(1);
  });
});

describe("the Workflow's rules, in words before sending", () => {
  it("knows a hold, a Step nobody can take from, and what waits", () => {
    expect(isHold(step("s-backlog"))).toBe(true);
    expect(isHold(step("s-build"))).toBe(false);
    expect(unstaffed(step("s-build"))).toBe(false);
    expect(unstaffed({ ...step("s-build"), takers: [] })).toBe(true);
    expect(unstaffed({ ...step("s-backlog"), takers: [] })).toBe(false);
    expect(waitingAt(step("s-build"))).toBe(2);
    expect(outgoing(sampleWorkflow, "s-review").map((c) => c.name)).toEqual(["pass", "needs changes"]);
  });

  it("refuses a Connector into Dropped, back into its own step, or to a Step that is gone", () => {
    expect(connectProblem(sampleWorkflow, { from: "s-build", to: "s-qa" })).toBeUndefined();
    expect(connectProblem(sampleWorkflow, { from: "s-build", to: null })).toBeUndefined();
    expect(connectProblem(sampleWorkflow, { from: "s-build", to: "dropped" })).toBe("Dropped needs no Connector: a Task's Owner drops it from any Step.");
    expect(connectProblem(sampleWorkflow, { from: "s-build", to: "s-build" })).toBe("A Connector leads out of Build into another Step or Done.");
    expect(connectProblem(sampleWorkflow, { from: "s-build", to: "s-gone" })).toBe("That step is gone.");
  });

  it("asks where a deleted step's Tasks go, as /v1 refuses step_in_use", () => {
    expect(deleteProblem(sampleWorkflow, step("s-retro"))).toBeUndefined();
    expect(deleteProblem(sampleWorkflow, step("s-build"))).toBe("4 Tasks are at Build: say which Step they move to.");
    expect(deleteProblem(sampleWorkflow, step("s-build"), "s-build")).toBe("Pick another Step of this Workflow.");
    expect(deleteProblem(sampleWorkflow, step("s-build"), "s-qa")).toBeUndefined();
  });

  it("says a median in the unit it reads best in", () => {
    expect(durationText(25 * 60_000)).toBe("25 min");
    expect(durationText(3 * 3_600_000)).toBe("3 h");
    expect(durationText(72 * 3_600_000)).toBe("3 d");
  });
});

describe("the canvas's nodes and edges", () => {
  it("lists the Steps in the Workflow's order, then Done and Dropped, which never move", () => {
    const nodes = toNodes(sampleWorkflow, "edit");
    expect(nodes.map((n) => n.id)).toEqual([...[...sampleWorkflow.steps].sort((a, b) => a.position - b.position).map((s) => s.id), DONE_NODE, DROPPED_NODE]);
    expect(nodes.filter((n) => n.type === "terminal").every((n) => n.draggable === false && n.selectable === false)).toBe(true);
    expect(nodes.find((n) => n.id === DROPPED_NODE)!.connectable).toBe(false);
    expect(toNodes(sampleWorkflow, "live").every((n) => n.draggable === false && n.connectable === false)).toBe(true);
  });

  it("names a Step for a screen reader: its Skill, counts, and who takes it, or that nobody can", () => {
    expect(stepLabel(step("s-build"))).toBe("Build: Skill engineer; 2 waiting, 2 working; taken by builder-1 (agent), builder-2 (agent), Mai Tran");
    expect(stepLabel(step("s-backlog"))).toBe("Backlog: a hold, moved on by hand; 3 waiting, 0 working");
    const docs: Step = { ...step("s-build"), name: "Docs", skill: { id: "k-docs", name: "docs" }, takers: [], tasks: 0, working: 0 };
    expect(stepLabel(docs)).toBe("Docs: Skill docs; 0 waiting, 0 working; no Member has docs");
  });

  it("draws each Connector along its route, fastened where the route leaves and enters", () => {
    const nodes = toNodes(sampleWorkflow, "live");
    const edges = toEdges(sampleWorkflow, "live", routesOf(sampleWorkflow, nodes));
    expect(edges).toHaveLength(sampleWorkflow.connectors.length);
    const pass = edges.find((e) => e.id === "c-build-qa")!;
    expect(pass).toMatchObject({ source: "s-build", target: "s-qa", sourceHandle: "out", targetHandle: "in", ariaLabel: "Build to QA: pass" });
    const fail = edges.find((e) => e.id === "c-qa-build")!;
    expect(fail.sourceHandle).toBe("out-left");
    expect(["in-bottom", "in-top"]).toContain(fail.targetHandle);
    expect(edges.find((e) => e.id === "c-review-done")).toMatchObject({ target: DONE_NODE, targetHandle: "in", ariaLabel: "Review to Done: pass" });
  });

  it("reads a drawn connection's ends as a Connector's", () => {
    expect(endsOf({ source: "s-build", target: DONE_NODE })).toEqual({ from: "s-build", to: null });
    expect(endsOf({ source: "s-build", target: DROPPED_NODE })).toEqual({ from: "s-build", to: "dropped" });
    expect(endsOf({ source: "s-build", target: "s-qa" })).toEqual({ from: "s-build", to: "s-qa" });
  });

  it("draws an empty Workflow as Done and Dropped alone", () => {
    const empty: Workflow = { steps: [], connectors: [] };
    expect(toNodes(empty, "edit").map((n) => n.id)).toEqual([DONE_NODE, DROPPED_NODE]);
    expect(tidy(empty)).toEqual({});
  });
});
