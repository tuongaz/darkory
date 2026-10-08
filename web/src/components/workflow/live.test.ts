import { describe, expect, it } from "vitest";
import { boxesOf, DONE_NODE, routesOf, stepBoxes, toNodes, tokenPath, type CanvasNode } from "./flow";
import { CHIP_ROW, settle, STEP_H, STEP_W, stepHeight, terminals } from "./layout";
import type { TaskChip, Workflow } from "./model";
import { crosses } from "./route";
import { defaultWorkflow, sampleWorkflow } from "./samples";

const chips = (n: number): TaskChip[] => Array.from({ length: n }, (_, i) => ({ id: `t-${i}`, key: `WEB-${i}`, title: `Task ${i}` }));
const withChips = (w: Workflow, counts: Record<string, number>): Workflow => ({
  ...w,
  steps: w.steps.map((s) => ({ ...s, chips: chips(counts[s.id] ?? 0) })),
});

describe("a live Step's height", () => {
  it("is the editing size with no Task, a row a chip up to three, and one more row past three", () => {
    expect(stepHeight(0)).toBe(STEP_H);
    expect(stepHeight(1) - stepHeight(0)).toBeGreaterThanOrEqual(CHIP_ROW);
    expect(stepHeight(3) - stepHeight(2)).toBe(CHIP_ROW);
    expect(stepHeight(4) - stepHeight(3)).toBe(CHIP_ROW);
    expect(stepHeight(40)).toBe(stepHeight(4));
  });
});

describe("settle", () => {
  it("moves a Step down by what the Steps above it in its column grew, keeping each gap", () => {
    // The default Workflow stacks Backlog, Plan and Build 128px apart in one column; Review beside Build.
    const at = settle([
      { id: "backlog", x: 0, y: 0, h: stepHeight(2) },
      { id: "plan", x: 0, y: 128, h: stepHeight(1) },
      { id: "build", x: 0, y: 256, h: STEP_H },
      { id: "review", x: 448, y: 256, h: STEP_H },
    ]);
    const grew = (n: number) => stepHeight(n) - STEP_H;
    expect(at.get("backlog")!.y).toBe(0);
    expect(at.get("plan")!.y).toBe(128 + grew(2));
    expect(at.get("build")!.y).toBe(256 + grew(2) + grew(1));
    // Review is in another column: it stays.
    expect(at.get("review")!.y).toBe(256);
    // The gap under each stays the 40px it was.
    expect(at.get("plan")!.y - (at.get("backlog")!.y + at.get("backlog")!.h)).toBe(40);
    expect(at.get("build")!.y - (at.get("plan")!.y + at.get("plan")!.h)).toBe(40);
  });

  it("moves a Step overlapping two columns by the larger growth", () => {
    const at = settle([
      { id: "a", x: 0, y: 0, h: stepHeight(1) },
      { id: "b", x: 300, y: 0, h: stepHeight(4) },
      { id: "c", x: 150, y: 200, h: STEP_H },
    ]);
    expect(at.get("c")!.y).toBe(200 + stepHeight(4) - STEP_H);
  });
});

describe("the live canvas's nodes", () => {
  const live = withChips(defaultWorkflow, { [defaultWorkflow.steps[0].id]: 2, [defaultWorkflow.steps[1].id]: 5 });

  it("draws each Step as tall as its chips, settled so no two overlap, 208px wide still", () => {
    const nodes = toNodes(live, "live");
    const steps = nodes.filter((n) => n.type === "step");
    for (const n of steps) {
      expect(n.width).toBe(STEP_W);
      expect(n.height).toBe(stepHeight(live.steps.find((s) => s.id === n.id)!.chips!.length));
    }
    for (const a of steps)
      for (const b of steps) {
        if (a === b) continue;
        const apart = a.position.x + STEP_W <= b.position.x || b.position.x + STEP_W <= a.position.x || a.position.y + a.height! <= b.position.y || b.position.y + b.height! <= a.position.y;
        expect(apart, `${a.id} and ${b.id}`).toBe(true);
      }
  });

  it("fastens the Connectors at the middle of a grown Step's sides and the foot of it", () => {
    const step = toNodes(live, "live").find((n) => n.id === live.steps[1].id)!;
    const h = step.height!;
    expect(step.handles!.find((x) => x.id === "in")!.y).toBe(h / 2 - 4);
    expect(step.handles!.find((x) => x.id === "in-bottom")!.y).toBe(h - 4);
  });

  it("routes every Connector round the grown nodes", () => {
    const grown = withChips(sampleWorkflow, Object.fromEntries(sampleWorkflow.steps.map((s, i) => [s.id, i % 5])));
    const nodes = toNodes(grown, "live");
    const { boxes, extra } = boxesOf(nodes);
    const routes = routesOf(grown, nodes);
    expect(routes.size).toBe(grown.connectors.length);
    for (const c of grown.connectors) {
      const others = [...boxes].filter(([id]) => id !== c.from && id !== (c.to ?? DONE_NODE)).map(([, r]) => r);
      expect(crosses(routes.get(c.id)!.points, [...others, ...extra]), c.id).toBe(false);
    }
  });

  it("stands Done level with the grown Steps that lead into it", () => {
    const boxes = stepBoxes(live, "live");
    const { done } = terminals(live, boxes);
    const feeding = live.steps.filter((s) => live.connectors.some((c) => c.from === s.id && c.to === null)).map((s) => boxes.get(s.id)!);
    const middle = feeding.reduce((n, b) => n + b.y + b.h / 2, 0) / feeding.length;
    expect(Math.abs(done.y + 20 - middle)).toBeLessThanOrEqual(1);
  });

  it("editing, draws every Step the size Tidy up lays out, chips or none", () => {
    expect(toNodes(live, "edit").filter((n) => n.type === "step").every((n) => n.height === STEP_H)).toBe(true);
  });
});

describe("a token's way", () => {
  const nodes: CanvasNode[] = toNodes(sampleWorkflow, "live");
  const routes = routesOf(sampleWorkflow, nodes);

  it("is the Connector's drawn line when the Task went along one", () => {
    const d = tokenPath({ id: 1, key: "WEB-1", travel: { from: "s-build", to: "s-qa", connectorId: "c-build-qa" } }, nodes, routes);
    expect(d).toMatch(/^M /);
    const start = routes.get("c-build-qa")!.points[0];
    expect(d!.startsWith(`M ${start.x} ${start.y}`)).toBe(true);
  });

  it("is a way of its own round the nodes when it was moved by hand, or dropped", () => {
    expect(tokenPath({ id: 2, key: "WEB-2", travel: { from: "s-backlog", to: "s-review" } }, nodes, routes)).toMatch(/^M /);
    expect(tokenPath({ id: 3, key: "WEB-3", travel: { from: "s-build", to: "dropped" } }, nodes, routes)).toMatch(/^M /);
  });
});
