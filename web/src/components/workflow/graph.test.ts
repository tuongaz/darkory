import { describe, expect, it } from "vitest";
import { COLUMN_GAP, layoutSubtasks, NODE_H, NODE_W, PAD, takeableNow, type GraphSubtask } from "./graph";
import { crosses } from "./route";
import { sampleSteps, sampleSubtasks } from "./samples";

const layout = layoutSubtasks(sampleSteps, sampleSubtasks);
const node = (key: string) => layout.nodes.find((n) => n.subtask.key === key)!;

describe("layoutSubtasks", () => {
  it("makes a column per step holding an open Subtask, in the Workflow's order, then With <member>, then the ended", () => {
    expect(layout.columns.map((c) => c.title)).toEqual(["Build", "QA", "Review", "With Mai Tran", "Done · Dropped"]);
    expect(layout.columns.map((c) => c.kind)).toEqual(["step", "step", "step", "with", "ended"]);
    expect(layout.columns[0].skill).toBe("engineer");
    expect(layout.columns[3].member).toEqual({ id: "m-mai", name: "Mai Tran", kind: "human" });
    for (let i = 1; i < layout.columns.length; i++) {
      const [a, b] = [layout.columns[i - 1], layout.columns[i]];
      expect(b.x).toBe(a.x + a.width + COLUMN_GAP);
    }
  });

  it("puts each Subtask in its Step's column, the aimed one with its Member, the ended at the right", () => {
    expect(node("MAIN-6").column).toBe("step:s-build");
    expect(node("MAIN-9").column).toBe("step:s-qa");
    expect(node("MAIN-5").column).toBe("step:s-review");
    expect(node("MAIN-10").column).toBe("with:Mai Tran");
    for (const key of ["MAIN-3", "MAIN-4", "MAIN-12"]) expect(node(key).column).toBe("ended");
    // Done above dropped.
    expect(node("MAIN-12").row).toBeGreaterThan(Math.max(node("MAIN-3").row, node("MAIN-4").row));
  });

  it("stands a Subtask one layer right of what blocks it in the same column, so the arrow points right", () => {
    expect(node("MAIN-6").layer).toBe(node("MAIN-7").layer);
    expect(node("MAIN-11").layer).toBe(node("MAIN-6").layer + 1);
    expect(node("MAIN-8").layer).toBe(node("MAIN-7").layer + 1);
    expect(node("MAIN-11").x).toBeGreaterThan(node("MAIN-6").x + NODE_W);
  });

  it("gives a Subtask its blocker's row when it is free, so the arrow runs straight", () => {
    expect(node("MAIN-11").row).toBe(node("MAIN-6").row);
    expect(node("MAIN-8").row).toBe(node("MAIN-7").row);
    const straight = layout.edges.find((e) => e.id === "t-6->t-11")!;
    expect(straight.points).toHaveLength(2);
    expect(straight.points[0].y).toBe(straight.points[1].y);
  });

  it("draws one arrow per Blocking inside the Parent, none crossing a node", () => {
    expect(layout.edges.map((e) => e.id).sort()).toEqual(["t-10->t-8", "t-5->t-7", "t-6->t-11", "t-7->t-8", "t-9->t-11"]);
    for (const e of layout.edges) {
      const others = layout.nodes.filter((n) => n.subtask.id !== e.from && n.subtask.id !== e.to).map((n) => ({ x: n.x, y: n.y, w: NODE_W, h: NODE_H }));
      expect(crosses(e.points, others), e.id).toBe(false);
    }
  });

  it("brings an arrow back from a blocker further along into the blocked from below or above", () => {
    const back = layout.edges.find((e) => e.id === "t-5->t-7")!;
    const blocked = node("MAIN-7");
    expect(back.points[0].x).toBe(node("MAIN-5").x);
    const last = back.points.at(-1)!;
    expect([blocked.y, blocked.y + NODE_H]).toContain(last.y);
    expect(last.x).toBeGreaterThan(blocked.x);
    expect(last.x).toBeLessThan(blocked.x + NODE_W);
  });

  it("highlights what someone can take now: open, unheld, unblocked, at a Step with a Skill or aimed at a Member", () => {
    expect(layout.nodes.filter((n) => n.takeable).map((n) => n.subtask.key).sort()).toEqual(["MAIN-10", "MAIN-5"]);
    const steps = new Map(sampleSteps.map((s) => [s.id, s]));
    const base: GraphSubtask = { id: "x", key: "MAIN-99", title: "x", stepId: "s-build", state: "open", blockedBy: [], kind: "work" };
    expect(takeableNow(base, steps)).toBe(true);
    expect(takeableNow({ ...base, stepId: "s-backlog" }, steps)).toBe(false);
    expect(takeableNow({ ...base, holder: { name: "builder-1", kind: "agent" } }, steps)).toBe(false);
    // A blocker outside this Parent still blocks, though no arrow is drawn to it.
    expect(takeableNow({ ...base, blockedBy: ["elsewhere"] }, steps)).toBe(false);
    expect(takeableNow({ ...base, state: "done" }, steps)).toBe(false);
  });

  it("draws each Subtask's glyph from its record", () => {
    expect(node("MAIN-6").glyph).toEqual({ glyph: "working", holderKind: "agent", session: "running" });
    expect(node("MAIN-9").glyph).toEqual({ glyph: "working", holderKind: "agent", session: "waiting" });
    expect(node("MAIN-7").glyph).toEqual({ glyph: "blocked" });
    expect(node("MAIN-3").glyph).toEqual({ glyph: "done" });
    expect(node("MAIN-12").glyph).toEqual({ glyph: "dropped" });
    const atHold = layoutSubtasks(sampleSteps, [{ id: "h", key: "MAIN-1", title: "h", stepId: "s-backlog", state: "open", blockedBy: [], kind: "work" }]);
    expect(atHold.nodes[0].glyph).toEqual({ glyph: "hold" });
  });

  it("lays out nothing for a Parent without Subtasks", () => {
    const empty = layoutSubtasks(sampleSteps, []);
    expect(empty).toMatchObject({ columns: [], nodes: [], edges: [], width: 2 * PAD });
  });
});
