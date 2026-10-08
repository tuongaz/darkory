import { DONE_STATION, sideSteps, type LineConnector, type LineStep, type LineWorkflow } from "./model";
import { breakdownOutcomeHint, ENTRY_LABEL, entryHint, FILES_LABEL, filesHint, HAND_LABEL, handHint, holdHint, outcomeHint, outcomesHint } from "./words";

/*
 * Where the Workflow line puts everything, without a DOM, so tests can prove the drawing rules
 * (mock-workflow/frag-d.html):
 * - one main line of the Steps in Workflow order, ending on Done; a pair of neighbours joined by a
 *   Connector is a solid segment named by its outcome, a pair with none is dotted;
 * - a loop back runs in an arc UNDER the line, arcs nested so none cross; three or more loops into
 *   one Step share one return track with a drop from each;
 * - a forward skip runs dashed OVER the line; a loop that would cross what is under goes over too,
 *   solid;
 * - the Steps where Darkory files a Parent's own Subtasks (acceptance, retro, skill-review) sit on
 *   a short branch "After a Parent" whose rows run into Done;
 * - a Connector the drawing cannot route without a crossing is a chip ("fail → Build");
 * - new Tasks enter from the left into the Step they start at; the breakdown Step sits on a short
 *   branch "Break down" above that entry, its arrow "files Subtasks" joining it; a hold no
 *   Connector joins parks below the entry, its arrow "by hand"; every dotted segment says "by hand";
 * - every line carries words, and a sentence for its hover (`hints`).
 * `lineTopology` decides all of that in station order; `horizontal` turns it into pixels.
 */

export type Side = "under" | "over";

/** A neighbour pair on the main line: solid along its Connector, dotted when none joins them. */
export type Segment = { lo: number; from: string; to: string; connector?: LineConnector };

/** One Connector drawn as an arc between two main-line stations (`lo` < `hi`, by index). */
export type Arc = {
  kind: "arc";
  connector: LineConnector;
  side: Side;
  /** It leads back, into an earlier Step: solid; a forward skip is dashed. */
  back: boolean;
  lo: number;
  hi: number;
  depth: number;
  /** How far in from each end station its legs stand, in steps of `LEG`. */
  legLo: number;
  legHi: number;
};

/** Three or more loops into one Step on one return track under the line, a drop from each. */
export type Track = {
  kind: "track";
  target: string;
  lo: number;
  hi: number;
  depth: number;
  legLo: number;
  drops: { connector: LineConnector; at: number }[];
};

export type Under = Arc | Track;

/** A loop back inside a branch row, drawn under it. Indexes are the row's. */
export type RowLoop = { connector: LineConnector; lo: number; hi: number; depth: number };

/** One row of the branch: Steps chained by their Connectors, running into Done by `exit`. */
export type BranchRow = {
  stations: string[];
  segments: { lo: number; connector: LineConnector }[];
  loops: RowLoop[];
  exit?: LineConnector;
};

/** A Connector shown in words beside its Step: "fail → Build". */
export type Chip = { stepId: string; connector: LineConnector; text: string };

/** A loop back as the Loops list names it. */
export type Loop = { connector: LineConnector; from: string; to: string };

export type LineTopology = {
  /** Main-line station ids in order, Done last. */
  main: string[];
  /** Where new Tasks start (on the main line), when the Workflow has a Step. */
  start?: string;
  /** The breakdown Step on the branch "Break down", off the line before the start Step. */
  before?: string;
  /** The holds no Connector joins, parked off the line by the entry, in Workflow order. */
  holds: string[];
  /** Every Connector the line draws, by id. */
  connectors: Map<string, LineConnector>;
  steps: Map<string, LineStep>;
  segments: Segment[];
  under: Under[];
  over: Arc[];
  rows: BranchRow[];
  chips: Chip[];
  loops: Loop[];
  maxUnder: number;
  maxOver: number;
};

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

const span = (e: { lo: number; hi: number }) => e.hi - e.lo;

/** Two intervals interleave: each holds exactly one end of the other strictly inside. */
function interleave(a: { lo: number; hi: number }, b: { lo: number; hi: number }): boolean {
  return (a.lo < b.lo && b.lo < a.hi && a.hi < b.hi) || (b.lo < a.lo && a.lo < b.hi && b.hi < a.hi);
}

/** Inside `outer` (ends may touch), not the same element. */
function within(inner: { lo: number; hi: number }, outer: { lo: number; hi: number }): boolean {
  return outer.lo <= inner.lo && inner.hi <= outer.hi;
}

type Placed = { lo: number; hi: number; drops?: number[] };

/**
 * Whether two elements on one side of the line cannot both be drawn there without crossing: their
 * spans interleave, or one runs across a drop of the other's track (a drop is a leg standing
 * down from the line to the track, so anything nested under the track must not straddle one).
 */
function clash(a: Placed, b: Placed): boolean {
  if (interleave(a, b)) return true;
  const straddles = (e: Placed, t: Placed) => within(e, t) && (t.drops ?? []).some((d) => e.lo < d && d < e.hi);
  return straddles(a, b) || straddles(b, a);
}

/**
 * Each element's depth on its side: one past the deepest element nested inside it, so an outer
 * arc always runs below (or above) every arc it holds. Equal spans nest in the given order.
 */
function nest<T extends Placed & { depth: number }>(list: T[]): number {
  const order = list.map((e, i) => ({ e, i })).sort((a, b) => span(a.e) - span(b.e) || a.i - b.i);
  let max = 0;
  order.forEach(({ e }, k) => {
    let d = 1;
    for (let j = 0; j < k; j++) {
      const f = order[j].e;
      if (within(f, e) && !clash(f, e)) d = Math.max(d, f.depth + 1);
    }
    e.depth = d;
    max = Math.max(max, d);
  });
  return max;
}

/**
 * Where each arc's legs stand at a station both share: the deeper arc (the outer one) stands
 * nearest the station, each shallower one a step further in, so legs never cross.
 */
function legs(list: (Arc | Track)[]) {
  const at = new Map<string, (Arc | Track)[]>();
  const add = (key: string, e: Arc | Track) => at.set(key, [...(at.get(key) ?? []), e]);
  for (const e of list) {
    add(`${e.lo}>`, e);
    if (e.kind === "arc") add(`${e.hi}<`, e);
  }
  for (const [key, group] of at) {
    group.sort((a, b) => b.depth - a.depth);
    group.forEach((e, rank) => {
      if (key.endsWith(">")) e.legLo = rank;
      else if (e.kind === "arc") e.legHi = rank;
    });
  }
}

/** The line's stations, routes and branch, in station order. */
export function lineTopology(workflow: LineWorkflow): LineTopology {
  const ordered = [...workflow.steps].sort(byPosition);
  const steps = new Map(ordered.map((s) => [s.id, s]));
  const sides = sideSteps(workflow);
  const sideIds = sides.after;
  const before = [...sides.before][0];
  const holds = ordered.filter((s) => sides.holds.has(s.id)).map((s) => s.id);
  const main = [...ordered.filter((s) => !sideIds.has(s.id) && s.id !== before && !sides.holds.has(s.id)).map((s) => s.id), DONE_STATION];
  const index = new Map(main.map((id, i) => [id, i]));
  const name = (id: string | null) => (id === null ? "Done" : (steps.get(id)?.name ?? "a Step"));
  const connectors = [...workflow.connectors]
    .filter((c) => steps.has(c.from) && (c.to === null || steps.has(c.to)))
    .sort((a, b) => byPosition(steps.get(a.from)!, steps.get(b.from)!) || a.position - b.position);

  const segments: Segment[] = main.slice(0, -1).map((from, i) => ({ lo: i, from, to: main[i + 1] }));
  const chips: Chip[] = [];
  const forward: Arc[] = [];
  const backs: LineConnector[] = [];
  const sideLinks: LineConnector[] = [];
  const sideOut: LineConnector[] = [];
  const chip = (c: LineConnector) => chips.push({ stepId: c.from, connector: c, text: `${c.name} → ${name(c.to)}` });

  for (const c of connectors) {
    const to = c.to ?? DONE_STATION;
    // The breakdown Step's outcomes, in words beside it.
    if (c.from === before) {
      chip(c);
      continue;
    }
    if (sideIds.has(c.from)) {
      if (c.to !== null && sideIds.has(c.to)) sideLinks.push(c);
      else sideOut.push(c);
      continue;
    }
    if (sideIds.has(to)) {
      chip(c);
      continue;
    }
    const [a, b] = [index.get(c.from)!, index.get(to)!];
    if (b === a + 1 && !segments[a].connector) segments[a].connector = c;
    else if (b > a) forward.push({ kind: "arc", connector: c, side: "over", back: false, lo: a, hi: b, depth: 0, legLo: 0, legHi: 0 });
    else backs.push(c);
  }

  // Loops back: three or more into one Step share a track; the rest are arcs.
  const byTarget = new Map<string, LineConnector[]>();
  for (const c of backs) byTarget.set(c.to!, [...(byTarget.get(c.to!) ?? []), c]);
  const tracks: Track[] = [];
  const backArcs: Arc[] = [];
  for (const [target, list] of byTarget) {
    const lo = index.get(target)!;
    if (list.length >= 3) {
      const drops = list.map((connector) => ({ connector, at: index.get(connector.from)! })).sort((a, b) => a.at - b.at);
      tracks.push({ kind: "track", target, lo, hi: Math.max(...drops.map((d) => d.at)), depth: 0, legLo: 0, drops });
    } else {
      for (const c of list) backArcs.push({ kind: "arc", connector: c, side: "under", back: true, lo, hi: index.get(c.from)!, depth: 0, legLo: 0, legHi: 0 });
    }
  }

  // Place: forward skips over; tracks, then loops shortest first, under; a loop that cannot go
  // under without crossing goes over when it can, and stays under (crossing) only when neither can.
  const placedOf = (e: Arc | Track): Placed => (e.kind === "track" ? { lo: e.lo, hi: e.hi, drops: e.drops.map((d) => d.at) } : e);
  const over: Arc[] = [];
  const under: Under[] = [];
  const fits = (e: Arc | Track, side: (Arc | Track)[]) => side.every((f) => !clash(placedOf(e), placedOf(f)));
  for (const f of [...forward].sort((a, b) => span(a) - span(b))) {
    if (fits(f, over) || !fits(f, under)) over.push(f);
    else under.push({ ...f, side: "under" });
  }
  for (const t of [...tracks].sort((a, b) => span(b) - span(a))) under.push(t);
  for (const a of [...backArcs].sort((x, y) => span(x) - span(y))) {
    if (fits(a, under)) under.push(a);
    else if (fits(a, over)) over.push({ ...a, side: "over" });
    else under.push(a);
  }
  const maxUnder = nestPlaced(under, placedOf);
  const maxOver = nestPlaced(over, placedOf);
  legs(under);
  legs(over);

  // The branch: rows of side Steps chained by their Connectors, in Workflow order.
  const parent = new Map([...sideIds].map((id) => [id, id]));
  const root = (id: string): string => (parent.get(id) === id ? id : root(parent.get(id)!));
  for (const c of sideLinks) parent.set(root(c.from), root(c.to!));
  const groups = new Map<string, string[]>();
  for (const s of ordered) if (sideIds.has(s.id)) groups.set(root(s.id), [...(groups.get(root(s.id)) ?? []), s.id]);
  const rows: BranchRow[] = [...groups.values()].map((stations) => {
    const at = new Map(stations.map((id, i) => [id, i]));
    const row: BranchRow = { stations, segments: [], loops: [] };
    for (const c of sideLinks.filter((l) => at.has(l.from))) {
      const [a, b] = [at.get(c.from)!, at.get(c.to!)!];
      if (b === a + 1 && !row.segments.some((s) => s.lo === a)) row.segments.push({ lo: a, connector: c });
      else if (b < a) row.loops.push({ connector: c, lo: b, hi: a, depth: 0 });
      else chip(c);
    }
    const last = stations.at(-1)!;
    for (const c of sideOut.filter((o) => at.has(o.from))) {
      if (c.to === null && c.from === last && !row.exit) row.exit = c;
      else chip(c);
    }
    nest(row.loops);
    return row;
  });

  const loops: Loop[] = [
    ...backs.map((c) => ({ connector: c, from: name(c.from), to: name(c.to) })),
    ...rows.flatMap((r) => r.loops.map((l) => ({ connector: l.connector, from: name(l.connector.from), to: name(l.connector.to) }))),
  ];
  return { main, start: sides.start, before, holds, connectors: new Map(connectors.map((c) => [c.id, c])), steps, segments, under, over, rows, chips, loops, maxUnder, maxOver };
}

function nestPlaced(list: (Arc | Track)[], placedOf: (e: Arc | Track) => Placed): number {
  const wrapped = list.map((e) => ({ ...placedOf(e), depth: 0, e }));
  const max = nest(wrapped);
  wrapped.forEach((w) => (w.e.depth = w.depth));
  return max;
}

/** Pairs of elements on one side that cannot be drawn without crossing: the drawing's promise is none. */
export function topologyCrossings(t: LineTopology): number {
  let n = 0;
  for (const side of [t.under, t.over]) {
    const placed = side.map((e) => (e.kind === "track" ? { lo: e.lo, hi: e.hi, drops: e.drops.map((d) => d.at), depth: e.depth } : e));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const [a, b] = [placed[i], placed[j]];
        if (clash(a, b)) n++;
        // Nested the wrong way round: the inner one drawn deeper than the one holding it.
        else if (within(a, b) && span(a) < span(b) && a.depth >= b.depth) n++;
        else if (within(b, a) && span(b) < span(a) && b.depth >= a.depth) n++;
      }
    }
  }
  return n;
}

/* ------------------------------------------------------------------------------------------ */
/* Pixels: the line laid out left to right.                                                   */
/* ------------------------------------------------------------------------------------------ */

/** How the line shows its Tasks: tokens with key and time, or beads past ~9 Steps or narrow. */
export type Density = "tokens" | "beads";

/** Station spacing under which tokens give way to beads. */
export const BEAD_SPACING = 130;
/** Main-line Steps beyond which tokens give way to beads. */
export const BEAD_STEPS = 9;

/** Tokens or beads, by how many Steps the main line carries and the room each gets. */
export function densityFor(topology: LineTopology, width: number): Density {
  const steps = topology.main.length - 1;
  if (steps > BEAD_STEPS) return "beads";
  return stationsX(topology, width, zoneOf(topology), "tokens").sp < BEAD_SPACING ? "beads" : "tokens";
}

function spacingFor(n: number, width: number) {
  const margin = n <= 1 ? width / 2 : Math.min(100, Math.max(56, (width / n) * 0.55));
  const sp = n <= 1 ? 0 : (width - 2 * margin) / (n - 1);
  return { margin, sp };
}

/**
 * The left of the line, where Tasks enter: the entry arrow "New Tasks start here" into the start
 * Step when it is the line's first; above it the branch "Break down" (the breakdown Step, its
 * outcomes in words left of it, its arrow "files Subtasks" dropping into the entry); below it the
 * parked holds, named left of a dotted spine that rises into the line "by hand".
 */
export type Zone = {
  /** The start Step is the line's first: the entry arrow comes in from the left. */
  entry: boolean;
  /** Where the entry arrow begins, right of its words. */
  entryStart: number;
  /** The breakdown Step's station. */
  px: number;
  /** Where its "files Subtasks" arrow drops into the entry arrow. */
  joinX: number;
  /** The holds' spine. */
  hx: number;
  /** The right edge of all of it. */
  right: number;
  /** The breakdown Step's words left of it: its outcomes, and where its Subtasks start when no arrow can say it. */
  chips: { text: string; connectorId?: string }[];
};

const ZONE_L = 16;
/** "New Tasks start here" at the drawing's 11.5px. */
const ENTRY_W = 124;
/** Between the zone and the first station: room for that station's name and token column. */
const ZONE_GAP = { tokens: 112, beads: 56 } as const;
const HOLD_W = 140;
const chipWidth = (text: string) => text.length * 6.2 + 18;

function nameOf(t: LineTopology) {
  return (id: string | null) => (id === null || id === DONE_STATION ? "Done" : (t.steps.get(id)?.name ?? "a Step"));
}

/** A Step's name line, roughly, when the drawing has not said: name, Skill, a mark. */
function nameLine(s: LineStep | undefined): number {
  if (!s) return 0;
  return s.name.length * 7.6 + (s.skill ? s.skill.name.length * 6.7 + 6 : 0) + 26;
}

export function zoneOf(t: LineTopology, labelWidth?: (stepId: string) => number): Zone | undefined {
  const entry = t.start !== undefined && t.main[0] === t.start;
  if (!entry && !t.before && t.holds.length === 0) return undefined;
  const entryStart = ZONE_L + ENTRY_W + 8;
  const hx = Math.max(entryStart + 22, ZONE_L + HOLD_W + 14);
  let right = entry ? entryStart + 48 : ZONE_L;
  if (t.holds.length > 0) right = Math.max(right, hx + 6 + chipWidth(HAND_LABEL));
  const chips: Zone["chips"] = [];
  let px = 0;
  let joinX = 0;
  if (t.before) {
    for (const c of t.chips.filter((c) => c.stepId === t.before)) chips.push({ text: c.text, connectorId: c.connector.id });
    if (!entry && t.start) chips.push({ text: `${FILES_LABEL} → ${nameOf(t)(t.start)}` });
    const chipW = Math.max(0, ...chips.map((c) => chipWidth(c.text)));
    px = Math.round(ZONE_L + (chipW ? chipW + 14 : 6));
    const nameW = labelWidth?.(t.before) ?? nameLine(t.steps.get(t.before));
    if (entry) joinX = Math.round(Math.max(px + 7 + chipWidth(FILES_LABEL) + 24, (t.holds.length ? hx : entryStart) + 34));
    right = Math.max(right, px - 6 + nameW, joinX);
  }
  return { entry, entryStart, px, joinX, hx, right: Math.round(right), chips };
}

/** Each main-line station's x: spread over the width, right of the zone where Tasks enter. */
function stationsX(t: LineTopology, width: number, zone: Zone | undefined, density: Density) {
  const n = t.main.length;
  const { margin, sp } = spacingFor(n, width);
  if (!zone || n <= 1) return { xs: t.main.map((_, i) => Math.round(margin + i * sp)), margin, sp };
  const left = Math.max(margin, zone.right + ZONE_GAP[density]);
  const step = Math.max(40, (width - margin - left) / (n - 1));
  return { xs: t.main.map((_, i) => Math.round(left + i * step)), margin, sp: step };
}

export type Point = [number, number];
/** A drawn line as straight runs between corners, for drawing (corners rounded) and for counting crossings. */
export type Polyline = { id: string; points: Point[] };

export type Label = { x: number; y: number; text: string; back?: boolean; connectorId?: string; align?: "start"; hint?: string };

export type DrawnArc = {
  id: string;
  side: Side;
  back: boolean;
  connectorIds: string[];
  line: Point[];
  /** Arrowhead tip and the direction it points (down into a station from over, up into it from under). */
  arrow: { x: number; y: number; dir: "up" | "down" };
  labels: Label[];
};

export type BranchStation = { id: string; x: number; y: number; row: number };

export type Horizontal = {
  width: number;
  height: number;
  density: Density;
  /** Each station's centre: main-line ones on `lineY`, branch ones on their row. */
  at: Map<string, { x: number; y: number }>;
  lineY: number;
  /** The top of the station names, and of the token (or bead) columns. */
  headY: number;
  columnY: number;
  /** Where a station's faint guide runs from its head down to the line. */
  guideTop: number;
  main: { from: string; to: string; x1: number; x2: number; dotted: boolean; connectorId?: string }[];
  segmentLabels: Label[];
  arcs: DrawnArc[];
  branch?: {
    label: { x: number; y: number };
    stations: BranchStation[];
    lines: Polyline[];
    loops: DrawnArc[];
    labels: Label[];
  };
  chips: { stepId: string; x: number; y: number; text: string; align: "left" | "right" | "center"; connectorId?: string; hint?: string }[];
  /** Where Tasks enter the line, when it draws an entry (see `Zone`). */
  entry?: {
    /** The entry arrow into the start Step, with its words; absent when the start Step is not the line's first. */
    arrow?: { line: Point[]; head: { x: number; y: number; dir: "right" }; label: Label };
    /** The mark over a start Step the arrow cannot reach: "New Tasks start here". */
    mark?: { x: number; y: number; hint: string };
    /** The branch "Break down": its title, its Step, and its arrow into the start Step. */
    before?: {
      id: string;
      title: { x: number; y: number; hint: string };
      station: { x: number; y: number };
      files?: { line: Point[]; head: { x: number; y: number; dir: "down" }; label: Label };
    };
    /** The parked holds, each named left of the spine; the spine rises into the line by hand. */
    holds: { id: string; x: number; y: number; hint: string }[];
    spine?: { line: Point[]; head: { x: number; y: number; dir: "up" | "right" }; label: Label };
  };
  /** The route a token travels along each Connector, as an SVG path from its Step to where it leads. */
  routes: Map<string, string>;
  /** Every drawn line, for the crossing count. */
  polylines: Polyline[];
  /** What each drawn line says on hover, by its id: a polyline's, `seg:<from>` for a main segment. */
  hints: Map<string, string>;
};

export type HorizontalOptions = {
  width: number;
  density?: Density;
  /** The tallest token (or bead) column, in px. */
  column: number;
  /** Leave the branch off (a single Task's path, which never reaches it). */
  noBranch?: boolean;
  /** How far left of Done the branch's first row ends: more when its Steps carry ghosts. */
  branchGap?: number;
  /** How wide a branch Step's name line runs (name, Skill, marks, tokens), so the next Step stands clear of it. */
  labelWidth?: (stepId: string) => number;
  /** How tall a parked hold's token column runs under its name, in px. */
  holdColumn?: (stepId: string) => number;
};

/** The step between nested legs at a shared station, and the inset of the outermost. */
export const LEG = 9;
const LEG0 = 6;
const ROW_GAP = 56;
const OVER_STEP = 20;
const UNDER_STEP = 22;

/** The line laid out left to right in `width` px. */
export function horizontal(t: LineTopology, opts: HorizontalOptions): Horizontal {
  const density = opts.density ?? densityFor(t, opts.width);
  const n = t.main.length;
  const name = nameOf(t);
  const zone = zoneOf(t, opts.labelWidth);
  const { xs, margin, sp } = stationsX(t, opts.width, zone, density);
  // A start Step the entry arrow cannot reach (it is not the line's first) is marked over its head.
  const marked = t.start !== undefined && t.main[0] !== t.start;
  const headY = 28 + t.maxOver * OVER_STEP + (marked ? 26 : 0);
  const columnY = density === "tokens" ? headY + 54 : headY + 70;
  const lineY = columnY + Math.max(opts.column, density === "tokens" ? 30 : 12) + (density === "tokens" ? 24 : 60);
  const guideTop = density === "tokens" ? headY + 50 : headY + 64;
  const at = new Map<string, { x: number; y: number }>();
  t.main.forEach((id, i) => at.set(id, { x: xs[i], y: lineY }));

  const polylines: Polyline[] = [{ id: "main", points: [[xs[0], lineY], [xs[n - 1], lineY]] }];
  const routes = new Map<string, string>();
  const main = t.segments.map((s) => ({ from: s.from, to: s.to, x1: xs[s.lo], x2: xs[s.lo + 1], dotted: !s.connector, connectorId: s.connector?.id }));
  const hints = new Map<string, string>();
  // Every segment says what moves along it: its Connector's outcome, or "by hand" where none joins the pair.
  const segmentLabels: Label[] = t.segments.map((s) => {
    const hint = s.connector ? outcomeHint(s.connector, name) : handHint(name(s.from), name(s.to));
    hints.set(`seg:${s.from}`, hint);
    return { x: (xs[s.lo] + xs[s.lo + 1]) / 2, y: lineY, text: s.connector?.name ?? HAND_LABEL, connectorId: s.connector?.id, hint };
  });
  for (const s of t.segments) if (s.connector) routes.set(s.connector.id, `M${xs[s.lo]} ${lineY} H${xs[s.lo + 1]}`);

  const arcs: DrawnArc[] = [];
  const underY = (d: number) => lineY + 20 + d * UNDER_STEP;
  const overY = (d: number) => headY - (marked ? 26 : 0) - 12 - d * OVER_STEP;
  for (const e of t.under) {
    const y = underY(e.depth);
    const y0 = lineY + 7;
    if (e.kind === "arc") {
      const xl = xs[e.lo] + LEG0 + e.legLo * LEG;
      const xr = xs[e.hi] - LEG0 - e.legHi * LEG;
      const line: Point[] = [[xr, y0], [xr, y], [xl, y], [xl, y0]];
      const [tx, fx] = e.back ? [xl, xr] : [xr, xl];
      arcs.push({ id: e.connector.id, side: "under", back: e.back, connectorIds: [e.connector.id], line, arrow: { x: tx, y: y0, dir: "up" }, labels: [{ x: (xl + xr) / 2, y, text: e.connector.name, back: true, connectorId: e.connector.id }] });
      routes.set(e.connector.id, `M${xs[e.back ? e.hi : e.lo]} ${lineY} L${fx} ${y0} V${y} H${tx} V${y0} L${xs[e.back ? e.lo : e.hi]} ${lineY}`);
    } else {
      const xl = xs[e.lo] + LEG0 + e.legLo * LEG;
      const xe = xs[e.hi];
      const line: Point[] = [[xe, y0], [xe, y], [xl, y], [xl, y0]];
      const labels: Label[] = e.drops.map((d) => ({ x: xs[d.at], y: y + 14, text: d.connector.name, back: true, connectorId: d.connector.id }));
      labels.push({ x: xe + 14, y: y, text: `↩ ${t.steps.get(e.target)?.name ?? "a Step"} · ${e.drops.length} loops`, back: true, align: "start" });
      arcs.push({ id: `track:${e.target}`, side: "under", back: true, connectorIds: e.drops.map((d) => d.connector.id), line, arrow: { x: xl, y: y0, dir: "up" }, labels });
      e.drops.forEach((d, i) => {
        const x = xs[d.at];
        if (d.at !== e.hi) polylines.push({ id: `drop:${d.connector.id}`, points: [[x, y0], [x, y - 9], [x - 9, y]] });
        routes.set(d.connector.id, `M${x} ${lineY} V${y} H${xl} V${y0} L${xs[e.lo]} ${lineY}`);
        void i;
      });
    }
  }
  for (const e of t.over) {
    const y = overY(e.depth);
    const y0 = headY - 6;
    const xl = xs[e.lo] + LEG0 + e.legLo * LEG;
    const xr = xs[e.hi] - LEG0 - e.legHi * LEG;
    const line: Point[] = [[xl, y0], [xl, y], [xr, y], [xr, y0]];
    const [fx, tx] = e.back ? [xr, xl] : [xl, xr];
    arcs.push({ id: e.connector.id, side: "over", back: e.back, connectorIds: [e.connector.id], line, arrow: { x: tx, y: y0, dir: "down" }, labels: [{ x: (xl + xr) / 2, y, text: e.connector.name, back: e.back, connectorId: e.connector.id }] });
    const [a, b] = e.back ? [e.hi, e.lo] : [e.lo, e.hi];
    routes.set(e.connector.id, `M${xs[a]} ${lineY} L${fx} ${y0} V${y} H${tx} V${y0} L${xs[b]} ${lineY}`);
  }
  for (const a of arcs) polylines.push({ id: a.id, points: a.line });
  const connectorsOf = (ids: string[]) => ids.map((id) => t.connectors.get(id)).filter((c): c is LineConnector => !!c);
  for (const a of arcs) hints.set(a.id, outcomesHint(connectorsOf(a.connectorIds), name));
  for (const p of polylines) if (p.id.startsWith("drop:")) hints.set(p.id, outcomesHint(connectorsOf([p.id.slice(5)]), name));

  // Under everything on the line: the chips of main Steps (Connectors into the branch).
  let bottom = underY(t.maxUnder) + (t.under.some((e) => e.kind === "track") ? 24 : 12);
  if (t.maxUnder === 0) bottom = lineY + 24;
  const chips: Horizontal["chips"] = [];
  const mainChips = t.chips.filter((c) => at.has(c.stepId));
  if (mainChips.length > 0) {
    const perStep = new Map<string, number>();
    for (const c of mainChips) {
      const k = perStep.get(c.stepId) ?? 0;
      perStep.set(c.stepId, k + 1);
      chips.push({ stepId: c.stepId, x: at.get(c.stepId)!.x, y: bottom + 6 + k * 22, text: c.text, align: "center", connectorId: c.connector.id });
    }
    bottom += 8 + Math.max(...perStep.values()) * 22;
  }

  // Where Tasks enter, left of the line: the entry arrow, "Break down" above it, the parked holds below.
  let entry: Horizontal["entry"];
  if (marked && t.start !== undefined) entry = { holds: [], mark: { x: at.get(t.start)!.x, y: headY - (density === "beads" ? 0 : 14), hint: entryHint(name(t.start)) } };
  if (zone) {
    entry ??= { holds: [] };
    const x0 = xs[0];
    const start = t.start !== undefined ? name(t.start) : undefined;
    if (zone.entry) {
      const line: Point[] = [[zone.entryStart, lineY], [x0 - 11, lineY]];
      const hint = entryHint(start!);
      entry.arrow = { line, head: { x: x0 - 11, y: lineY, dir: "right" }, label: { x: ZONE_L, y: lineY, text: ENTRY_LABEL, align: "start", hint } };
      polylines.push({ id: "entry", points: line });
      hints.set("entry", hint);
    }
    if (t.before) {
      const id = t.before;
      const py = lineY - 56;
      const px = zone.px;
      at.set(id, { x: px, y: py });
      const hint = filesHint(name(id), start);
      entry.before = { id, title: { x: px - 6, y: py - 60, hint }, station: { x: px, y: py } };
      if (zone.entry) {
        const line: Point[] = [[px + 7, py], [zone.joinX, py], [zone.joinX, lineY - 3]];
        entry.before.files = { line, head: { x: zone.joinX, y: lineY - 3, dir: "down" }, label: { x: (px + 7 + zone.joinX) / 2, y: py, text: FILES_LABEL, hint } };
        polylines.push({ id: "files", points: line });
        hints.set("files", hint);
      }
      zone.chips.forEach((c, m) => {
        const connector = c.connectorId ? t.connectors.get(c.connectorId) : undefined;
        chips.push({ stepId: id, x: px - 14, y: py - 9 + m * 22, text: c.text, align: "right", connectorId: c.connectorId, hint: connector ? breakdownOutcomeHint(connector, name, start) : hint });
      });
    }
    if (t.holds.length > 0) {
      let y = lineY + 50;
      for (const id of t.holds) {
        at.set(id, { x: zone.hx, y });
        entry.holds.push({ id, x: zone.hx, y, hint: holdHint(name(id)) });
        y += 32 + (opts.holdColumn?.(id) ?? 0) + 18;
      }
      const last = entry.holds.at(-1)!.y;
      const words = t.holds.map((id) => holdHint(name(id))).join(" ");
      const line: Point[] = zone.entry ? [[zone.hx, last], [zone.hx, lineY + 3]] : [[zone.hx, last], [zone.hx, lineY], [x0 - 11, lineY]];
      const label: Label = zone.entry
        ? { x: zone.hx + 6, y: (lineY + entry.holds[0].y) / 2, text: HAND_LABEL, align: "start", hint: words }
        : { x: (zone.hx + x0 - 11) / 2, y: lineY, text: HAND_LABEL, hint: words };
      entry.spine = { line, head: zone.entry ? { x: zone.hx, y: lineY + 3, dir: "up" } : { x: x0 - 11, y: lineY, dir: "right" }, label };
      polylines.push({ id: "holds", points: line });
      hints.set("holds", words);
      bottom = Math.max(bottom, y - 8);
    }
  }

  let branch: Horizontal["branch"];
  const xd = xs[n - 1];
  if (!opts.noBranch && t.rows.length > 0) {
    const labelY = bottom + 28;
    const stations: BranchStation[] = [];
    const lines: Polyline[] = [];
    const loops: DrawnArc[] = [];
    const labels: Label[] = [];
    let y = labelY + 34;
    let rightEdge = xd - (opts.branchGap ?? 240);
    const rowSp = Math.max(180, Math.min(340, sp * 1.7));
    const rowYs: number[] = [];
    let extra = 0;
    t.rows.forEach((row, r) => {
      if (r > 0) y += ROW_GAP + extra + t.rows[r - 1].loops.reduce((m, l) => Math.max(m, l.depth), 0) * 20;
      extra = 0;
      rowYs.push(y);
      const k = row.stations.length;
      // Each row ends left of where the row above begins, so their names and chips stay clear.
      // Its last Step's name line (and tokens) must end short of where the row turns into Done.
      const turn = xd - 60 * r;
      let end = Math.min(rightEdge, turn - ((opts.labelWidth?.(row.stations[k - 1]) ?? 0) + 34));
      if (end - (k - 1) * rowSp < margin + 60) end = Math.max(margin + 60 + (k - 1) * rowSp, xd - (opts.branchGap ?? 240));
      const xsRow: number[] = new Array(k);
      xsRow[k - 1] = Math.round(end);
      for (let i = k - 2; i >= 0; i--) xsRow[i] = Math.round(xsRow[i + 1] - Math.max(rowSp, (opts.labelWidth?.(row.stations[i]) ?? 0) + 24));
      row.stations.forEach((id, i) => {
        stations.push({ id, x: xsRow[i], y, row: r });
        at.set(id, { x: xsRow[i], y });
      });
      if (xsRow[0] - 190 > margin + 120) rightEdge = xsRow[0] - 190;
      else extra = 24;
      for (const s of row.segments) {
        labels.push({ x: (xsRow[s.lo] + xsRow[s.lo + 1]) / 2, y, text: s.connector.name, connectorId: s.connector.id });
        routes.set(s.connector.id, `M${xsRow[s.lo]} ${y} H${xsRow[s.lo + 1]}`);
      }
      // The row's own line: its stations joined, and on into Done when its last Step leads there.
      const first = xsRow[0];
      const last = xsRow[k - 1];
      if (row.exit) {
        const j = xd - 60 * r;
        const pts: Point[] = r === 0
          ? [[first, y], [j - 30, y], [j, y - 30], [j, lineY + 10]]
          : [[first, y], [j - 30, y], [j, y - 30], [j, rowYs[r - 1] + 30], [j + 30, rowYs[r - 1]]];
        lines.push({ id: `row:${r}`, points: pts });
        labels.push({ x: (last + j) / 2, y, text: row.exit.name, connectorId: row.exit.id });
        const tail = r === 0 ? `H${j - 30} Q${j} ${y} ${j} ${y - 30} V${lineY}` : `H${j - 30} Q${j} ${y} ${j} ${y - 30} V${rowYs[r - 1] + 30} Q${j} ${rowYs[r - 1]} ${j + 30} ${rowYs[r - 1]} H${xd - 30} Q${xd} ${rowYs[0]} ${xd} ${rowYs[0] - 30} V${lineY}`;
        routes.set(row.exit.id, `M${last} ${y} ${tail}`);
      } else if (k > 1) {
        lines.push({ id: `row:${r}`, points: [[first, y], [last, y]] });
      }
      for (const l of row.loops) {
        const yl = y + 20 * l.depth;
        const xl = xsRow[l.lo] + LEG0;
        const xr = xsRow[l.hi] - LEG0;
        loops.push({ id: l.connector.id, side: "under", back: true, connectorIds: [l.connector.id], line: [[xr, y + 6], [xr, yl], [xl, yl], [xl, y + 6]], arrow: { x: xl, y: y + 6, dir: "up" }, labels: [{ x: (xl + xr) / 2, y: yl, text: l.connector.name, back: true, connectorId: l.connector.id }] });
        routes.set(l.connector.id, `M${xsRow[l.hi]} ${y} L${xr} ${y + 6} V${yl} H${xl} V${y + 6} L${xsRow[l.lo]} ${y}`);
      }
      // A branch Step's other Connectors in words: left of the row's first Step, else right below.
      row.stations.forEach((id, i) => {
        const mine = t.chips.filter((c) => c.stepId === id);
        mine.forEach((c, m) => {
          // Left of the row's first Step while it fits in the band; else right below it.
          const fits = xsRow[i] - 14 - (c.text.length * 6.2 + 18) >= 8;
          if (i === 0 && fits) chips.push({ stepId: id, x: xsRow[i] - 14, y: y - 9 + m * 22, text: c.text, align: "right", connectorId: c.connector.id });
          else chips.push({ stepId: id, x: xsRow[i] + 8, y: y + 8 + m * 22, text: c.text, align: "left", connectorId: c.connector.id });
        });
      });
    });
    for (const l of loops) lines.push({ id: l.id, points: l.line });
    for (const l of loops) hints.set(l.id, outcomesHint(connectorsOf(l.connectorIds), name));
    t.rows.forEach((row, r) => hints.set(`row:${r}`, outcomesHint([...row.segments.map((s) => s.connector), ...(row.exit ? [row.exit] : [])], name)));
    const leftmost = Math.min(...stations.map((s) => s.x));
    branch = { label: { x: leftmost - 6, y: labelY }, stations, lines, loops, labels };
    polylines.push(...lines);
    bottom = Math.max(...rowYs) + 20 + Math.max(0, ...t.rows.map((r) => r.loops.reduce((m, l) => Math.max(m, l.depth), 0))) * 20 + 16;
  }

  // A Connector drawn only as a chip still has a way for a token to go: straight to its Step.
  for (const c of t.chips) {
    const [a, b] = [at.get(c.connector.from), at.get(c.connector.to ?? DONE_STATION)];
    if (a && b && !routes.has(c.connector.id)) routes.set(c.connector.id, `M${a.x} ${a.y} L${b.x} ${b.y}`);
  }

  // Every label and chip says on hover what its Connector does.
  for (const a of [...arcs, ...(branch?.loops ?? [])]) for (const l of a.labels) l.hint ??= hints.get(a.id);
  for (const l of [...arcs.flatMap((a) => a.labels), ...(branch?.labels ?? [])]) {
    const c = l.connectorId ? t.connectors.get(l.connectorId) : undefined;
    if (c) l.hint = outcomeHint(c, name);
  }
  for (const c of chips) {
    const k = c.connectorId ? t.connectors.get(c.connectorId) : undefined;
    if (!c.hint && k) c.hint = outcomeHint(k, name);
  }

  return { width: opts.width, height: Math.ceil(bottom + 8), density, at, lineY, headY, columnY, guideTop, main, segmentLabels, arcs, branch, chips, entry, routes, polylines, hints };
}

/** A route between two stations with no Connector between them (a move by hand): straight. */
export function handRoute(h: Horizontal, from: string, to: string): string | undefined {
  const [a, b] = [h.at.get(from), h.at.get(to)];
  if (!a || !b) return undefined;
  return `M${a.x} ${a.y} L${b.x} ${b.y}`;
}

/** Corners rounded: the SVG path of a polyline. */
export function rounded(points: Point[], r = 7): string {
  if (points.length < 2) return "";
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, q, s] = [points[i - 1], points[i], points[i + 1]];
    const l1 = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const l2 = Math.hypot(s[0] - q[0], s[1] - q[1]);
    const k = Math.min(r, l1 / 2, l2 / 2);
    const a: Point = [q[0] + ((p[0] - q[0]) / (l1 || 1)) * k, q[1] + ((p[1] - q[1]) / (l1 || 1)) * k];
    const b: Point = [q[0] + ((s[0] - q[0]) / (l2 || 1)) * k, q[1] + ((s[1] - q[1]) / (l2 || 1)) * k];
    d += ` L${a[0]} ${a[1]} Q${q[0]} ${q[1]} ${b[0]} ${b[1]}`;
  }
  const end = points[points.length - 1];
  return `${d} L${end[0]} ${end[1]}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Counting crossings between drawn lines.                                                     */
/* ------------------------------------------------------------------------------------------ */

type Seg = [Point, Point];

function segs(p: Polyline): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < p.points.length - 1; i++) out.push([p.points[i], p.points[i + 1]]);
  return out;
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const same = (a: Point, b: Point) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;

/** Two runs meet other than end to end: they cross, or one runs along the other. */
function meet([a, b]: Seg, [c, d]: Seg): boolean {
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // Collinear and overlapping.
  if (d1 === 0 && d2 === 0) {
    const overlap = (p: number, q: number, r: number, s: number) => Math.min(Math.max(p, q), Math.max(r, s)) - Math.max(Math.min(p, q), Math.min(r, s)) > 0.5;
    return a[0] === b[0] ? a[0] === c[0] && overlap(a[1], b[1], c[1], d[1]) : a[1] === c[1] && overlap(a[0], b[0], c[0], d[0]);
  }
  return false;
}

/** The pairs of drawn lines that cross or run along each other. */
export function crossings(polylines: Polyline[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < polylines.length; i++) {
    for (let j = i + 1; j < polylines.length; j++) {
      const [p, q] = [polylines[i], polylines[j]];
      if (segs(p).some((s) => segs(q).some((u) => meet(s, u)))) out.push([p.id, q.id]);
    }
  }
  return out;
}

/** The layout the line draws, for a Workflow at a width: its topology, density and pixels. */
export function lineLayout(workflow: LineWorkflow, opts: Omit<HorizontalOptions, "density"> & { density?: Density }): { topology: LineTopology; horizontal: Horizontal } {
  const topology = lineTopology(workflow);
  return { topology, horizontal: horizontal(topology, opts) };
}

/** A loop back as a bracket on the left of a line that runs down the page: its stations by index, nested. */
export type Bracket = { connector: LineConnector; lo: number; hi: number; depth: number };

/**
 * The loops back of the main line as brackets left of a vertical line (the phone), each nested
 * round the ones it holds; a track's loops are brackets of their own there.
 */
export function brackets(t: LineTopology): Bracket[] {
  const list: Bracket[] = [];
  for (const e of [...t.under, ...t.over]) {
    if (e.kind === "track") for (const d of e.drops) list.push({ connector: d.connector, lo: e.lo, hi: d.at, depth: 0 });
    else if (e.back) list.push({ connector: e.connector, lo: e.lo, hi: e.hi, depth: 0 });
  }
  nest(list);
  return list;
}
