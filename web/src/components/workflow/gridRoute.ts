import type { Point } from "./model";

/**
 * A grid of nodes, all one size, in layers along x and rows along y: what the Subtask graph and
 * the Blocking view lay their nodes on and route their Blocking arrows through. Between the
 * layers run the gutters, between the rows the gaps; neither holds a node.
 */
export type Grid = {
  /** Each layer's left edge, left to right. */
  layerX: number[];
  nodeW: number;
  nodeH: number;
  /** A row's top edge. */
  rowY: (row: number) => number;
  /** The free strip left of layer `g`, as [left, right]; `g = layerX.length` is right of the last. */
  gutter: (g: number) => [number, number];
  /** The free strip above row `k`, as [top, bottom]; one past the last row is below it. */
  gap: (k: number) => [number, number];
  /** The cells holding a node, as `${layer}:${row}`. */
  taken: Set<string>;
};

/** A Blocking to draw, from the blocker's cell (layer `a`, row `ra`) to the blocked's (`z`, `rb`). */
export type GridArrow = { id: string; from: string; to: string; a: number; z: number; ra: number; rb: number };

/** A Blocking, from the blocker to the Task it blocks, as a polyline of right angles. */
export type GridEdge = { id: string; from: string; to: string; points: Point[] };

/**
 * The arrows, at right angles, turning only in a gutter or a gap, and running along a row's
 * middle only where that row is empty between the two ends. Forward, from the blocker's right
 * side into the blocked's left. Back (the blocker stands to the right), from the blocker's left
 * side along the gap beside the blocked's row and up or down into it, so it reads as going back
 * and leaves the blocked's sides to the arrows that run forward.
 *
 * A forward arrow between rows turns in the gutter beside its blocker (`early`) and runs along
 * the blocked's row when that row is clear, or with `turnLate` runs first along the blocker's
 * row and turns in the gutter beside the blocked; failing both, it crosses in the gap beside the
 * blocked's row.
 */
export function routeGrid(grid: Grid, arrows: GridArrow[], { turnLate = false }: { turnLate?: boolean } = {}): GridEdge[] {
  const { layerX, nodeW, nodeH, rowY, taken } = grid;
  const gapY = (k: number) => {
    const [top, bottom] = grid.gap(k);
    return (top + bottom) / 2;
  };
  const middle = (row: number) => rowY(row) + nodeH / 2;
  const clear = (row: number, from: number, to: number) => {
    for (let l = Math.min(from, to) + 1; l < Math.max(from, to); l++) if (taken.has(`${l}:${row}`)) return false;
    return true;
  };

  type Leg = { gutter?: number; gap?: number };
  type Shape = "straight" | "elbow" | "via-row" | "late" | "via-gap" | "back";
  type Plan = GridArrow & { sx: number; ex: number; legs: Leg[]; shape: Shape };
  const plans: Plan[] = [];
  for (const arrow of arrows) {
    const { a, z, ra, rb } = arrow;
    if (a > z) {
      // Into the blocked from above when the blocker's row is higher, else from below.
      const gap = ra < rb ? rb : rb + 1;
      plans.push({ ...arrow, sx: layerX[a], ex: layerX[z] + nodeW / 2, legs: [{ gutter: a }, { gap }], shape: "back" });
      continue;
    }
    // Forward, out of the right side into the left; within one layer (a Blocking cycle), out
    // of and back into the right side.
    const sx = layerX[a] + nodeW;
    const ex = a === z ? layerX[z] + nodeW : layerX[z];
    const out = a + 1;
    const into = a === z ? a + 1 : z;
    if (a !== z && ra === rb && clear(ra, a, z)) plans.push({ ...arrow, sx, ex, legs: [], shape: "straight" });
    else if (out === into) plans.push({ ...arrow, sx, ex, legs: [{ gutter: out }], shape: "elbow" });
    else if (turnLate && clear(ra, a, z)) plans.push({ ...arrow, sx, ex, legs: [{ gutter: into }], shape: "late" });
    else if (clear(rb, a, z) && rb !== ra) plans.push({ ...arrow, sx, ex, legs: [{ gutter: out }], shape: "via-row" });
    else {
      const gap = rb > ra ? rb : rb + 1;
      plans.push({ ...arrow, sx, ex, legs: [{ gutter: out }, { gap }, { gutter: into }], shape: "via-gap" });
    }
  }

  // Lanes: the arrows using one gutter or one gap spread evenly across it, by where they start.
  const lanes = new Map<string, string[]>();
  for (const p of [...plans].sort((p, q) => p.sx - q.sx || p.ra - q.ra))
    for (const leg of p.legs) {
      const key = leg.gutter !== undefined ? `g${leg.gutter}` : `r${leg.gap}`;
      lanes.set(key, [...(lanes.get(key) ?? []), p.id]);
    }
  const laneX = (g: number, id: string) => {
    const [left, right] = grid.gutter(g);
    const users = lanes.get(`g${g}`)!;
    return Math.round(left + ((users.indexOf(id) + 1) * (right - left)) / (users.length + 1));
  };
  const laneY = (k: number, id: string) => {
    const [top, bottom] = grid.gap(k);
    const users = lanes.get(`r${k}`)!;
    const spread = Math.min(6, (bottom - top) / (users.length + 1));
    return Math.round(gapY(k) + (users.indexOf(id) - (users.length - 1) / 2) * spread);
  };

  // Ends: arrows meeting one side of a node spread along it, in the order of the rows they come
  // from or go to, so two never cross at a node. With `turnLate`, the arrows out of one node
  // leave from one point and fork.
  const ends = new Map<string, string[]>();
  const sideOf = (p: Plan, end: "from" | "to") => {
    if (end === "from") return turnLate && p.shape !== "back" ? `${p.from}@out` : `${p.from}@${p.sx}`;
    if (p.shape !== "back") return `${p.to}@${p.ex}`;
    return `${p.to}@${p.ra < p.rb ? "top" : "bottom"}`;
  };
  for (const end of ["from", "to"] as const) {
    const other = (p: Plan) => (end === "from" ? p.rb : p.ra);
    for (const p of [...plans].sort((p, q) => other(p) - other(q) || p.sx - q.sx || p.ra - q.ra || p.rb - q.rb))
      ends.set(sideOf(p, end), [...(ends.get(sideOf(p, end)) ?? []), p.id]);
  }
  const spread = (p: Plan, end: "from" | "to", at: number, step: number) => {
    const users = ends.get(sideOf(p, end))!;
    return Math.round(at + (users.indexOf(p.id) - (users.length - 1) / 2) * step);
  };
  const alone = (p: Plan, end: "from" | "to") => ends.get(sideOf(p, end))!.length === 1;

  return plans.map((p) => {
    let sy = turnLate && p.shape !== "back" ? middle(p.ra) : spread(p, "from", middle(p.ra), 10);
    let points: Point[];
    if (p.shape === "back") {
      const start = { x: p.sx, y: sy };
      const g1 = laneX(p.legs[0].gutter!, p.id);
      const gy = laneY(p.legs[1].gap!, p.id);
      const ex = spread(p, "to", p.ex, 16);
      const edge = p.ra < p.rb ? rowY(p.rb) : rowY(p.rb) + nodeH;
      points = [start, { x: g1, y: sy }, { x: g1, y: gy }, { x: ex, y: gy }, { x: ex, y: edge }];
      return { id: p.id, from: p.from, to: p.to, points };
    }
    const ey = spread(p, "to", middle(p.rb), 10);
    // A straight arrow alone on its blocker's side leaves level with where it arrives.
    if (turnLate && p.shape === "straight" && alone(p, "from")) sy = ey;
    const start = { x: p.sx, y: sy };
    const end = { x: p.ex, y: ey };
    switch (p.shape) {
      case "straight": {
        const mid = Math.round((p.sx + p.ex) / 2);
        points = sy === ey ? [start, end] : [start, { x: mid, y: sy }, { x: mid, y: ey }, end];
        break;
      }
      case "elbow":
      case "late":
      case "via-row": {
        const gx = laneX(p.legs[0].gutter!, p.id);
        points = [start, { x: gx, y: sy }, { x: gx, y: ey }, end];
        break;
      }
      default: {
        const g1 = laneX(p.legs[0].gutter!, p.id);
        const gy = laneY(p.legs[1].gap!, p.id);
        const g2 = laneX(p.legs[2].gutter!, p.id);
        points = [start, { x: g1, y: sy }, { x: g1, y: gy }, { x: g2, y: gy }, { x: g2, y: ey }, end];
      }
    }
    return { id: p.id, from: p.from, to: p.to, points };
  });
}

type Segment = [Point, Point];

function segments(points: Point[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i++) if (points[i - 1].x !== points[i].x || points[i - 1].y !== points[i].y) out.push([points[i - 1], points[i]]);
  return out;
}

const level = ([a, b]: Segment) => a.y === b.y;
const between = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);

/** Whether two level-or-upright segments cross or run over each other. */
function meet(s: Segment, t: Segment): boolean {
  if (level(s) !== level(t)) {
    const [h, v] = level(s) ? [s, t] : [t, s];
    return between(v[0].x, h[0].x, h[1].x) && between(h[0].y, v[0].y, v[1].y);
  }
  if (level(s)) return s[0].y === t[0].y && Math.min(Math.max(s[0].x, s[1].x), Math.max(t[0].x, t[1].x)) > Math.max(Math.min(s[0].x, s[1].x), Math.min(t[0].x, t[1].x));
  return s[0].x === t[0].x && Math.min(Math.max(s[0].y, s[1].y), Math.max(t[0].y, t[1].y)) > Math.max(Math.min(s[0].y, s[1].y), Math.min(t[0].y, t[1].y));
}

/**
 * How many times two arrows cross or run over each other, counting each pair of segments once.
 * Two arrows leaving one point (one blocker's) or arriving at one point (one blocked's) share
 * that end without crossing.
 */
export function edgeCrossings(edges: { from: string; to: string; points: Point[] }[]): number {
  let n = 0;
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const [e, f] = [edges[i], edges[j]];
      const shared = (e.from === f.from && e.points[0].x === f.points[0].x && e.points[0].y === f.points[0].y) || (e.to === f.to && e.points.at(-1)!.x === f.points.at(-1)!.x && e.points.at(-1)!.y === f.points.at(-1)!.y);
      if (shared) continue;
      for (const s of segments(e.points)) for (const t of segments(f.points)) if (meet(s, t)) n++;
    }
  return n;
}
