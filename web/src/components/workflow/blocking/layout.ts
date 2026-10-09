import type { MemberKind, Working } from "@/lib/work";
import { routeGrid, type GridArrow, type GridEdge } from "../gridRoute";
import type { Point } from "../model";

/**
 * An open Task as the Blocking view reads it. `blockedBy` holds the ids of the open Tasks
 * blocking it; a Blocking may cross Parents and Projects, so the view reads the Organisation's
 * open Tasks and draws the ones outside what it shows as outside nodes.
 */
export type BlockingTask = {
  id: string;
  key: string;
  title: string;
  projectId: string;
  parentId?: string;
  /** A Parent: at no Step, it neither blocks nor is blocked, and is never drawn. */
  parent: boolean;
  /** Its place in the Project's Rank, 1 first; a Subtask's is its Parent's. */
  rank: number;
  blockedBy: string[];
  /** The Step it is at; none when it is aimed at a Member (a question). */
  stepId?: string;
  /** When it reached its Step, or was filed or aimed. */
  since: number;
  holder?: { id: string; name: string; kind: MemberKind; working: Working };
  aimedAt?: { id: string; name: string; kind: MemberKind };
  /** Open, unheld, unblocked, at a Step with a Skill or aimed at a Member: someone can take it now. */
  takeable: boolean;
  /** The signed-in Member can take it now. */
  takeableByMe: boolean;
};

/** What the signed-in Member can do first: the act on a Task of theirs that unblocks the most. */
export type FirstAct = {
  id: string;
  /** Answer what is aimed at them, Continue what they hold, Take what they can take. */
  verb: "Answer" | "Continue" | "Take";
  /** The Tasks that become unblocked when it ends: it is their last open blocker. */
  unblocks: string[];
  /** Every Task downstream of it. */
  leadsTo: number;
};

export type BlockingAnalysis = {
  /** The Tasks drawn: those shown with a Blocking, and the outside Tasks joined to them. */
  nodes: string[];
  /** The Blockings, blocker first. */
  edges: [string, string][];
  /** How many must end before each can: 0 ends first. */
  depth: Map<string, number>;
  depths: number;
  /** Drawn but outside what is shown: in another Parent than the scope's, or another Project. */
  outside: Set<string>;
  /** The longest run of open Tasks each blocking the next; ties go to the higher Rank. */
  longest: string[];
  /** The Tasks shown without any Blocking, by Rank. */
  noBlocking: string[];
  /** The Tasks shown: open, not Parents, in the Project or the scope. */
  shown: number;
  blocked: number;
  first?: FirstAct;
  /** Takeable now by someone and blocking something, most downstream first. */
  takeableNow: { id: string; unblocks: string[] }[];
};

function keyNumber(key: string): number {
  return Number(key.match(/(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

/**
 * What the Blocking view shows of `projectId`'s open Tasks, or of `scope`'s: a Parent's
 * Subtasks, or one Task with what blocks it and what it blocks, all the way along. `tasks` is
 * every open Task known; `me` the signed-in Member. `shows`, on the page of one Workflow of
 * several, says which of the Project's Tasks are that page's (`ShownWorkflow.shows`): the rest
 * show only as outside Tasks joined to these, as another Project's do.
 */
export function analyseBlocking(tasks: readonly BlockingTask[], { projectId, scope, me, shows }: { projectId: string; scope?: string; me: string; shows?: (id: string) => boolean }): BlockingAnalysis {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const worked = (id: string) => byId.has(id) && !byId.get(id)!.parent;
  // Every Blocking between open worked Tasks, both ways.
  const blockers = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  for (const t of tasks) {
    if (t.parent) continue;
    const bs = t.blockedBy.filter(worked);
    blockers.set(t.id, bs);
    for (const b of bs) blocks.set(b, [...(blocks.get(b) ?? []), t.id]);
  }
  const ins = (id: string) => blockers.get(id) ?? [];
  const outs = (id: string) => blocks.get(id) ?? [];
  const reach = (from: string, next: (id: string) => string[]) => {
    const seen = new Set<string>();
    const walk = [from];
    while (walk.length)
      for (const n of next(walk.pop()!))
        if (!seen.has(n)) {
          seen.add(n);
          walk.push(n);
        }
    return seen;
  };

  // What is shown.
  const scoped = scope ? byId.get(scope) : undefined;
  let shownIds: string[];
  if (!scoped) shownIds = tasks.filter((t) => t.projectId === projectId && !t.parent && (!shows || shows(t.id))).map((t) => t.id);
  else if (scoped.parent) shownIds = tasks.filter((t) => t.parentId === scoped.id && !t.parent).map((t) => t.id);
  else shownIds = [scoped.id, ...reach(scoped.id, ins), ...reach(scoped.id, outs)];
  const shown = new Set(shownIds);

  const joined = (id: string) => ins(id).length > 0 || outs(id).length > 0;
  const nodeSet = new Set<string>();
  const edges: [string, string][] = [];
  for (const id of shown) {
    if (!joined(id)) continue;
    nodeSet.add(id);
    for (const b of ins(id)) {
      nodeSet.add(b);
      edges.push([b, id]);
    }
    for (const t of outs(id)) {
      nodeSet.add(t);
      if (!shown.has(t)) edges.push([id, t]);
    }
  }
  const outside = new Set([...nodeSet].filter((id) => !shown.has(id)));
  const order = (a: string, b: string) => byId.get(a)!.rank - byId.get(b)!.rank || keyNumber(byId.get(a)!.key) - keyNumber(byId.get(b)!.key);
  const nodes = [...nodeSet].sort(order);
  const into = (id: string) => edges.filter(([, t]) => t === id).map(([b]) => b);
  const from = (id: string) => edges.filter(([b]) => b === id).map(([, t]) => t);

  // Depth: one more than the deepest blocker. The record refuses a loop; a loop met anyway ends the walk.
  const depth = new Map<string, number>();
  const depthOf = (id: string, path: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    let d = 0;
    for (const b of into(id)) if (!path.has(b)) d = Math.max(d, depthOf(b, new Set(path).add(b)) + 1);
    depth.set(id, d);
    return d;
  };
  for (const id of nodes) depthOf(id, new Set([id]));
  const depths = nodes.length ? Math.max(...nodes.map((id) => depth.get(id)!)) + 1 : 0;

  // The longest chain: the most Tasks in a row, then the best Rank along it, then the lowest key.
  type Chain = { ids: string[]; rank: number };
  const better = (a: Chain, b: Chain) => a.ids.length - b.ids.length || b.rank - a.rank || keyNumber(byId.get(b.ids[0])!.key) - keyNumber(byId.get(a.ids[0])!.key);
  const ending = new Map<string, Chain>();
  for (const id of [...nodes].sort((a, b) => depth.get(a)! - depth.get(b)!)) {
    let best: Chain = { ids: [], rank: Infinity };
    for (const b of into(id)) if (depth.get(b)! < depth.get(id)! && better(ending.get(b)!, best) > 0) best = ending.get(b)!;
    ending.set(id, { ids: [...best.ids, id], rank: Math.min(best.rank, byId.get(id)!.rank) });
  }
  let longest: Chain = { ids: [], rank: Infinity };
  for (const c of ending.values()) if (better(c, longest) > 0) longest = c;

  // Every open blocker counts, drawn or not: outside the scope, MAIN-4 still blocks MAIN-19.
  const unblocks = (id: string) => from(id).filter((t) => ins(t).every((b) => b === id));
  const downstream = (id: string) => reach(id, from).size;
  const ready = (id: string) => into(id).length === 0;

  // First for you: what they can act on now that has the most downstream of it.
  const verb = (t: BlockingTask): FirstAct["verb"] | undefined => {
    if (t.holder?.id === me) return "Continue";
    if (t.aimedAt?.id === me && !t.holder) return "Answer";
    if (t.takeableByMe) return "Take";
    return undefined;
  };
  const acts = nodes
    .filter((id) => ready(id) && from(id).length > 0 && verb(byId.get(id)!))
    .map((id) => ({ id, verb: verb(byId.get(id)!)!, unblocks: unblocks(id), leadsTo: downstream(id) }))
    .sort((a, b) => b.leadsTo - a.leadsTo || b.unblocks.length - a.unblocks.length || order(a.id, b.id));

  const takeableNow = nodes
    .filter((id) => byId.get(id)!.takeable && ready(id) && from(id).length > 0)
    .sort((a, b) => downstream(b) - downstream(a) || order(a, b))
    .map((id) => ({ id, unblocks: unblocks(id) }));

  return {
    nodes,
    edges,
    depth,
    depths,
    outside,
    longest: longest.ids.length > 1 ? longest.ids : [],
    noBlocking: shownIds.filter((id) => !nodeSet.has(id)).sort(order),
    shown: shown.size,
    blocked: shownIds.filter((id) => ins(id).length > 0).length,
    first: acts[0],
    takeableNow,
  };
}

/** "Ends 1st", "Ends 2nd": a depth column's heading. */
export function endsText(depth: number): string {
  const n = depth + 1;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `Ends ${n}${suffix}`;
}

/** A band: the Tasks drawn under one Parent, or with none, in one Project. */
export type Band = {
  id: string;
  parentId?: string;
  projectId: string;
  /** Its Tasks are outside what is shown. */
  outside: boolean;
  /** Its box, round its header and nodes. */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PlacedNode = { id: string; band: string; depth: number; lane: number; x: number; y: number; w: number; h: number };

export type BlockingEdge = GridEdge & { longest: boolean };

export type BlockingLayout = {
  orientation: "across" | "down";
  bands: Band[];
  nodes: PlacedNode[];
  edges: BlockingEdge[];
  /** Across: each depth column's left edge, for its heading. */
  columns: { depth: number; x: number }[];
  width: number;
  height: number;
};

/**
 * Sizes. Across (a wide screen): depth runs left to right in columns, bands stack, a band's
 * lanes are its rows. Down (a phone): depth runs top to bottom inside each band, bands stack,
 * lanes stand side by side.
 */
export type Geometry = {
  orientation: "across" | "down";
  /** A node's width: what `fit` asks for, held between these. */
  minNodeW: number;
  maxNodeW: number;
  nodeH: number;
  /** Between depth columns (across) or depth rows (down). */
  gutter: number;
  /** Between lanes. */
  laneGap: number;
  /** A band's header strip, above its first nodes. */
  bandHeader: number;
  /** Inside a band, round its nodes. */
  bandPad: number;
  bandGap: number;
  /** Above the first band: the depth headings, across. */
  top: number;
};

export const acrossGeometry: Geometry = { orientation: "across", minNodeW: 196, maxNodeW: 236, nodeH: 74, gutter: 56, laneGap: 18, bandHeader: 34, bandPad: 12, bandGap: 12, top: 24 };
export const downGeometry: Geometry = { orientation: "down", minNodeW: 132, maxNodeW: 220, nodeH: 74, gutter: 26, laneGap: 22, bandHeader: 30, bandPad: 10, bandGap: 12, top: 0 };

/** Round the bands. */
const PAD = 12;

/**
 * Where everything stands. Bands: the scope's Parent (or the Project's Parents by Rank), then
 * Tasks with no Parent, then the outside ones. Inside a band, lanes are filled with chains: the
 * longest chain first, so it runs along the top, then the longest run of what is left, each in
 * the first lane free at its depths, so a Blocking inside a chain is a straight arrow.
 * Arrows go through the gutters and gaps (`routeGrid`), turning late so a Blocking from another
 * band runs along its blocker's lane and turns once beside the blocked.
 */
export function placeBlocking(
  tasks: ReadonlyMap<string, Pick<BlockingTask, "parentId" | "projectId" | "rank" | "key">>,
  a: BlockingAnalysis,
  g: Geometry,
  { scope, projectId, fit }: { scope?: string; projectId: string; /** The width to fill, nodes widening or narrowing to it within the Geometry's bounds. */ fit: number },
): BlockingLayout {
  const t = (id: string) => tasks.get(id)!;
  const bandOf = (id: string) => t(id).parentId ?? `none:${t(id).projectId}`;
  const bandIds = [...new Set(a.nodes.map(bandOf))];
  const bandRank = (b: string) => Math.min(...a.nodes.filter((id) => bandOf(id) === b).map((id) => t(id).rank));
  const bandOutside = (b: string) => a.nodes.filter((id) => bandOf(id) === b).every((id) => a.outside.has(id));
  // The scope's Parent, the Parents shown, no Parent; then the same outside, this Project's first.
  const weight = (b: string) => (b === scope ? 0 : (bandOutside(b) ? 4 : 0) + (b.startsWith("none:") ? 2 : 1) + (t(a.nodes.find((id) => bandOf(id) === b)!).projectId === projectId ? 0 : 1));
  bandIds.sort((x, y) => weight(x) - weight(y) || bandRank(x) - bandRank(y) || x.localeCompare(y));

  // Lanes inside each band, chain by chain.
  const lane = new Map<string, number>();
  const longest = new Set(a.longest);
  const edgeSet = new Set(a.edges.map(([b, z]) => `${b}>${z}`));
  for (const band of bandIds) {
    const left = new Set(a.nodes.filter((id) => bandOf(id) === band));
    const used = new Set<string>();
    const place = (chain: string[]) => {
      let l = 0;
      while (chain.some((id) => used.has(`${l}:${a.depth.get(id)}`))) l++;
      for (const id of chain) {
        lane.set(id, l);
        used.add(`${l}:${a.depth.get(id)}`);
        left.delete(id);
      }
    };
    const top = a.longest.filter((id) => left.has(id));
    if (top.length) place(top);
    while (left.size) {
      // The longest run left in this band, the best Rank first.
      const ids = [...left].sort((x, y) => a.depth.get(x)! - a.depth.get(y)! || t(x).rank - t(y).rank || keyNumber(t(x).key) - keyNumber(t(y).key));
      const run = new Map<string, string[]>();
      for (const id of ids) {
        let best: string[] = [];
        for (const b of ids) if (edgeSet.has(`${b}>${id}`) && run.has(b) && run.get(b)!.length > best.length) best = run.get(b)!;
        run.set(id, [...best, id]);
      }
      let chain: string[] = [];
      for (const id of ids) if (run.get(id)!.length > chain.length) chain = run.get(id)!;
      place(chain);
    }
  }
  const lanesIn = (band: string) => Math.max(0, ...a.nodes.filter((id) => bandOf(id) === band).map((id) => lane.get(id)! + 1));
  const depthsIn = (band: string) => {
    const ds = a.nodes.filter((id) => bandOf(id) === band).map((id) => a.depth.get(id)!);
    return [Math.min(...ds), Math.max(...ds)];
  };

  // Node width: across, the depth columns fill `fit`; down, the lanes do.
  const count = g.orientation === "across" ? a.depths : Math.max(1, ...bandIds.map(lanesIn));
  const room = fit - 2 * PAD - 2 * g.bandPad - (count - 1) * (g.orientation === "across" ? g.gutter : g.laneGap);
  const nodeW = Math.max(g.minNodeW, Math.min(g.maxNodeW, Math.floor(room / count)));

  // The grid, in its own axes: layers along the first, rows along the second.
  const [along, acrossSize] = g.orientation === "across" ? [nodeW, g.nodeH] : [g.nodeH, nodeW];
  const layerOf = new Map<string, number>();
  const rowOf = new Map<string, number>();
  const bands: Band[] = [];
  let layerX: number[];
  let rowY: (row: number) => number;
  let gutter: (i: number) => [number, number];
  let gap: (k: number) => [number, number];
  let rowCount: number;
  let width: number;
  let height: number;
  const pad = PAD;

  if (g.orientation === "across") {
    layerX = Array.from({ length: a.depths }, (_, d) => pad + g.bandPad + d * (along + g.gutter));
    const rowTops: number[] = [];
    const rowBand: number[] = [];
    let y = g.top;
    bandIds.forEach((band, bi) => {
      const lanes = lanesIn(band);
      const first = rowTops.length;
      for (let l = 0; l < lanes; l++) {
        rowTops.push(y + g.bandHeader + l * (acrossSize + g.laneGap));
        rowBand.push(bi);
      }
      for (const id of a.nodes)
        if (bandOf(id) === band) {
          layerOf.set(id, a.depth.get(id)!);
          rowOf.set(id, first + lane.get(id)!);
        }
      const h = g.bandHeader + lanes * acrossSize + (lanes - 1) * g.laneGap + g.bandPad;
      const last = layerX.length ? layerX[layerX.length - 1] + along + g.bandPad : 2 * pad;
      bands.push({ id: band, parentId: band.startsWith("none:") ? undefined : band, projectId: t(a.nodes.find((id) => bandOf(id) === band)!).projectId, outside: bandOutside(band), x: pad, y, w: last - pad, h });
      y += h + g.bandGap;
    });
    rowCount = rowTops.length;
    rowY = (r) => rowTops[r];
    const bottomOf = (r: number) => rowTops[r] + acrossSize;
    gap = (k) => {
      if (k === 0) return [g.top - g.bandGap / 2, g.top];
      if (k === rowCount) return [bottomOf(k - 1) + g.bandPad, bottomOf(k - 1) + g.bandPad + g.bandGap];
      if (rowBand[k] !== rowBand[k - 1]) return [bottomOf(k - 1) + g.bandPad, bands[rowBand[k]].y];
      return [bottomOf(k - 1), rowTops[k]];
    };
    gutter = (i) => [i === 0 ? layerX[0] - g.bandPad : layerX[i - 1] + along, i === layerX.length ? layerX[i - 1] + along + g.bandPad : layerX[i]];
    width = (layerX.length ? layerX[layerX.length - 1] + along + g.bandPad : pad) + pad;
    height = y - g.bandGap + pad;
  } else {
    // Down: each band holds its own depth rows; lanes are the rows of the grid.
    const lanes = Math.max(0, ...bandIds.map(lanesIn));
    layerX = [];
    const layerBand: number[] = [];
    let y = g.top + pad;
    bandIds.forEach((band, bi) => {
      const [lo, hi] = depthsIn(band);
      const first = layerX.length;
      for (let d = lo; d <= hi; d++) {
        layerX.push(y + g.bandHeader + (d - lo) * (along + g.gutter));
        layerBand.push(bi);
      }
      for (const id of a.nodes)
        if (bandOf(id) === band) {
          layerOf.set(id, first + a.depth.get(id)! - lo);
          rowOf.set(id, lane.get(id)!);
        }
      const h = g.bandHeader + (hi - lo + 1) * along + (hi - lo) * g.gutter + g.bandPad;
      bands.push({ id: band, parentId: band.startsWith("none:") ? undefined : band, projectId: t(a.nodes.find((id) => bandOf(id) === band)!).projectId, outside: bandOutside(band), x: pad, y, w: 0, h });
      y += h + g.bandGap;
    });
    rowCount = lanes;
    const left = pad + g.bandPad;
    rowY = (r) => left + r * (acrossSize + g.laneGap);
    const right = rowY(lanes - 1) + acrossSize + g.bandPad;
    for (const b of bands) b.w = right - pad;
    gap = (k) => [k === 0 ? left - g.bandPad : rowY(k - 1) + acrossSize, k === lanes ? right : rowY(k)];
    gutter = (i) => {
      if (i === 0) return [layerX[0] - g.bandHeader, layerX[0]];
      const end = layerX[i - 1] + along;
      if (i === layerX.length) return [end, end + g.bandPad];
      if (layerBand[i] !== layerBand[i - 1]) return [end, bands[layerBand[i]].y];
      return [end, layerX[i]];
    };
    width = right + pad;
    height = y - g.bandGap + pad;
  }

  const taken = new Set(a.nodes.map((id) => `${layerOf.get(id)}:${rowOf.get(id)}`));
  const arrows: GridArrow[] = a.edges.map(([b, z]) => ({ id: `${b}->${z}`, from: b, to: z, a: layerOf.get(b)!, z: layerOf.get(z)!, ra: rowOf.get(b)!, rb: rowOf.get(z)! }));
  const routed = routeGrid({ layerX, nodeW: along, nodeH: acrossSize, rowY, gutter, gap, taken }, arrows, { turnLate: true });
  const swap = (p: Point): Point => (g.orientation === "across" ? p : { x: p.y, y: p.x });
  const onLongest = (b: string, z: string) => longest.has(b) && longest.has(z) && a.longest.indexOf(z) === a.longest.indexOf(b) + 1;

  const nodes: PlacedNode[] = a.nodes.map((id) => {
    const p = swap({ x: layerX[layerOf.get(id)!], y: rowY(rowOf.get(id)!) });
    const [w, h] = g.orientation === "across" ? [along, acrossSize] : [acrossSize, along];
    return { id, band: bandOf(id), depth: a.depth.get(id)!, lane: lane.get(id)!, x: p.x, y: p.y, w, h };
  });
  return {
    orientation: g.orientation,
    bands,
    nodes,
    edges: routed.map((e) => ({ ...e, points: e.points.map(swap), longest: onLongest(e.from, e.to) })),
    columns: g.orientation === "across" ? layerX.map((x, d) => ({ depth: d, x })) : [],
    width,
    height,
  };
}

/**
 * The Steps a node's micro-line draws, of its Project's (in the Project's order): those of the
 * Workflow of the Step it is at, else of the Project's first Workflow.
 */
export function ownWorkflowSteps<S extends { id: string; workflowId?: string }>(all: readonly S[], stepId: string | undefined): readonly S[] {
  const own = all.find((s) => s.id === stepId)?.workflowId ?? all[0]?.workflowId;
  return own === undefined ? all : all.filter((s) => s.workflowId === own);
}
