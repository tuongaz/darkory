import { glyphFor, type MemberKind, type SessionState, type WorkGlyph, type Working } from "@/lib/work";
import { routeGrid, type GridArrow, type GridEdge } from "./gridRoute";

/** A Step of the Project's Workflow, as the graph's columns need it. */
/** A Step as a graph draws it; `workflowId` names its Workflow, where the drawing keeps to one. */
export type GraphStep = { id: string; name: string; workflowId?: string; skill?: { id: string; name: string } };

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
  /** The Member it is aimed at by name: it waits with them, at no Step. */
  aimedAt?: { name: string; kind: MemberKind };
  /** Its open blockers' ids. A Blocking may cross Parents, so an id may name a Task not drawn. */
  blockedBy: string[];
  /**
   * The open Tasks outside the Parent joined to it by a Blocking: those blocking it (`in`) and
   * those it blocks (`out`). Each is drawn as a stub under it, linking to that Task.
   */
  outside?: OutsideLink[];
  kind: "work" | "breakdown" | "acceptance" | "retrospective";
};

/** An open Task outside the Parent that blocks a Subtask (`in`) or that a Subtask blocks (`out`). */
export type OutsideLink = { direction: "in" | "out"; id: string; key: string; title: string };

export type ColumnKind = "step" | "with" | "ended";

export type GraphColumn = {
  id: string;
  kind: ColumnKind;
  title: string;
  /** A Step column's Skill; none on a hold. */
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
  /** Open, unheld, unblocked, and at a Step with a Skill or aimed at a Member: someone can take it now. */
  takeable: boolean;
  /** Its stubs, blockers first, each at `y` under the node. */
  stubs: (OutsideLink & { y: number })[];
};

/** A Blocking, from the blocker to the Task it blocks, as a polyline of right angles. */
export type GraphEdge = GridEdge;

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
/** An outside stub's height, and the space above the first under its node. */
export const STUB_H = 22;
export const STUB_GAP = 6;

const firstRowY = HEADER_H + 8;

/**
 * Someone can take it now: open, nobody holds it, nothing open blocks it, and it is at a Step
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
 * - **Columns**: the Steps that hold an open Subtask, in the Workflow's order; then one "With
 *   <member>" column per Member an open Subtask is aimed at; then one for the ended, done above
 *   dropped.
 * - **Layers**: inside a column, a Subtask stands one layer right of the deepest Subtask of the
 *   same column that blocks it, so a Blocking inside a column points right.
 * - **Rows**: one grid across the graph. Left to right, a Subtask takes the row of a Subtask it
 *   is joined to by a Blocking when that row is free in its layer, so most arrows run straight;
 *   the rest take the first free row, by key.
 * - **Arrows** run at right angles through the gutters between layers and the gaps between rows,
 *   which hold no node, so no arrow crosses a node; arrows sharing a gutter or a gap take lanes
 *   of their own (`routeGrid`).
 * - **Outside**: a Blocking that crosses the Parent is a stub under its Subtask ("← MAIN-12",
 *   "→ MAIN-19"), and its row grows to hold the stubs, so no arrow runs through one.
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
      columns.push(s.aimedAt ? { id, kind: "with", title: `With ${name}`, member: s.aimedAt } : { id, kind: "with", title: "At no Step" });
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
  // A row grows by the stubs under its nodes.
  const stubsOf = (s: GraphSubtask) => [...(s.outside ?? [])].sort((a, b) => Number(a.direction === "out") - Number(b.direction === "out") || keyNumber(a.key) - keyNumber(b.key));
  const extra = Array.from({ length: rows }, () => 0);
  for (const s of subtasks) {
    const n = s.outside?.length ?? 0;
    if (n > 0) extra[rowOf.get(s.id)!] = Math.max(extra[rowOf.get(s.id)!], STUB_GAP + n * STUB_H);
  }
  const tops = [firstRowY];
  for (let r = 1; r <= rows; r++) tops.push(tops[r - 1] + NODE_H + extra[r - 1] + ROW_GAP);
  const rowY = (row: number) => tops[row];
  const height = subtasks.length === 0 ? firstRowY : tops[rows] + PAD;

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
      stubs: stubsOf(s).map((o, i) => ({ ...o, y: rowY(rowOf.get(s.id)!) + NODE_H + STUB_GAP + i * STUB_H })),
    };
  });

  const arrows: GridArrow[] = subtasks.flatMap((t) =>
    t.blockedBy.filter((b) => layerOf.has(b)).map((b) => ({ id: `${b}->${t.id}`, from: b, to: t.id, a: layerOf.get(b)!, z: layerOf.get(t.id)!, ra: rowOf.get(b)!, rb: rowOf.get(t.id)! })),
  );
  const layerX = layers.map((l) => l.x);
  const edges = routeGrid(
    {
      layerX,
      nodeW: NODE_W,
      nodeH: NODE_H,
      rowY,
      gutter: (g) => [g === 0 ? layerX[0] - PAD : layerX[g - 1] + NODE_W, g === layers.length ? layerX[g - 1] + NODE_W + PAD : layerX[g]],
      gap: (k) => [k === 0 ? firstRowY - ROW_GAP : tops[k - 1] + NODE_H + extra[k - 1], tops[k]],
      taken,
    },
    arrows,
  );
  return { columns: placedColumns, nodes, edges, width, height };
}
