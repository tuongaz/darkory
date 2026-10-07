import { glyphFor, type MemberKind, type SessionState, type WorkGlyph, type Working } from "@/lib/work";
import type { Point } from "./model";

/** A step of the Project's Workflow, as the graph's columns need it. */
export type GraphStep = { id: string; name: string; skill?: { id: string; name: string } };

/** A Subtask as the graph draws it. M4 binds `TaskDetail.subtasks` to this. */
export type GraphSubtask = {
  id: string;
  key: string;
  title: string;
  /** Its step; null when it is aimed at a Member or has ended. */
  stepId: string | null;
  state: "open" | "done" | "dropped";
  /** Who holds it under a live Claim. */
  holder?: { name: string; kind: MemberKind };
  /** What the holder's mark says: their Runner session's state, or `held` for a human. */
  working?: Working;
  /** The Member it is aimed at by name: it waits with them, at no step. */
  aimedAt?: { name: string; kind: MemberKind };
  /** Its open blockers' ids. A Blocking may cross Parents, so an id may name a Task not drawn. */
  blockedBy: string[];
  kind: "work" | "breakdown" | "acceptance" | "retrospective";
};

export type ColumnKind = "step" | "with" | "ended";

export type GraphColumn = {
  id: string;
  kind: ColumnKind;
  title: string;
  /** A step column's Skill; none on a hold. */
  skill?: string;
  /** A "With <member>" column's Member. */
  member?: { name: string; kind: MemberKind };
  x: number;
  width: number;
};

export type GraphNode = {
  subtask: GraphSubtask;
  column: string;
  layer: number;
  row: number;
  x: number;
  y: number;
  glyph: WorkGlyph;
  /** Open, unheld, unblocked, and at a step with a Skill or aimed at a Member: someone can take it now. */
  takeable: boolean;
};

/** A Blocking, from the blocker to the Task it blocks, as a polyline of right angles. */
export type GraphEdge = { id: string; from: string; to: string; points: Point[] };

export type GraphLayout = { columns: GraphColumn[]; nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number };

export const NODE_W = 208;
export const NODE_H = 56;
/** Between the layers inside one column, between columns, between rows. */
export const LAYER_GAP = 40;
export const COLUMN_GAP = 48;
export const ROW_GAP = 24;
/** The column headings, above the first row. */
export const HEADER_H = 36;
/** Round the graph: room for an arrow that leaves the first or the last layer, or the last row. */
export const PAD = 24;

const firstRowY = HEADER_H + 8;
const rowY = (row: number) => firstRowY + row * (NODE_H + ROW_GAP);

/**
 * Someone can take it now: open, nobody holds it, nothing open blocks it, and it is at a step
 * whose Skill someone takes it under, or aimed at the Member who takes it (CONTEXT.md, Takeable).
 */
export function takeableNow(s: GraphSubtask, steps: Map<string, GraphStep>): boolean {
  if (s.state !== "open" || s.holder || s.blockedBy.length > 0) return false;
  if (s.stepId) return !!steps.get(s.stepId)?.skill;
  return !!s.aimedAt;
}

function keyNumber(key: string): number {
  return Number(key.match(/(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function sessionOf(working?: Working): SessionState | undefined {
  return working && working !== "held" ? working : undefined;
}

/**
 * Lays a Parent's Subtasks over its Project's Workflow:
 *
 * - **Columns**: the steps that hold an open Subtask, in the Workflow's order; then one "With
 *   <member>" column per Member an open Subtask is aimed at; then one for the ended, done above
 *   dropped.
 * - **Layers**: inside a column, a Subtask stands one layer right of the deepest Subtask of the
 *   same column that blocks it, so a Blocking inside a column points right.
 * - **Rows**: one grid across the graph. Left to right, a Subtask takes the row of a Subtask it
 *   is joined to by a Blocking when that row is free in its layer, so most arrows run straight;
 *   the rest take the first free row, by key.
 * - **Arrows** run at right angles through the gutters between layers and the gaps between rows,
 *   which hold no node, so no arrow crosses a node; arrows sharing a gutter or a gap take lanes
 *   of their own.
 */
export function layoutSubtasks(steps: GraphStep[], subtasks: GraphSubtask[]): GraphLayout {
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const byId = new Map(subtasks.map((s) => [s.id, s]));

  // Columns, and which column each Subtask is in.
  const columnOf = new Map<string, string>();
  const columns: Omit<GraphColumn, "x" | "width">[] = [];
  const open = subtasks.filter((s) => s.state === "open");
  for (const step of steps) {
    const here = open.filter((s) => s.stepId === step.id);
    if (here.length === 0) continue;
    columns.push({ id: `step:${step.id}`, kind: "step", title: step.name, skill: step.skill?.name });
    for (const s of here) columnOf.set(s.id, `step:${step.id}`);
  }
  for (const s of open) {
    if (columnOf.has(s.id)) continue;
    const name = s.aimedAt?.name ?? "";
    const id = `with:${name}`;
    if (!columns.some((c) => c.id === id)) {
      columns.push(s.aimedAt ? { id, kind: "with", title: `With ${name}`, member: s.aimedAt } : { id, kind: "with", title: "At no step" });
    }
    columnOf.set(s.id, id);
  }
  const ended = subtasks.filter((s) => s.state !== "open");
  if (ended.length > 0) {
    const states = new Set(ended.map((s) => s.state));
    const title = states.size === 2 ? "Done · Dropped" : states.has("done") ? "Done" : "Dropped";
    columns.push({ id: "ended", kind: "ended", title });
    for (const s of ended) columnOf.set(s.id, "ended");
  }

  // Layers inside each column, by how deep a Blocking from the same column goes.
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const s = byId.get(id)!;
    let d = 0;
    for (const b of s.blockedBy) {
      if (!byId.has(b) || columnOf.get(b) !== columnOf.get(id) || seen.has(b)) continue;
      d = Math.max(d, depthOf(b, new Set(seen).add(id)) + 1);
    }
    depth.set(id, d);
    return d;
  };
  for (const s of subtasks) depthOf(s.id, new Set([s.id]));

  // Every layer of the graph, left to right, and its x.
  type Layer = { column: string; x: number; ids: string[] };
  const layers: Layer[] = [];
  const placedColumns: GraphColumn[] = [];
  let cursor = PAD;
  for (const c of columns) {
    const ids = subtasks.filter((s) => columnOf.get(s.id) === c.id).map((s) => s.id);
    const count = Math.max(...ids.map((id) => depth.get(id)!)) + 1;
    for (let l = 0; l < count; l++) {
      layers.push({ column: c.id, x: cursor + l * (NODE_W + LAYER_GAP), ids: ids.filter((id) => depth.get(id) === l) });
    }
    const width = count * NODE_W + (count - 1) * LAYER_GAP;
    placedColumns.push({ ...c, x: cursor, width });
    cursor += width + COLUMN_GAP;
  }
  const width = columns.length > 0 ? cursor - COLUMN_GAP + PAD : 2 * PAD;

  // Rows: one grid, filled left to right.
  const layerOf = new Map<string, number>();
  layers.forEach((l, i) => l.ids.forEach((id) => layerOf.set(id, i)));
  const rowOf = new Map<string, number>();
  const taken = new Set<string>();
  const neighbours = (id: string) => [...byId.get(id)!.blockedBy.filter((b) => byId.has(b)), ...subtasks.filter((s) => s.blockedBy.includes(id)).map((s) => s.id)];
  layers.forEach((layer, li) => {
    const wanted = (id: string) => {
      const rows = neighbours(id).flatMap((n) => (rowOf.has(n) ? [rowOf.get(n)!] : []));
      return rows.length > 0 ? Math.min(...rows) : undefined;
    };
    const order = [...layer.ids].sort((a, b) => {
      const wa = wanted(a) ?? Infinity;
      const wb = wanted(b) ?? Infinity;
      if (wa !== wb) return wa - wb;
      // In the ended column, the done ones above the dropped.
      const dropped = Number(byId.get(a)!.state === "dropped") - Number(byId.get(b)!.state === "dropped");
      return dropped || keyNumber(byId.get(a)!.key) - keyNumber(byId.get(b)!.key);
    });
    for (const id of order) {
      let row = wanted(id) ?? 0;
      while (taken.has(`${li}:${row}`)) row++;
      taken.add(`${li}:${row}`);
      rowOf.set(id, row);
    }
  });
  const rows = Math.max(0, ...rowOf.values()) + 1;
  const height = subtasks.length === 0 ? firstRowY : rowY(rows - 1) + NODE_H + ROW_GAP + PAD;

  const nodes: GraphNode[] = subtasks.map((s) => {
    const li = layerOf.get(s.id)!;
    const step = s.stepId ? stepById.get(s.stepId) : undefined;
    return {
      subtask: s,
      column: columnOf.get(s.id)!,
      layer: li,
      row: rowOf.get(s.id)!,
      x: layers[li].x,
      y: rowY(rowOf.get(s.id)!),
      glyph: glyphFor({
        state: s.state,
        held: !!s.holder,
        holderKind: s.holder?.kind,
        session: sessionOf(s.working),
        blocked: s.blockedBy.length > 0,
        atHold: !!step && !step.skill,
      }),
      takeable: takeableNow(s, stepById),
    };
  });

  return { columns: placedColumns, nodes, edges: route(subtasks, layers, layerOf, rowOf, taken), width, height };
}

/**
 * The arrows, at right angles, turning only in a gutter (the free strip beside a layer) or a row
 * gap (the free strip between rows), and running along a row's middle only where that row is
 * empty between the two ends. Forward, from the blocker's right side into the blocked's left.
 * Back (the blocker stands to the right, further along the Workflow), from the blocker's left
 * side along the gap beside the blocked's row and up or down into it, so it reads as going back
 * and leaves the blocked's sides to the arrows that run forward.
 */
function route(
  subtasks: GraphSubtask[],
  layers: { x: number }[],
  layerOf: Map<string, number>,
  rowOf: Map<string, number>,
  taken: Set<string>,
): GraphEdge[] {
  // Gutter g is the strip left of layer g (gutter layers.length is right of the last); gap k the
  // strip above row k.
  const gutter = (g: number): [number, number] => [
    g === 0 ? layers[0].x - PAD : layers[g - 1].x + NODE_W,
    g === layers.length ? layers[g - 1].x + NODE_W + PAD : layers[g].x,
  ];
  const gapY = (k: number) => rowY(k) - ROW_GAP / 2;
  const middle = (row: number) => rowY(row) + NODE_H / 2;
  const clear = (row: number, from: number, to: number) => {
    for (let l = Math.min(from, to) + 1; l < Math.max(from, to); l++) if (taken.has(`${l}:${row}`)) return false;
    return true;
  };

  type Leg = { gutter?: number; gap?: number };
  type Shape = "straight" | "elbow" | "via-row" | "via-gap" | "back";
  type Plan = { id: string; from: string; to: string; a: number; z: number; ra: number; rb: number; sx: number; ex: number; legs: Leg[]; shape: Shape };
  const plans: Plan[] = [];
  for (const t of subtasks) {
    for (const b of t.blockedBy) {
      if (!layerOf.has(b)) continue;
      const a = layerOf.get(b)!;
      const z = layerOf.get(t.id)!;
      const ra = rowOf.get(b)!;
      const rb = rowOf.get(t.id)!;
      const id = `${b}->${t.id}`;
      const base = { id, from: b, to: t.id, a, z, ra, rb };
      if (a > z) {
        // Into the blocked from above when the blocker's row is higher, else from below.
        const gap = ra < rb ? rb : rb + 1;
        plans.push({ ...base, sx: layers[a].x, ex: layers[z].x + NODE_W / 2, legs: [{ gutter: a }, { gap }], shape: "back" });
        continue;
      }
      // Forward, out of the right side into the left; within one layer (a Blocking cycle), out
      // of and back into the right side.
      const sx = layers[a].x + NODE_W;
      const ex = a === z ? layers[z].x + NODE_W : layers[z].x;
      const out = a + 1;
      const into = a === z ? a + 1 : z;
      if (a !== z && ra === rb && clear(ra, a, z)) plans.push({ ...base, sx, ex, legs: [], shape: "straight" });
      else if (out === into) plans.push({ ...base, sx, ex, legs: [{ gutter: out }], shape: "elbow" });
      else if (clear(rb, a, z) && rb !== ra) plans.push({ ...base, sx, ex, legs: [{ gutter: out }], shape: "via-row" });
      else {
        const gap = rb > ra ? rb : rb + 1;
        plans.push({ ...base, sx, ex, legs: [{ gutter: out }, { gap }, { gutter: into }], shape: "via-gap" });
      }
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
    const [left, right] = gutter(g);
    const users = lanes.get(`g${g}`)!;
    return Math.round(left + ((users.indexOf(id) + 1) * (right - left)) / (users.length + 1));
  };
  const laneY = (k: number, id: string) => {
    const users = lanes.get(`r${k}`)!;
    const spread = Math.min(6, ROW_GAP / (users.length + 1));
    return Math.round(gapY(k) + (users.indexOf(id) - (users.length - 1) / 2) * spread);
  };

  // Ends: arrows meeting one side of a node spread along it, in the order they come from.
  const ends = new Map<string, string[]>();
  const sideOf = (p: Plan, end: "from" | "to") => {
    if (end === "from") return `${p.from}@${p.sx}`;
    if (p.shape !== "back") return `${p.to}@${p.ex}`;
    return `${p.to}@${p.ra < p.rb ? "top" : "bottom"}`;
  };
  for (const p of [...plans].sort((p, q) => p.sx - q.sx || p.ra - q.ra || p.rb - q.rb)) {
    for (const end of ["from", "to"] as const) ends.set(sideOf(p, end), [...(ends.get(sideOf(p, end)) ?? []), p.id]);
  }
  const spread = (p: Plan, end: "from" | "to", at: number, step: number) => {
    const users = ends.get(sideOf(p, end))!;
    return Math.round(at + (users.indexOf(p.id) - (users.length - 1) / 2) * step);
  };

  return plans.map((p) => {
    const sy = spread(p, "from", middle(p.ra), 10);
    const start = { x: p.sx, y: sy };
    let points: Point[];
    if (p.shape === "back") {
      const g1 = laneX(p.legs[0].gutter!, p.id);
      const gy = laneY(p.legs[1].gap!, p.id);
      const ex = spread(p, "to", p.ex, 16);
      const edge = p.ra < p.rb ? rowY(p.rb) : rowY(p.rb) + NODE_H;
      points = [start, { x: g1, y: sy }, { x: g1, y: gy }, { x: ex, y: gy }, { x: ex, y: edge }];
      return { id: p.id, from: p.from, to: p.to, points };
    }
    const ey = spread(p, "to", middle(p.rb), 10);
    const end = { x: p.ex, y: ey };
    switch (p.shape) {
      case "straight": {
        const mid = Math.round((p.sx + p.ex) / 2);
        points = sy === ey ? [start, end] : [start, { x: mid, y: sy }, { x: mid, y: ey }, end];
        break;
      }
      case "elbow":
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
