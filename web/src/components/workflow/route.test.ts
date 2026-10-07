import { describe, expect, it } from "vitest";
import { boxesOf, DONE_NODE, routesOf, toNodes } from "./flow";
import type { Point, Workflow } from "./model";
import { crosses, labelWidth, routeConnectors, type Rect, type Route } from "./route";
import { defaultWorkflow, sampleWorkflow } from "./samples";

const nodes = toNodes(sampleWorkflow, "live");
const { boxes, extra } = boxesOf(nodes);
const routes = routesOf(sampleWorkflow, nodes);

// Every node but the route's own two ends, and Dropped's dashed arrow.
const obstaclesFor = (from: string, to: string): Rect[] => [...[...boxes].filter(([id]) => id !== from && id !== to).map(([, r]) => r), ...extra];

describe("routeConnectors", () => {
  it("routes every Connector of the sample round every node it does not join", () => {
    expect(routes.size).toBe(sampleWorkflow.connectors.length);
    for (const c of sampleWorkflow.connectors) {
      const route = routes.get(c.id)!;
      expect(crosses(route.points, obstaclesFor(c.from, c.to ?? DONE_NODE)), c.id).toBe(false);
    }
  });

  it("draws only right angles", () => {
    for (const route of routes.values())
      for (let i = 1; i < route.points.length; i++) {
        const [a, b] = [route.points[i - 1], route.points[i]];
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
  });

  it("runs forward out of the right side into the left, and back out of the left into the bottom or top", () => {
    const pass = routes.get("c-build-qa")!;
    const build = boxes.get("s-build")!;
    const qa = boxes.get("s-qa")!;
    expect(pass).toMatchObject({ exit: "right", entry: "left" });
    expect(pass.points[0].x).toBe(build.x + build.w);
    expect(pass.points.at(-1)!.x).toBe(qa.x);

    for (const id of ["c-qa-build", "c-review-build", "c-acceptance-build", "c-skill-review-retro"]) {
      const back = routes.get(id)!;
      expect(back.exit, id).toBe("left");
      expect(["bottom", "top"], id).toContain(back.entry);
    }
  });

  it("puts an outcome's name beside its step, on the side its line leaves by", () => {
    const pass = routes.get("c-build-qa")!;
    const build = boxes.get("s-build")!;
    expect(pass.label).toEqual({ x: build.x + build.w + 8, y: pass.points[0].y, align: "left" });
    const fail = routes.get("c-qa-build")!;
    expect(fail.label).toMatchObject({ x: boxes.get("s-qa")!.x - 8, align: "right" });
    // The line turns only past its name.
    expect(fail.points[1].x).toBeLessThanOrEqual(fail.label.x - labelWidth("fail"));
  });

  it("spreads the ends sharing one side, coming in and going out alike", () => {
    // QA's left side takes Build's "pass" in and sends "fail" back out.
    const into = routes.get("c-build-qa")!.points.at(-1)!.y;
    const out = routes.get("c-qa-build")!.points[0].y;
    expect(into).not.toBe(out);
    // Five Connectors into Done, each at its own height.
    const doneEnds = sampleWorkflow.connectors.filter((c) => c.to === null).map((c) => routes.get(c.id)!.points.at(-1)!.y);
    expect(new Set(doneEnds).size).toBe(doneEnds.length);
  });

  it("follows a step as it moves", () => {
    const moved = toNodes({ ...sampleWorkflow, steps: sampleWorkflow.steps.map((s) => (s.id === "s-qa" ? { ...s, y: s.y + 300 } : s)) }, "live");
    const again = routesOf(sampleWorkflow, moved).get("c-build-qa")!;
    expect(again.points.at(-1)!.y).toBeGreaterThan(routes.get("c-build-qa")!.points.at(-1)!.y + 200);
  });

  describe("the default Workflow at the places init stores", () => {
    const placedNodes = toNodes(defaultWorkflow, "live");
    const placed = boxesOf(placedNodes);
    const defaultRoutes = routesOf(defaultWorkflow, placedNodes);
    const all = defaultWorkflow.connectors.map((c) => ({ c, route: defaultRoutes.get(c.id)! }));
    const segments = (points: Point[]) => points.slice(1).map((b, i) => [points[i], b] as const);
    const labelBox = (r: Route, name: string): Rect => {
      const w = labelWidth(name);
      return { x: r.label.align === "left" ? r.label.x : r.label.x - w, y: r.label.y - 8, w, h: 16 };
    };
    const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

    it("stands where init puts it, Done one rank right of Review and Skill review", () => {
      expect(placed.boxes.get(DONE_NODE)!.x).toBe(896);
      expect(placed.boxes.get("s-review")).toMatchObject({ x: 448, y: 256 });
    });

    it("routes every Connector round every step it passes", () => {
      expect(defaultRoutes.size).toBe(defaultWorkflow.connectors.length);
      for (const { c, route } of all) {
        const to = c.to ?? DONE_NODE;
        const obstacles = [...[...placed.boxes].filter(([id]) => id !== c.from && id !== to).map(([, r]) => r), ...placed.extra];
        expect(crosses(route.points, obstacles), c.id).toBe(false);
      }
    });

    it("runs no two lines along each other", () => {
      for (const a of all)
        for (const b of all) {
          if (a === b) continue;
          for (const [p, q] of segments(a.route.points))
            for (const [r, t] of segments(b.route.points)) {
              const level = p.y === q.y && r.y === t.y && p.y === r.y;
              const upright = p.x === q.x && r.x === t.x && p.x === r.x;
              const along = level
                ? Math.min(Math.max(p.x, q.x), Math.max(r.x, t.x)) - Math.max(Math.min(p.x, q.x), Math.min(r.x, t.x))
                : upright
                  ? Math.min(Math.max(p.y, q.y), Math.max(r.y, t.y)) - Math.max(Math.min(p.y, q.y), Math.min(r.y, t.y))
                  : 0;
              expect(along, `${a.c.id} along ${b.c.id}`).toBeLessThanOrEqual(0);
            }
        }
    });

    it("sets no outcome's name on a step, another name, or another line", () => {
      for (const a of all) {
        const box = labelBox(a.route, a.c.name);
        for (const [id, r] of placed.boxes) expect(overlap(box, r), `${a.c.id} on ${id}`).toBe(false);
        for (const b of all) {
          if (a === b) continue;
          expect(overlap(box, labelBox(b.route, b.c.name)), `${a.c.id} on ${b.c.id}'s name`).toBe(false);
          const grown = { x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 };
          expect(crosses(b.route.points, [grown]), `${a.c.id}'s name on ${b.c.id}`).toBe(false);
        }
      }
    });
  });

  it("goes round a node standing between two steps", () => {
    const boxes = new Map<string, Rect>([
      ["a", { x: 0, y: 0, w: 100, h: 60 }],
      ["wall", { x: 300, y: -40, w: 100, h: 140 }],
      ["b", { x: 600, y: 0, w: 100, h: 60 }],
    ]);
    const route = routeConnectors(boxes, [{ id: "c", from: "a", to: "b", label: "pass", order: 0 }]).get("c")!;
    expect(crosses(route.points, [boxes.get("wall")!])).toBe(false);
    expect(route.points.length).toBeGreaterThan(2);
  });

  it("routes nothing for a Connector whose ends are missing or the same", () => {
    const w: Workflow = { steps: [], connectors: [] };
    expect(routesOf(w, toNodes(w, "live")).size).toBe(0);
    expect(routeConnectors(new Map([["a", { x: 0, y: 0, w: 10, h: 10 }]]), [{ id: "c", from: "a", to: "a", label: "x", order: 0 }]).size).toBe(0);
  });
});
