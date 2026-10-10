import { describe, expect, it } from "vitest";
import { BIG, MAIN } from "./fixtures";
import { lineTopology } from "./layout";
import { DONE_STATION, sideSteps, startStep, type LineWorkflow } from "./model";

/** The one Workflow of the Steps written here. */
const work = { id: "work", name: "Work", position: 1 };

/*
 * The rule of the line where Tasks enter it: no line without words, and nothing looks like a flow
 * unless a Task really moves along it.
 */

describe("where Tasks enter the line (MAIN)", () => {
  const t = lineTopology(MAIN);

  it("starts the rail at Build; Plan stands before it, Backlog parked beside it", () => {
    expect(t.start).toBe("build");
    expect(t.main[0]).toBe("build");
    expect(t.before).toBe("plan");
    expect(t.holds).toEqual(["backlog"]);
  });

  it("names Plan's outcome into Done in words beside it, with its sentence", () => {
    const chip = t.chips.find((c) => c.stepId === "plan")!;
    expect(chip.text).toBe("done → Done");
    expect(chip.hint).toBe("Plan → Done: when the holder says done, and the Task is complete");
  });
});

describe("where a filed Task starts (the server's defaultStep)", () => {
  const step = (id: string, skill?: string) => ({ id, workflow_id: work.id, name: id, position: 0, ...(skill ? { skill: { name: skill } } : {}) });
  const wf = (...steps: ReturnType<typeof step>[]): LineWorkflow => ({ workflows: [work], steps: steps.map((s, i) => ({ ...s, position: i + 1 })), connectors: [] });

  it("is the first Step for the Project's own work", () => {
    expect(startStep(MAIN)).toBe("build");
    expect(startStep(BIG)).toBe("triage");
  });

  it("is the first Step with any Skill when every Skill is builtin", () => {
    expect(startStep(wf(step("hold"), step("plan", "breakdown"), step("acc", "acceptance")))).toBe("plan");
  });

  it("is the first Step when none carries a Skill, and none with no Steps", () => {
    expect(startStep(wf(step("a"), step("b")))).toBe("a");
    expect(startStep(wf())).toBeUndefined();
  });

  it("goes by position, not by the order the Steps come in", () => {
    expect(
      startStep({
        workflows: [work],
        steps: [
          { id: "z", workflow_id: work.id, name: "z", position: 2, skill: { name: "x" } },
          { id: "y", workflow_id: work.id, name: "y", position: 1, skill: { name: "y" } },
        ],
        connectors: [],
      }),
    ).toBe("y");
  });
});

describe("which Steps leave the main line", () => {
  const s = (id: string, position: number, skill?: string) => ({ id, workflow_id: work.id, name: id, position, ...(skill ? { skill: { name: skill } } : {}) });
  const c = (from: string, to: string | null, name = "pass") => ({ id: `${from}>${to}:${name}`, from, to, name, position: 1 });

  it("never takes the start Step off, even a breakdown Step or a hold", () => {
    expect(sideSteps({ workflows: [work], steps: [s("plan", 1, "breakdown")], connectors: [] }).before.size).toBe(0);
    const t = lineTopology({ workflows: [work], steps: [s("a", 1), s("b", 2)], connectors: [] });
    expect(t.start).toBe("a");
    expect(t.main).toEqual(["a", DONE_STATION]);
    expect(t.holds).toEqual(["b"]);
  });

  it("keeps a breakdown Step a main-line Step leads into on the line", () => {
    const t = lineTopology({ workflows: [work], steps: [s("triage", 1, "triage"), s("plan", 2, "breakdown"), s("build", 3, "engineer")], connectors: [c("triage", "plan"), c("plan", "build")] });
    expect(t.before).toBeUndefined();
    expect(t.main).toEqual(["triage", "plan", "build", DONE_STATION]);
  });

  it("takes off only the first breakdown Step: Darkory files every Breakdown there", () => {
    const sides = sideSteps({ workflows: [work], steps: [s("p1", 1, "breakdown"), s("build", 2, "engineer"), s("p2", 3, "breakdown")], connectors: [] });
    expect([...sides.before]).toEqual(["p1"]);
  });

  it("parks a hold with no Connector, and keeps one joined by a Connector on the line, its dotted segments saying by hand", () => {
    const wf: LineWorkflow = { workflows: [work], steps: [s("parked", 1), s("build", 2, "engineer"), s("wait", 3), s("ship", 4, "release")], connectors: [c("build", "wait"), c("ship", null)] };
    const t = lineTopology(wf);
    expect(t.holds).toEqual(["parked"]);
    expect(t.main).toEqual(["build", "wait", "ship", DONE_STATION]);
    expect(t.segments.map((x) => (x.connector ? x.connector.name : x.hand ? "by hand" : "gap"))).toEqual(["pass", "by hand", "pass"]);
  });

  it("keeps Acceptance off the line when only the breakdown Step leads into it", () => {
    const t = lineTopology({ workflows: [work], steps: [s("plan", 1, "breakdown"), s("build", 2, "engineer"), s("acc", 3, "acceptance")], connectors: [c("plan", "acc"), c("build", null), c("acc", null)] });
    expect(t.before).toBe("plan");
    expect(t.rows.map((r) => r.stations)).toEqual([["acc"]]);
    expect(t.chips.map((x) => `${x.stepId}: ${x.text}`)).toEqual(["plan: pass → acc"]);
  });
});

describe("a start Step that is not the line's first", () => {
  it("starts the rail there; a Backlog joined by a Connector stays on the line before it (BIG)", () => {
    const t = lineTopology(BIG);
    expect(t.main[0]).toBe("backlog");
    expect(t.start).toBe("triage");
  });

  it("parks the holds no Connector joins and takes the breakdown Step off, the rail starting at the start Step", () => {
    const s = (id: string, position: number, skill?: string) => ({ id, workflow_id: work.id, name: id, position, ...(skill ? { skill: { name: skill } } : {}) });
    const t = lineTopology({
      workflows: [work],
      steps: [s("parked", 1), s("intake", 2), s("plan", 3, "breakdown"), s("build", 4, "engineer")],
      connectors: [{ id: "k", from: "intake", to: "build", name: "ready", position: 1 }],
    });
    expect(t.main).toEqual(["intake", "build", DONE_STATION]);
    expect(t.start).toBe("build");
    expect(t.before).toBe("plan");
    expect(t.holds).toEqual(["parked"]);
  });
});
