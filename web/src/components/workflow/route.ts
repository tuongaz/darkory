import type { Point } from "./model";

/** A node's box on the canvas: top-left corner and size. */
export type Rect = { x: number; y: number; w: number; h: number };
export type Side = "left" | "right" | "top" | "bottom";

/** A Connector to route: `order` is its place among the Connectors out of its Step. */
export type RouteRequest = { id: string; from: string; to: string; label: string; order: number; terminal?: boolean };

export type Route = {
  points: Point[];
  /** Where its outcome's name sits: just past where it leaves its Step, reading away from it. */
  label: Point & { align: "left" | "right" };
  exit: "left" | "right";
  entry: Side;
};

/** How far a line keeps from a node it passes. */
const CLEAR = 12;
/** The straight run into a node, for the arrowhead. */
const STUB = 20;
/** Between lines sharing a gutter or a channel. */
const LANE = 10;
/** Between lines leaving or entering one side of a node. */
const SPREAD = 20;
/** A turn costs this many pixels of length; entering a Step from the side it leaves by, more. */
const BEND = 40;
const SIDE_ENTRY = 600;

/** An outcome's name, drawn at 11px, as wide as the canvas reckons it. */
export function labelWidth(name: string): number {
  return Math.round(name.length * 6.2 + 14);
}

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;
const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;

/** Whether the segment a→b (level or upright) passes through a box grown by `CLEAR / 2`. */
function hits(a: Point, b: Point, r: Rect): boolean {
  const m = CLEAR / 2;
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x1 > r.x - m && x0 < right(r) + m && y1 > r.y - m && y0 < bottom(r) + m;
}

export function crosses(points: Point[], obstacles: Rect[]): boolean {
  for (let i = 1; i < points.length; i++) for (const r of obstacles) if (hits(points[i - 1], points[i], r)) return true;
  return false;
}

function length(points: Point[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  return n;
}

/** The points with repeats and straight-through points dropped. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const before = out[out.length - 2];
    if (before && last && ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))) out.pop();
    out.push(p);
  }
  return out;
}

/**
 * Level lines between `x0` and `x1` that pass no box: the middles of the free gaps between the
 * boxes standing across that span, and one line above them all and one below.
 */
function channels(x0: number, x1: number, boxes: Rect[]): number[] {
  const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)];
  const across = boxes.filter((r) => right(r) + CLEAR > a && r.x - CLEAR < b).map((r) => [r.y - CLEAR, bottom(r) + CLEAR] as const);
  if (across.length === 0) return [];
  across.sort((p, q) => p[0] - q[0]);
  const ys = [across[0][0] - CLEAR];
  let reach = across[0][1];
  for (const [top, end] of across.slice(1)) {
    if (top > reach) ys.push(Math.round((reach + top) / 2));
    reach = Math.max(reach, end);
  }
  ys.push(reach + CLEAR);
  return ys;
}

type Channel = { kind: "start" } | { kind: "end" } | { kind: "free"; y: number };
type Plan = {
  req: RouteRequest;
  S: Rect;
  T: Rect;
  exit: "left" | "right";
  entry: Side;
  channel: Channel;
  // Filled in once every Connector has its shape: where it leaves and enters, its gutters.
  sy: number;
  end: number;
  x1: number;
  x2: number;
};

/**
 * Routes a Workflow's Connectors at right angles round its nodes. Each leaves its Step by the
 * side facing where it goes, its outcome's name beside the Step, turns in the gutter past the
 * name, runs along a level line that passes no node, and enters its target: forward into the
 * left side, back (to a Step left of its own) from below or above, so the line reads as going
 * back. Lines leaving or entering one side spread along it; lines sharing a gutter or a level
 * take lanes, ordered so that they do not cross near the nodes.
 */
export function routeConnectors(boxes: Map<string, Rect>, requests: RouteRequest[], extra: Rect[] = []): Map<string, Route> {
  const all = [...boxes.values(), ...extra];
  const plans: Plan[] = [];

  for (const req of requests) {
    const S = boxes.get(req.from);
    const T = boxes.get(req.to);
    if (!S || !T || req.from === req.to) continue;
    const others = all.filter((r) => r !== S && r !== T);
    const room = labelWidth(req.label) + 16;
    const forward = req.terminal || T.x >= right(S) + 2 * STUB;
    type Option = { cost: number; exit: "left" | "right"; entry: Side; channel: Channel };
    const options: Option[] = [];
    const consider = (points: Point[], o: Omit<Option, "cost">, penalty = 0, obstacles = others) => {
      if (crosses(points, obstacles)) return;
      options.push({ ...o, cost: length(points) + BEND * (simplify(points).length - 2) + penalty });
    };

    if (forward) {
      const [sx, sy, ex, ey] = [right(S), cy(S), T.x, cy(T)];
      const x1 = Math.min(sx + room, (sx + ex) / 2);
      const x2 = Math.max(ex - STUB, x1);
      const via = (y: number) => [{ x: sx, y: sy }, { x: x1, y: sy }, { x: x1, y }, { x: x2, y }, { x: x2, y: ey }, { x: ex, y: ey }];
      consider(via(sy), { exit: "right", entry: "left", channel: { kind: "start" } });
      consider(via(ey), { exit: "right", entry: "left", channel: { kind: "end" } });
      for (const y of channels(x1, x2, others)) consider(via(y), { exit: "right", entry: "left", channel: { kind: "free", y } });
    } else {
      // Back: out of the left side, along a level clear of everything, into the target from
      // below or above; from its right side only when nothing else will do.
      const [sx, sy] = [S.x, cy(S)];
      const x1 = sx - room;
      const tx = cx(T);
      const withT = [...others, T];
      for (const y of channels(x1, tx, withT)) {
        if (y > bottom(T)) {
          const points = [{ x: sx, y: sy }, { x: x1, y: sy }, { x: x1, y }, { x: tx, y }, { x: tx, y: bottom(T) }];
          consider(points, { exit: "left", entry: "bottom", channel: { kind: "free", y } });
        } else if (y < T.y) {
          const points = [{ x: sx, y: sy }, { x: x1, y: sy }, { x: x1, y }, { x: tx, y }, { x: tx, y: T.y }];
          consider(points, { exit: "left", entry: "top", channel: { kind: "free", y } });
        }
      }
      if (right(T) + 2 * STUB < x1) {
        const [ex, ey] = [right(T), cy(T)];
        const x2 = ex + STUB;
        const via = (y: number) => [{ x: sx, y: sy }, { x: x1, y: sy }, { x: x1, y }, { x: x2, y }, { x: x2, y: ey }, { x: ex, y: ey }];
        consider(via(sy), { exit: "left", entry: "right", channel: { kind: "start" } }, SIDE_ENTRY);
        consider(via(ey), { exit: "left", entry: "right", channel: { kind: "end" } }, SIDE_ENTRY);
        for (const y of channels(x1, x2, others)) consider(via(y), { exit: "left", entry: "right", channel: { kind: "free", y } }, SIDE_ENTRY);
      }
    }
    // With nowhere clear (nodes dragged over each other), the shortest way, through what it must.
    const best = options.sort((p, q) => p.cost - q.cost)[0] ?? {
      exit: forward ? "right" : "left",
      entry: forward ? "left" : "bottom",
      channel: forward ? { kind: "start" } : { kind: "free", y: bottom(T) + 2 * CLEAR },
    };
    plans.push({ req, S, T, exit: best.exit, entry: best.entry, channel: best.channel, sy: 0, end: 0, x1: 0, x2: 0 });
  }

  // The level each runs along, before lanes: where it goes, for ordering the ends.
  const level = (p: Plan) => (p.channel.kind === "free" ? p.channel.y : p.channel.kind === "start" ? cy(p.S) : cy(p.T));

  // The ends on one side of a node, leaving and entering alike, spread along it in the order of
  // the levels their lines run at, so no outcome's name sits on another line's arrowhead.
  type End = { p: Plan; leaves: boolean };
  const ends = new Map<string, End[]>();
  const at = (key: string, end: End) => ends.set(key, [...(ends.get(key) ?? []), end]);
  for (const p of plans) {
    at(`${p.req.from}:${p.exit}`, { p, leaves: true });
    if (p.entry === "left" || p.entry === "right") at(`${p.req.to}:${p.entry}`, { p, leaves: false });
  }
  ends.forEach((list) => {
    const box = list[0].leaves ? list[0].p.S : list[0].p.T;
    list.sort((a, b) => level(a.p) - level(b.p) || Number(a.leaves) - Number(b.leaves) || a.p.req.order - b.p.req.order);
    const step = Math.min(SPREAD, (box.h - 8) / list.length);
    list.forEach((e, i) => {
      const y = Math.round(cy(box) + (i - (list.length - 1) / 2) * step);
      if (e.leaves) e.p.sy = y;
      else e.p.end = y;
    });
  });

  // Leaving: the gutter past the names, the line nearest its turn's far end turning first.
  group(plans, (p) => `${p.req.from}:${p.exit}`).forEach((list) => {
    const S = list[0].S;
    list.sort((p, q) => p.sy - q.sy);
    const room = Math.max(...list.map((p) => labelWidth(p.req.label))) + 16;
    lanes(list, (p) => level(p) < p.sy).forEach((lane, p) => {
      if (p.exit === "right") {
        const limit = p.entry === "left" ? (right(S) + p.T.x) / 2 : Infinity;
        p.x1 = Math.round(Math.min(right(S) + room, limit) + lane * LANE);
      } else p.x1 = Math.round(S.x - room - lane * LANE);
    });
  });

  // Entering a side: the gutter, as leaving; on a side that lines also leave by, the turn comes
  // past their names, so no name sits on it. From below or above: spread along by where they
  // come from.
  group(plans, (p) => `${p.req.to}:${p.entry}`).forEach((list) => {
    const T = list[0].T;
    const side = list[0].entry;
    if (side === "left" || side === "right") {
      const leaving = plans.filter((q) => q.req.from === list[0].req.to && q.exit === side);
      const clear = leaving.length > 0 ? Math.max(...leaving.map((q) => labelWidth(q.req.label))) + 16 + leaving.length * LANE : STUB;
      list.sort((p, q) => p.end - q.end);
      lanes(list, (p) => level(p) < p.end).forEach((lane, p) => {
        p.x2 = side === "left" ? Math.max(T.x - clear - lane * LANE, p.x1) : right(T) + clear + lane * LANE;
      });
    } else {
      list.sort((p, q) => p.x1 - q.x1);
      list.forEach((p, i) => (p.end = Math.round(cx(T) + (i - (list.length - 1) / 2) * SPREAD)));
    }
  });

  // Sharing a level: lanes across it. Into a Step from below, the line entering further right
  // runs nearer the Step (from above, likewise), so neither crosses the other's last leg.
  const free = plans.filter((p) => p.channel.kind === "free");
  const along = (p: Plan) => (p.entry === "bottom" ? -p.end : p.entry === "top" ? p.end : Math.min(p.x1, p.x2));
  group(free, (p) => String(Math.round((p.channel as { y: number }).y / LANE))).forEach((list) => {
    list.sort((p, q) => along(p) - along(q));
    list.forEach((p, i) => ((p.channel as { y: number }).y += Math.round((i - (list.length - 1) / 2) * LANE)));
  });

  const routes = new Map<string, Route>();
  for (const p of plans) {
    const { S, T } = p;
    const sx = p.exit === "right" ? right(S) : S.x;
    const y = p.channel.kind === "free" ? p.channel.y : p.channel.kind === "start" ? p.sy : p.end;
    let points: Point[];
    if (p.entry === "left" || p.entry === "right") {
      const ex = p.entry === "left" ? T.x : right(T);
      points = [{ x: sx, y: p.sy }, { x: p.x1, y: p.sy }, { x: p.x1, y }, { x: p.x2, y }, { x: p.x2, y: p.end }, { x: ex, y: p.end }];
    } else {
      const ey = p.entry === "bottom" ? bottom(T) : T.y;
      points = [{ x: sx, y: p.sy }, { x: p.x1, y: p.sy }, { x: p.x1, y }, { x: p.end, y }, { x: p.end, y: ey }];
    }
    routes.set(p.req.id, {
      points: simplify(points),
      label: { x: p.exit === "right" ? sx + 8 : sx - 8, y: p.sy, align: p.exit === "right" ? "left" : "right" },
      exit: p.exit,
      entry: p.entry,
    });
  }
  return routes;
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

/**
 * Lanes for lines along one side, in its order: those turning up are numbered from the top, those
 * turning down from the bottom, so the line turning first is the one whose turn crosses nothing.
 */
function lanes<T>(sorted: T[], up: (item: T) => boolean): Map<T, number> {
  const out = new Map<T, number>();
  const ups = sorted.filter(up);
  const downs = sorted.filter((p) => !up(p)).reverse();
  ups.forEach((p, i) => out.set(p, i));
  downs.forEach((p, i) => out.set(p, i));
  return out;
}

/** A polyline as an SVG path whose corners are rounded by up to `radius`. */
export function roundedPath(points: Point[], radius = 6): string {
  if (points.length === 0) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(radius, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2);
    const towards = (q: Point, len: number) => {
      const l = Math.hypot(q.x - c.x, q.y - c.y) || 1;
      return { x: c.x + ((q.x - c.x) / l) * len, y: c.y + ((q.y - c.y) / l) * len };
    };
    const a = towards(p, r);
    const b = towards(n, r);
    d += ` L ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}
