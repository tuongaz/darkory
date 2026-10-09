import { DONE_STATION, sideSteps, type LineConnector, type LineStep, type LineWorkflow } from "./model";
import { estimate, twoLines, type Measure } from "./measure";
import { along, Board, cuts, runsOf, type Box, type Placed as TextBox, type Pt } from "./place";
import { AFTER_BRANCH, BREAKDOWN_BRANCH, breakdownOutcomeHint, ENTRY_LABEL, entryHint, FILES_LABEL, filesHint, gapHint, HAND_LABEL, handHint, holdHint, HOLD_NOTE, outcomeHint, outcomesHint } from "./words";

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
 * - one Workflow of several drawn alone (`LineWorkflow.drawn`, ADR 0019): a Connector into another
 *   Workflow's Step is an exit, a chip at the end of a short leg down from its Step ("bug → Bugs ›
 *   Investigate"), a plain chip where that leg would cross a line; one from another Workflow is an
 *   entry on the Step it reaches ("from Triage · bug"), the arrow into the line's first Step where
 *   New Tasks' is not, else a mark over the Step's head; no Connector touching a drawn Step is
 *   dropped;
 * - new Tasks enter from the left into the Step they start at; the breakdown Step sits on a short
 *   branch "Break down" above that entry, its arrow "files Subtasks" joining it; a hold no
 *   Connector joins parks below the entry, its arrow "by hand";
 * - every line carries words, and a sentence for its hover (`hints`); no two words, chips or heads
 *   meet, nor sit on a line not their own (`boxes`, `clashes`): a head raised a tier, a label broken
 *   onto two lines or moved along its arc, else the line does not `fit` and runs down the page;
 * - neighbours no Connector joins say "by hand" only where the first has no outcome on; a gap its
 *   outcomes lead around says nothing.
 * `lineTopology` decides all of that in station order; `horizontal` turns it into pixels.
 */

export type Side = "under" | "over";

/**
 * A neighbour pair on the main line: solid along its Connector. Where none joins them it is
 * dotted: "by hand" (`hand`) when the left Step has no outcome forward, so a human moves its Tasks
 * on; a bare gap when its outcomes all lead elsewhere (a skip, Done, the branch), so nothing moves
 * along it and a Task reaches the right Step only by being filed there (or moved there by hand).
 */
export type Segment = { lo: number; from: string; to: string; connector?: LineConnector; hand?: boolean };

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

/**
 * A Connector shown in words by its Step, with what it says on hover: a `chip` the drawing cannot
 * route ("fail → Build"); or one between a drawn Step and a Step of another Workflow (ADR 0019),
 * an `exit` by the drawn Step it leaves ("bug → Bugs › Investigate") or an `entry` on the drawn
 * Step it reaches ("from Triage · bug").
 */
export type Chip = { kind: "chip" | "exit" | "entry"; stepId: string; connector: LineConnector; text: string; hint: string };

/** An exit or an entry: a Connector crossing into or out of the Workflow drawn. */
export type Crossing = Chip & { kind: "exit" | "entry" };

/** A list of chips (or marks) by the Step they stand at, each Step's in the list's order. */
export function byStep<T extends { stepId: string }>(list: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) out.set(x.stepId, [...(out.get(x.stepId) ?? []), x]);
  return out;
}

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
  /** Connectors out of a drawn Step into another Workflow's, in Workflow order. */
  exits: Crossing[];
  /** Connectors into a drawn Step from another Workflow's, by the Step they reach. */
  entries: Crossing[];
  /** The Steps of other Workflows the line names, as "Bugs › Investigate". */
  others: Map<string, string>;
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

/** Compares Steps in the Project's order: their Workflow's position, then their own. */
function stepOrder(workflows: LineWorkflow["workflows"]): (a: LineStep, b: LineStep) => number {
  const rank = new Map(workflows.map((w) => [w.id, w.position]));
  const of = (s: LineStep) => rank.get(s.workflow_id) ?? Number.POSITIVE_INFINITY;
  return (a, b) => {
    const [wa, wb] = [of(a), of(b)];
    return (wa === wb ? 0 : wa - wb) || byPosition(a, b);
  };
}

/** The Steps of other Workflows a drawing's Connectors reach, each named with its Workflow: "Bugs › Investigate". */
function otherSteps(workflow: LineWorkflow, drawn: ReadonlyMap<string, LineStep>, touching: readonly LineConnector[]): Map<string, string> {
  const every = new Map(workflow.steps.map((s) => [s.id, s]));
  const out = new Map<string, string>();
  for (const c of touching) {
    for (const id of [c.from, c.to]) {
      const s = id === null || drawn.has(id) ? undefined : every.get(id);
      if (s) out.set(s.id, `${workflowName(workflow, s)} › ${s.name}`);
    }
  }
  return out;
}

const workflowName = (workflow: LineWorkflow, s: LineStep) => workflow.workflows.find((w) => w.id === s.workflow_id)?.name ?? "Another Workflow";

/** The Connectors out of a drawn Step into another Workflow's, as exits, in the order of the Steps they leave. */
function exitTopology(
  touching: readonly LineConnector[],
  drawn: ReadonlyMap<string, LineStep>,
  others: ReadonlyMap<string, string>,
  byFrom: (a: LineConnector, b: LineConnector) => number,
  fullName: (id: string | null) => string,
): Crossing[] {
  return touching
    .filter((c) => drawn.has(c.from) && c.to !== null && others.has(c.to))
    .sort(byFrom)
    .map((c) => ({ kind: "exit", stepId: c.from, connector: c, text: `${c.name} → ${others.get(c.to!)}`, hint: outcomeHint(c, fullName) }));
}

/** The Connectors into a drawn Step from another Workflow's, as entries: by the Step they reach, then the Step they leave. */
function entryTopology(
  touching: readonly LineConnector[],
  workflow: LineWorkflow,
  drawn: ReadonlyMap<string, LineStep>,
  inOrder: (a: LineStep, b: LineStep) => number,
  fullName: (id: string | null) => string,
): Crossing[] {
  const every = new Map(workflow.steps.map((s) => [s.id, s]));
  return touching
    .filter((c) => !drawn.has(c.from) && every.has(c.from) && c.to !== null && drawn.has(c.to))
    .sort((a, b) => inOrder(drawn.get(a.to!)!, drawn.get(b.to!)!) || inOrder(every.get(a.from)!, every.get(b.from)!) || a.position - b.position)
    .map((c) => ({ kind: "entry", stepId: c.to!, connector: c, text: `from ${workflowName(workflow, every.get(c.from)!)} · ${c.name}`, hint: outcomeHint(c, fullName) }));
}

/**
 * The line's stations, routes and branch, in station order. `workflow` is the Project's whole
 * graph; the line draws the Steps of `workflow.drawn` (every Step when unsaid). Where Tasks start
 * and which Steps leave the line are the Project's (`sideSteps`), so a Workflow drawn alone says
 * "New Tasks start here" only where they do. A Connector between a drawn Step and another
 * Workflow's is an exit or an entry; one touching no drawn Step belongs to another drawing.
 */
export function lineTopology(workflow: LineWorkflow): LineTopology {
  const inOrder = stepOrder(workflow.workflows);
  const every = new Map(workflow.steps.map((s) => [s.id, s]));
  const ordered = (workflow.drawn === undefined ? [...workflow.steps] : workflow.steps.filter((s) => s.workflow_id === workflow.drawn)).sort(inOrder);
  const steps = new Map(ordered.map((s) => [s.id, s]));
  const sides = sideSteps(workflow);
  const sideIds = new Set([...sides.after].filter((id) => steps.has(id)));
  const before = [...sides.before].find((id) => steps.has(id));
  const start = sides.start !== undefined && steps.has(sides.start) ? sides.start : undefined;
  const holds = ordered.filter((s) => sides.holds.has(s.id)).map((s) => s.id);
  const main = [...ordered.filter((s) => !sideIds.has(s.id) && s.id !== before && !sides.holds.has(s.id)).map((s) => s.id), DONE_STATION];
  const index = new Map(main.map((id, i) => [id, i]));
  const name = (id: string | null) => (id === null ? "Done" : (steps.get(id)?.name ?? "a Step"));
  const touching = workflow.connectors.filter((c) => steps.has(c.from) || (c.to !== null && steps.has(c.to)));
  const byFrom = (a: LineConnector, b: LineConnector) => inOrder(every.get(a.from)!, every.get(b.from)!) || a.position - b.position;
  const connectors = touching.filter((c) => steps.has(c.from) && (c.to === null || steps.has(c.to))).sort(byFrom);
  const others = otherSteps(workflow, steps, touching);
  // A Step of either side by its name, another Workflow's with that Workflow's: "Bugs › Investigate".
  const fullName = (id: string | null) => (id !== null && others.has(id) ? others.get(id)! : name(id));
  const exits = exitTopology(touching, steps, others, byFrom, fullName);
  const entries = entryTopology(touching, workflow, steps, inOrder, fullName);
  const segments: Segment[] = main.slice(0, -1).map((from, i) => ({ lo: i, from, to: main[i + 1] }));
  const chips: Chip[] = [];
  const forward: Arc[] = [];
  const backs: LineConnector[] = [];
  const sideLinks: LineConnector[] = [];
  const sideOut: LineConnector[] = [];
  const chip = (c: LineConnector) => chips.push({ kind: "chip", stepId: c.from, connector: c, text: `${c.name} → ${name(c.to)}`, hint: outcomeHint(c, name) });

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
  // A Step with an outcome that leads on (to a later Step, Done, or off the line) moves its Tasks
  // along it; one with none, or only loops back, has its Tasks moved on by hand.
  const leadsOn = new Set([...connectors.filter((c) => c.to === null || !index.has(c.to) || index.get(c.to)! > index.get(c.from)!).map((c) => c.from), ...exits.map((e) => e.stepId)]);
  for (const s of segments) if (!s.connector) s.hand = !leadsOn.has(s.from);

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
  return { main, start, before, holds, connectors: new Map(connectors.map((c) => [c.id, c])), steps, segments, under, over, rows, chips, exits, entries, others, loops, maxUnder, maxOver };
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

/** How a station's head reads: name and Skill over who takes it (tokens), name over Skill and count (beads), or the name alone. */
export type HeadStyle = Density | "compact";

/** Station spacing under which tokens give way to beads. */
export const BEAD_SPACING = 130;
/** Main-line Steps beyond which tokens give way to beads. */
export const BEAD_STEPS = 9;

/** The least room between two heads side by side. */
const HEAD_GAP = 12;
/** A token head's second row (who takes it, the median) when the drawing has not said. */
const TOKENS_DETAIL = 150;
const HEAD_H: Record<HeadStyle, number> = { tokens: 44, beads: 60, compact: 18 };
/** The mark's padding, border and the arrow beside its words. */
const MARK_PAD = 34;
/** The mark over a start Step the entry arrow cannot reach: "New Tasks start here ↓", its arrow over the station (`x`), its words on `lines`. */
export type Mark = { x: number; left: number; top: number; y: number; arrow: "left" | "right"; lines: string[] };
/** From the mark's end to the middle of its arrow, which stands over the station. */
const MARK_TIP = 14;

/**
 * Tokens or beads, by how many Steps the main line carries and the room each gets: tokens only
 * up to `BEAD_STEPS` Steps, `BEAD_SPACING` apart, with no two heads (name and Skill) meeting.
 */
export function densityFor(topology: LineTopology, width: number, measure: Measure = estimate): Density {
  const steps = topology.main.length - 1;
  if (steps > BEAD_STEPS) return "beads";
  const { xs, sp } = stationsX(topology, width, zoneOf(topology, measure), "tokens");
  if (sp < BEAD_SPACING) return "beads";
  const heads = topology.main.map((id, i) => ({ x: xs[i], w: headText(topology, id, "tokens", measure).w }));
  return heads.every((h, i) => i === 0 || h.x - h.w / 2 >= heads[i - 1].x + heads[i - 1].w / 2 + HEAD_GAP) ? "tokens" : "beads";
}

/** The room each end of the line keeps for the head standing there. */
type Edges = { left: number; right: number };

/**
 * The line's margins and station spacing: roomy (56–100px) when the width allows; where it is
 * tight, each end keeps just the half of its head and a little, so the stations get the rest.
 */
function spacingFor(n: number, width: number, edges?: Edges) {
  if (n <= 1) return { margin: width / 2, right: width / 2, sp: 0 };
  const roomy = Math.min(100, Math.max(56, (width / n) * 0.55));
  const tight = !!edges && (width - 2 * roomy) / (n - 1) < BEAD_SPACING;
  const margin = tight ? Math.min(roomy, Math.max(24, edges.left)) : roomy;
  const right = tight ? Math.min(roomy, Math.max(24, edges.right)) : roomy;
  return { margin, right, sp: (width - margin - right) / (n - 1) };
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
  /** Where New Tasks do not start at the line's first Step: the Connectors from other Workflows into it, which the arrow brings in instead. */
  arrive: Crossing[];
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
  /** The breakdown Step's words left of it: its outcomes, those crossing into or out of the Workflow, and where its Subtasks start when no arrow can say it. */
  chips: { kind: Chip["kind"]; text: string; connectorId?: string; hint?: string }[];
};

const ZONE_L = 16;
/** Between the zone and the first station: room for that station's name and token column. */
const ZONE_GAP = { tokens: 112, beads: 56 } as const;
/** A label's padding (px-1.5) and height (leading-4); a two-line label's. */
const LABEL_PAD = 12;
const LABEL_H = 16;
const LABEL2_H = 30;
/** A chip's padding and border, and its height. */
const CHIP_PAD = 18;
const CHIP_H = 20;
/** How far under the line an exit's first chip stands (its middle), and the tick from its leg into it. */
const EXIT_TOP = 30;
const EXIT_TICK = 10;
/** Half the room a station takes on its line. */
const STATION_R = 9;
/** A branch Step's name line over its station: as tall as a token there. */
const NAME_H = 30;
/** How far over its station a branch Step's name line begins: its foot clear of the words on its row. */
export const NAME_TOP = 48;
/** How far a token's halo reaches past it ("now", selected, ringed: globals.css .wl-token box-shadow). */
export const TOKEN_HALO = 6;

const chipW = (text: string, measure: Measure) => measure(text, "chip") + CHIP_PAD;
const labelW = (text: string, measure: Measure) => measure(text, "label") + LABEL_PAD;

function nameOf(t: LineTopology) {
  return (id: string | null) => (id === null || id === DONE_STATION ? "Done" : (t.steps.get(id)?.name ?? t.others.get(id) ?? "a Step"));
}

/** A branch Step's name line, roughly, when the drawing has not said: name, Skill, a mark. */
function nameLine(s: LineStep | undefined, measure: Measure): number {
  if (!s) return 0;
  return measure(s.name, "side") + (s.skill ? measure(s.skill.name, "skillLarge") + 6 : 0) + 30;
}

export function zoneOf(t: LineTopology, measure: Measure = estimate, labelWidth?: (stepId: string) => number): Zone | undefined {
  const entry = t.start !== undefined && t.main[0] === t.start;
  const arrive = entry ? [] : t.entries.filter((e) => e.stepId === t.main[0]);
  if (!entry && arrive.length === 0 && !t.before && t.holds.length === 0) return undefined;
  const words = arrive.length > 0 ? arrive.map((e) => e.text) : [ENTRY_LABEL];
  const entryStart = Math.round(ZONE_L + Math.max(...words.map((w) => measure(w, "entry"))) + 10);
  const holdW = Math.max(0, ...t.holds.map((id) => Math.max(measure(t.steps.get(id)?.name ?? "", "side"), measure(HOLD_NOTE, "note"))));
  const hx = Math.round(Math.max(entryStart + 22, ZONE_L + holdW + 18));
  let right = entry || arrive.length > 0 ? entryStart + 48 : ZONE_L;
  if (t.holds.length > 0) right = Math.max(right, hx + 6 + labelW(HAND_LABEL, measure));
  const chips: Zone["chips"] = [];
  let px = 0;
  let joinX = 0;
  if (t.before) {
    for (const c of t.chips.filter((c) => c.stepId === t.before)) chips.push({ kind: "chip", text: c.text, connectorId: c.connector.id });
    for (const c of [...t.exits, ...t.entries].filter((c) => c.stepId === t.before)) chips.push({ kind: c.kind, text: c.text, connectorId: c.connector.id, hint: c.hint });
    if (!entry && t.start) chips.push({ kind: "chip", text: FILES_LABEL });
    const widest = Math.max(0, ...chips.map((c) => chipW(c.text, measure)));
    px = Math.round(ZONE_L + (widest ? widest + 14 : 6));
    const nameW = labelWidth?.(t.before) ?? nameLine(t.steps.get(t.before), measure);
    if (entry) joinX = Math.round(Math.max(px + 7 + labelW(FILES_LABEL, measure) + 24, (t.holds.length ? hx : entryStart) + 34));
    right = Math.max(right, px - 6 + nameW, joinX);
  }
  return { entry, arrive, entryStart, px, joinX, hx, right: Math.round(right), chips };
}

/** Each main-line station's x: spread over the width, right of the zone where Tasks enter. */
function stationsX(t: LineTopology, width: number, zone: Zone | undefined, density: Density, edges?: Edges) {
  const n = t.main.length;
  const { margin, right, sp } = spacingFor(n, width, edges);
  if (!zone || n <= 1) return { xs: t.main.map((_, i) => Math.round(margin + i * sp)), margin, sp };
  // Clear of the zone by the first head's half (and, at token density, its column of tokens).
  const gap = density === "tokens" ? ZONE_GAP.tokens : Math.max(ZONE_GAP.beads, (edges?.left ?? 0) + 4);
  const left = Math.max(margin, zone.right + gap);
  const step = Math.max(40, (width - right - left) / (n - 1));
  return { xs: t.main.map((_, i) => Math.round(left + i * step)), margin, sp: step };
}

/** What a head says and the room it takes: its name (on one line or two), and what goes under it. */
function headText(t: LineTopology, id: string, style: HeadStyle, measure: Measure, detail?: (id: string) => number | undefined): { lines: string[]; w: number; h: number } {
  const step = t.steps.get(id);
  const name = id === DONE_STATION ? "Done" : (step?.name ?? "a Step");
  const h = HEAD_H[style];
  if (style === "compact") return { lines: [name], w: measure(name, "compact") + (detail?.(id) ?? 0), h };
  if (style === "tokens") {
    const first = measure(name, "headLarge") + (step?.skill ? 4 + measure(step.skill.name, "skillLarge") : 0);
    const second = detail?.(id) ?? (id === DONE_STATION ? measure("00 today", "count") : TOKENS_DETAIL);
    return { lines: [name], w: Math.max(first, second), h };
  }
  if (id === DONE_STATION) return { lines: [name], w: measure(name, "head"), h: 30 };
  // A bead head: the name over its Skill and how many Tasks wait; a name wider than those breaks onto two lines.
  const under = Math.max(measure(step?.skill?.name ?? "hold", "skill"), detail?.(id) ?? measure("00 Tasks", "count"));
  const one = measure(name, "head");
  const named = one > Math.max(under, 56) ? twoLines(name, "head", measure) : { lines: [name], width: one };
  return { lines: named.lines, w: Math.max(named.width, under), h };
}

/** A station's head as drawn: centred on its station, raised a tier where its neighbour's would meet it. */
export type Head = { id: string; x: number; top: number; tier: number; w: number; h: number; lines: string[] };

type HeadPlan = { x: number; w: number; h: number };

/**
 * A way a mark stands over a head: its words left of its arrow (`right`) or right of it, on one
 * line or more. The start Step's says "New Tasks start here"; an entry's "from Triage · bug".
 */
export type MarkPlan = { kind: "start" | "entry"; side: "left" | "right"; lines: string[]; w: number; h: number };

/** The ways one mark can be worded at a station (one line, else two), before its side is chosen. */
type MarkSpec = { kind: MarkPlan["kind"]; variants: { lines: string[]; w: number; h: number }[] };

/** A head's tier, and its station's marks stacked over it, the nearest first. */
type HeadChoice = { tier: number; marks: MarkPlan[] };

/** The room a stack of marks takes over its head. */
const stackH = (marks: readonly MarkPlan[]) => marks.reduce((n, m) => n + m.h + 4, 0);

/** Every way of picking one of each list, the first list's choice varying slowest. */
function product<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]]);
}

/**
 * Which heads to raise a tier, and how the start Step's mark stands, so that nothing over the line
 * meets: no two heads, no raised head's guide running down past another head or the mark, no arc
 * over the line landing through a head or the mark on its way to its own. Heads stay down where
 * they can, left to right; `ok` is false when no way is clear (the line then runs down the page).
 */
function placeHeads(hs: HeadPlan[], legs: { x: number; at: number }[], tierH: number, marks: ReadonlyMap<number, MarkSpec[]>, width: number) {
  const n = hs.length;
  const low = Math.max(...hs.map((h) => h.h));
  const top = (c: HeadChoice) => -c.tier * tierH;
  const headBox = (i: number, c: HeadChoice): Box => ({ x: hs[i].x - hs[i].w / 2 - HEAD_GAP / 2, y: top(c), w: hs[i].w + HEAD_GAP, h: hs[i].h });
  const markLeft = (i: number, m: MarkPlan) => (m.side === "right" ? hs[i].x + MARK_TIP - m.w : hs[i].x - MARK_TIP);
  const markBoxes = (i: number, c: HeadChoice): Box[] => {
    let y = top(c);
    return c.marks.map((m) => {
      y -= m.h + 4;
      return { x: markLeft(i, m), y, w: m.w, h: m.h };
    });
  };
  const boxTop = (c: HeadChoice) => top(c) - stackH(c.marks);
  const guide = (i: number, c: HeadChoice): Box | undefined => (c.tier > 0 ? { x: hs[i].x - 2, y: top(c) + hs[i].h + 4, w: 4, h: low - (top(c) + hs[i].h + 4) } : undefined);
  const legsAt = legs.map((l) => l.at);
  const legBoxes = (i: number, c: HeadChoice): Box[] => legs.filter((_, k) => legsAt[k] === i).map((l) => ({ x: l.x - 2, y: -1e4, w: 4, h: 1e4 + boxTop(c) - 6 }));
  const solid = (i: number, c: HeadChoice) => [headBox(i, c), ...markBoxes(i, c)];
  const thin = (i: number, c: HeadChoice) => [guide(i, c), ...legBoxes(i, c)].filter((b): b is Box => !!b);
  const conflict = (i: number, ci: HeadChoice, j: number, cj: HeadChoice) => {
    const [si, sj] = [solid(i, ci), solid(j, cj)];
    if (si.some((a) => sj.some((b) => meetsBox(a, b)))) return true;
    if (thin(i, ci).some((a) => sj.some((b) => meetsBox(a, b)))) return true;
    return thin(j, cj).some((a) => si.some((b) => meetsBox(a, b)));
  };
  const choices = (i: number): HeadChoice[] => {
    const specs = marks.get(i);
    if (!specs?.length) return [{ tier: 0, marks: [] }, { tier: 1, marks: [] }];
    // One wording per mark, then a side for the stack, its arrows over the station.
    const stacks = product(specs.map((m) => m.variants.map((v) => ({ ...v, kind: m.kind })))).flatMap((stack) =>
      (["right", "left"] as const).map((side) => stack.map((m): MarkPlan => ({ ...m, side }))),
    );
    const inside = stacks.filter((stack) => stack.every((m) => markLeft(i, m) >= 2 && markLeft(i, m) + m.w <= width - 2));
    return [0, 1].flatMap((tier) => inside.map((stack) => ({ tier, marks: stack })));
  };
  const picked: HeadChoice[] = [];
  let nodes = 0;
  const search = (i: number): boolean => {
    if (i === n) return true;
    if (++nodes > 40_000) return false;
    for (const c of choices(i)) {
      if (picked.some((p, j) => conflict(j, p, i, c))) continue;
      picked.push(c);
      if (search(i + 1)) return true;
      picked.pop();
    }
    return false;
  };
  if (search(0)) return { choices: picked, ok: true };
  return { choices: hs.map((_, i): HeadChoice => ({ tier: 0, marks: (marks.get(i) ?? []).map((m) => ({ ...m.variants[0], kind: m.kind, side: "right" })) })), ok: false };
}

const meetsBox = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

export type Point = [number, number];
/** A drawn line as straight runs between corners, for drawing (corners rounded) and for counting crossings. */
export type Polyline = { id: string; points: Point[] };

export type Label = {
  x: number;
  y: number;
  text: string;
  /** Broken onto two lines where one would not fit its gap. */
  lines?: string[];
  back?: boolean;
  connectorId?: string;
  /** Left-aligned at `x` (else centred), semibold. */
  align?: "start";
  hint?: string;
};

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

/** An exit's leg: from its Step's station down and into its chip (also among `polylines`, as `exit:<connector id>`). */
export type ExitLeg = { connectorId: string; stepId: string; points: Point[] };

export type Horizontal = {
  width: number;
  height: number;
  density: Density;
  /** Each station's centre: main-line ones on `lineY`, branch ones on their row. */
  at: Map<string, { x: number; y: number }>;
  lineY: number;
  /** The top of the lowest tier of station names, and of the token (or bead) columns. */
  headY: number;
  columnY: number;
  /** Each main-line station's head: where it stands and what it says. */
  heads: Head[];
  main: { from: string; to: string; x1: number; x2: number; dotted: boolean; gap?: boolean; connectorId?: string }[];
  segmentLabels: Label[];
  arcs: DrawnArc[];
  branch?: {
    label: { x: number; y: number };
    stations: BranchStation[];
    lines: Polyline[];
    loops: DrawnArc[];
    labels: Label[];
  };
  chips: { kind: Chip["kind"]; stepId: string; x: number; y: number; text: string; align: "left" | "right" | "center"; connectorId?: string; hint?: string }[];
  /** Each exit drawn at the end of a short leg down from its Step: the leg, from the station to its chip. */
  exits: ExitLeg[];
  /** Where Tasks enter the line, when it draws an entry (see `Zone`). */
  entry?: {
    /**
     * The entry arrow into the line's first Step, with its words: "New Tasks start here" when they
     * start there, else the Connectors from other Workflows into it, "from Triage · bug" a line each.
     */
    arrow?: { line: Point[]; head: { x: number; y: number; dir: "right" }; label: Label; connectorIds: string[] };
    /** The mark over a start Step the arrow cannot reach: "New Tasks start here ↓", its left edge at `left` (over the station, or beside an arc's leg). */
    mark?: Mark & { hint: string };
    /** The marks over the Steps the arrow does not lead into that Tasks reach from another Workflow: "from Triage · bug ↓". */
    arrivals?: (Mark & { stepId: string; hint: string; connectorIds: string[] })[];
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
  /** Every word, chip and head as the box it takes: no two meet. */
  boxes: TextBox[];
  /** What met what where it had to be put (a box and another box or a drawn line): none when the line reads. */
  clashes: [string, string][];
  /** The main line's heads and words fit the width without meeting: else it runs down the page. */
  fits: boolean;
};

export type HorizontalOptions = {
  width: number;
  density?: Density;
  /** The tallest token (or bead) column, in px. */
  column: number;
  /** How the heads read; by `density` when unsaid. */
  heads?: HeadStyle;
  /** Leave the branch off (a single Task's path, which never reaches it). */
  noBranch?: boolean;
  /** How far left of Done the branch's first row ends: more when its Steps carry ghosts. */
  branchGap?: number;
  /** How wide a branch Step's name line runs (name, Skill, marks, tokens), so the next Step stands clear of it. */
  labelWidth?: (stepId: string) => number;
  /** How tall a parked hold's token column runs under its name, in px. */
  holdColumn?: (stepId: string) => number;
  /** How wide what a head says under its name runs ("3 Tasks", who takes it), or beside it ("+2"). */
  headDetail?: (stepId: string) => number | undefined;
  /** How wide the line's words run; estimated when unsaid. */
  measure?: Measure;
  /** What the branch is called: "After a Parent", or a Parent's "Next for MAIN-7". */
  branchLabel?: string;
};

/** The step between nested legs at a shared station, and the inset of the outermost. */
export const LEG = 9;
const LEG0 = 6;
const ROW_GAP = 66;
const OVER_STEP = 20;
const UNDER_STEP = 22;
/** Where a leg under the line begins, below the station it stands at. */
const UNDER_TOP = 9;
/** The rows under everything a word moves down to when its own place is taken. */
const ROW = 18;

/** The line laid out left to right in `width` px. */
export function horizontal(t: LineTopology, opts: HorizontalOptions): Horizontal {
  const measure = opts.measure ?? estimate;
  const density = opts.density ?? densityFor(t, opts.width, measure);
  const style: HeadStyle = opts.heads ?? density;
  const n = t.main.length;
  const name = nameOf(t);
  const zone = zoneOf(t, measure, opts.labelWidth);
  const texts = t.main.map((id) => headText(t, id, style, measure, opts.headDetail));
  const { xs, margin, sp } = stationsX(t, opts.width, zone, density, { left: texts[0].w / 2 + 12, right: texts[n - 1].w / 2 + 12 });
  const board = new Board();

  // The heads: each over its station, raised a tier where it would meet its neighbour's; the
  // start Step's keeps a row over it for its mark, and so does a Step Tasks enter from another
  // Workflow unless the entry arrow leads into it.
  const marked = t.start !== undefined && t.main[0] !== t.start;
  // A mark on one line, else on two ("New Tasks / start here ↓"); several entries one a line.
  const wordings = (lines: string[]): MarkSpec["variants"] => {
    const box = (ls: string[]) => ({ lines: ls, w: Math.max(...ls.map((l) => measure(l, "entry"))) + MARK_PAD, h: ls.length === 1 ? 20 : 14 * ls.length + 4 });
    if (lines.length > 1) return [box(lines)];
    // "from Triage · bug" breaks after its "·" or not at all, so no line begins with one.
    const split = twoLines(lines[0], "entry", measure, (first) => !lines[0].includes(" · ") || first.endsWith(" ·"));
    return split.lines.length > 1 ? [box(lines), box(split.lines)] : [box(lines)];
  };
  const startAt = marked && t.start !== undefined ? t.main.indexOf(t.start) : -1;
  const markSpecs = new Map<number, MarkSpec[]>();
  if (startAt >= 0) markSpecs.set(startAt, [{ kind: "start", variants: wordings([ENTRY_LABEL]) }]);
  const arriving = new Set(zone?.arrive.map((e) => e.connector.id));
  t.main.forEach((id, i) => {
    const words = t.entries.filter((e) => e.stepId === id && !arriving.has(e.connector.id)).map((e) => e.text);
    if (words.length > 0) markSpecs.set(i, [...(markSpecs.get(i) ?? []), { kind: "entry", variants: wordings(words) }]);
  });
  const plans: HeadPlan[] = t.main.map((_, i) => ({ x: xs[i], w: texts[i].w, h: texts[i].h }));
  const overLegs = t.over.flatMap((e) => [
    { x: xs[e.lo] + LEG0 + e.legLo * LEG, at: e.lo },
    { x: xs[e.hi] - LEG0 - e.legHi * LEG, at: e.hi },
  ]);
  const markRoom = Math.max(0, ...[...markSpecs.values()].map((specs) => specs.reduce((sum, m) => sum + Math.max(...m.variants.map((v) => v.h)) + 4, 0)));
  const tierH = Math.max(...plans.map((p) => p.h)) + markRoom + 8;
  const { choices, ok: headsFit } = placeHeads(plans, overLegs, tierH, markSpecs, opts.width);
  const ext = (c: HeadChoice) => stackH(c.marks);
  const minTop = Math.min(...choices.map((c) => -c.tier * tierH - ext(c)));
  const headY = 28 + t.maxOver * OVER_STEP - minTop;
  const heads: Head[] = t.main.map((id, i) => ({ id, x: xs[i], top: headY - choices[i].tier * tierH, tier: choices[i].tier, w: texts[i].w, h: texts[i].h, lines: texts[i].lines }));
  const columnY = headY + Math.max(...texts.map((x) => x.h)) + 10;
  const lineY = columnY + Math.max(opts.column, density === "tokens" ? 30 : 12) + (density === "tokens" ? 24 : 30);
  const at = new Map<string, { x: number; y: number }>();
  t.main.forEach((id, i) => at.set(id, { x: xs[i], y: lineY }));
  for (const x of xs) board.obstacle(`station`, { x: x - STATION_R, y: lineY - STATION_R, w: 2 * STATION_R, h: 2 * STATION_R });

  const polylines: Polyline[] = [{ id: "main", points: [[xs[0], lineY], [xs[n - 1], lineY]] }];
  const routes = new Map<string, string>();
  const main = t.segments.map((s) => ({ from: s.from, to: s.to, x1: xs[s.lo], x2: xs[s.lo + 1], dotted: !s.connector, gap: !s.connector && !s.hand, connectorId: s.connector?.id }));
  const hints = new Map<string, string>();
  for (const s of t.segments) if (s.connector) routes.set(s.connector.id, `M${xs[s.lo]} ${lineY} H${xs[s.lo + 1]}`);

  // Under the line: loops back in arcs, three or more into one Step on a track.
  const arcs: DrawnArc[] = [];
  const underY = (d: number) => lineY + 20 + d * UNDER_STEP;
  const y0 = lineY + UNDER_TOP;
  type Track = { arc: DrawnArc; y: number; xl: number; xe: number; drops: { x: number; connector: LineConnector }[]; target: string };
  const tracks: Track[] = [];
  for (const e of t.under) {
    const y = underY(e.depth);
    if (e.kind === "arc") {
      const xl = xs[e.lo] + LEG0 + e.legLo * LEG;
      const xr = xs[e.hi] - LEG0 - e.legHi * LEG;
      const line: Point[] = [[xr, y0], [xr, y], [xl, y], [xl, y0]];
      const [tx, fx] = e.back ? [xl, xr] : [xr, xl];
      arcs.push({ id: e.connector.id, side: "under", back: e.back, connectorIds: [e.connector.id], line, arrow: { x: tx, y: y0, dir: "up" }, labels: [] });
      routes.set(e.connector.id, `M${xs[e.back ? e.hi : e.lo]} ${lineY} L${fx} ${y0} V${y} H${tx} V${y0} L${xs[e.back ? e.lo : e.hi]} ${lineY}`);
    } else {
      const xl = xs[e.lo] + LEG0 + e.legLo * LEG;
      const xe = xs[e.hi];
      const line: Point[] = [[xe, y0], [xe, y], [xl, y], [xl, y0]];
      const arc: DrawnArc = { id: `track:${e.target}`, side: "under", back: true, connectorIds: e.drops.map((d) => d.connector.id), line, arrow: { x: xl, y: y0, dir: "up" }, labels: [] };
      arcs.push(arc);
      tracks.push({ arc, y, xl, xe, drops: e.drops.map((d) => ({ x: xs[d.at], connector: d.connector })), target: e.target });
      for (const d of e.drops) {
        const x = xs[d.at];
        if (d.at !== e.hi) polylines.push({ id: `drop:${d.connector.id}`, points: [[x, y0], [x, y - 9], [x - 9, y]] });
        routes.set(d.connector.id, `M${x} ${lineY} V${y} H${xl} V${y0} L${xs[e.lo]} ${lineY}`);
      }
    }
  }
  // Over the line: forward skips, and loops that cannot go under; each lands on its head's top.
  const boxTop = (i: number) => heads[i].top - ext(choices[i]);
  const overY = (d: number) => headY + minTop - 12 - d * OVER_STEP;
  for (const e of t.over) {
    const y = overY(e.depth);
    const xl = xs[e.lo] + LEG0 + e.legLo * LEG;
    const xr = xs[e.hi] - LEG0 - e.legHi * LEG;
    const [yl, yr] = [boxTop(e.lo) - 6, boxTop(e.hi) - 6];
    const line: Point[] = [[xl, yl], [xl, y], [xr, y], [xr, yr]];
    const [fx, tx] = e.back ? [xr, xl] : [xl, xr];
    const [fy, ty] = e.back ? [yr, yl] : [yl, yr];
    arcs.push({ id: e.connector.id, side: "over", back: e.back, connectorIds: [e.connector.id], line, arrow: { x: tx, y: ty, dir: "down" }, labels: [] });
    const [a, b] = e.back ? [e.hi, e.lo] : [e.lo, e.hi];
    routes.set(e.connector.id, `M${xs[a]} ${lineY} L${fx} ${fy} V${y} H${tx} V${ty} L${xs[b]} ${lineY}`);
  }
  for (const a of arcs) polylines.push({ id: a.id, points: a.line });
  for (const p of polylines) board.addRuns(runsOf(p.id, p.points));
  // A head's guide down to its station, under its column.
  heads.forEach((h) => board.addRuns(runsOf(`guide:${h.id}`, [[h.x, h.top + h.h + 4], [h.x, lineY - STATION_R]])));
  const connectorsOf = (ids: string[]) => ids.map((id) => t.connectors.get(id)).filter((c): c is LineConnector => !!c);
  for (const a of arcs) hints.set(a.id, outcomesHint(connectorsOf(a.connectorIds), name));
  for (const p of polylines) if (p.id.startsWith("drop:")) hints.set(p.id, outcomesHint(connectorsOf([p.id.slice(5)]), name));

  // The heads where they stand; the start Step's mark over its head, centred, else with its arrow
  // over the station from one side, clear of the arcs landing beside it.
  heads.forEach((h) => board.fix({ id: `head:${h.id}`, kind: "head", text: h.lines.join(" "), x: h.x - h.w / 2, y: h.top, w: h.w, h: h.h }, [`guide:${h.id}`]));
  let mark: Mark | undefined;
  const chosen = startAt >= 0 ? choices[startAt].marks.find((m) => m.kind === "start") : undefined;
  if (chosen) {
    // Its arrow stands over the station, its words left of it (else right of it).
    const x = xs[startAt];
    const left = chosen.side === "right" ? x + MARK_TIP - chosen.w : x - MARK_TIP;
    const top = heads[startAt].top - chosen.h - 4;
    board.fix({ id: "mark", kind: "mark", text: ENTRY_LABEL, x: left, y: top, w: chosen.w, h: chosen.h });
    mark = { x, left, top, y: top + chosen.h / 2, arrow: chosen.side, lines: chosen.lines };
  }
  const arrivals = placeArrivals(t, { choices, heads, xs, lineY, arriving, board, routes, name });

  // Every segment says what moves along it: its Connector's outcome, or "by hand" where a human
  // moves the Task on. On the line when it fits between its stations, else on two lines between
  // the legs standing there; a gap nothing moves along says nothing.
  const underLegs = t.under.flatMap((e) => (e.kind === "arc" ? [xs[e.lo] + LEG0 + e.legLo * LEG, xs[e.hi] - LEG0 - e.legHi * LEG] : [xs[e.lo] + LEG0 + e.legLo * LEG]));
  const segmentLabels: Label[] = [];
  for (const s of t.segments) {
    const hint = s.connector ? outcomeHint(s.connector, name) : s.hand ? handHint(name(s.from), name(s.to)) : gapHint(name(s.from), name(s.to));
    hints.set(`seg:${s.from}`, hint);
    if (!s.connector && !s.hand) continue;
    const text = s.connector?.name ?? HAND_LABEL;
    const [a, b] = [xs[s.lo] + STATION_R + 1, xs[s.lo + 1] - STATION_R - 1];
    const own = ["main"];
    const id = `seg:${s.from}`;
    const w1 = labelW(text, measure);
    const label: Label = { x: (a + b) / 2, y: lineY, text, connectorId: s.connector?.id, hint };
    if (w1 <= b - a) {
      board.fix({ id, kind: "label", text, x: label.x - w1 / 2, y: lineY - LABEL_H / 2, w: w1, h: LABEL_H }, own);
    } else {
      // Two lines stand taller than the legs under the line begin: they go between them.
      const split = twoLines(text, "label", measure);
      const w2 = split.width + LABEL_PAD;
      const cuts = [a, ...underLegs.filter((x) => x > a && x < b).sort((p, q) => p - q), b];
      let room = { from: a, to: b, w: -1 };
      for (let k = 0; k < cuts.length - 1; k++) {
        const [p, q] = [k === 0 ? cuts[k] : cuts[k] + 3, k === cuts.length - 2 ? cuts[k + 1] : cuts[k + 1] - 3];
        if (q - p > room.w) room = { from: p, to: q, w: q - p };
      }
      if (split.lines.length === 2 && w2 <= room.w) {
        label.x = (room.from + room.to) / 2;
        label.lines = split.lines;
        board.fix({ id, kind: "label", text, x: label.x - w2 / 2, y: lineY - LABEL2_H / 2, w: w2, h: LABEL2_H }, own);
      } else {
        board.fix({ id, kind: "label", text, x: label.x - w1 / 2, y: lineY - LABEL_H / 2, w: w1, h: LABEL_H }, own);
      }
    }
    segmentLabels.push(label);
  }

  // Where Tasks enter, left of the line: the entry arrow, "Break down" above it, the parked holds below.
  const chips: Horizontal["chips"] = [];
  let entry: Horizontal["entry"];
  if (mark && t.start !== undefined) entry = { holds: [], mark: { ...mark, hint: entryHint(name(t.start)) } };
  if (arrivals.length > 0) {
    entry ??= { holds: [] };
    entry.arrivals = arrivals;
  }
  if (zone) {
    entry ??= { holds: [] };
    const x0 = xs[0];
    const start = t.start !== undefined ? name(t.start) : undefined;
    if (zone.entry || zone.arrive.length > 0) {
      const line: Point[] = [[zone.entryStart, lineY], [x0 - 11, lineY]];
      const words = zone.entry ? [ENTRY_LABEL] : zone.arrive.map((e) => e.text);
      const hint = zone.entry ? entryHint(start!) : outcomesHint(zone.arrive.map((e) => e.connector), name);
      const text = words.join(" ");
      entry.arrow = { line, head: { x: x0 - 11, y: lineY, dir: "right" }, label: { x: ZONE_L, y: lineY, text, ...(words.length > 1 ? { lines: words } : {}), align: "start", hint }, connectorIds: zone.arrive.map((e) => e.connector.id) };
      polylines.push({ id: "entry", points: line });
      board.addRuns(runsOf("entry", line));
      hints.set("entry", hint);
      board.fix({ id: "entry", kind: "entry", text, x: ZONE_L, y: lineY - 8 * words.length, w: Math.max(...words.map((w) => measure(w, "entry"))), h: 16 * words.length });
      for (const e of zone.arrive) routes.set(e.connector.id, `M${zone.entryStart} ${lineY} H${x0}`);
    }
    if (t.before) {
      const id = t.before;
      const py = lineY - 56;
      const px = zone.px;
      at.set(id, { x: px, y: py });
      const hint = filesHint(name(id), start);
      entry.before = { id, title: { x: px - 6, y: py - NAME_TOP - TOKEN_HALO - 20, hint }, station: { x: px, y: py } };
      board.obstacle("station", { x: px - 7, y: py - 7, w: 14, h: 14 });
      if (zone.entry) {
        const line: Point[] = [[px + 7, py], [zone.joinX, py], [zone.joinX, lineY - 3]];
        const label: Label = { x: (px + 7 + zone.joinX) / 2, y: py, text: FILES_LABEL, hint };
        entry.before.files = { line, head: { x: zone.joinX, y: lineY - 3, dir: "down" }, label };
        polylines.push({ id: "files", points: line });
        board.addRuns(runsOf("files", line));
        hints.set("files", hint);
        const w = labelW(FILES_LABEL, measure);
        board.fix({ id: "files", kind: "label", text: FILES_LABEL, x: label.x - w / 2, y: py - LABEL_H / 2, w, h: LABEL_H }, ["files"]);
      }
      board.fix({ id: "breakdown", kind: "note", text: BREAKDOWN_BRANCH, x: px - 6, y: py - NAME_TOP - TOKEN_HALO - 20, w: measure(BREAKDOWN_BRANCH, "note"), h: 16 });
      board.fix({ id: `name:${id}`, kind: "name", text: name(id), x: px - 6, y: py - NAME_TOP - TOKEN_HALO, w: opts.labelWidth?.(id) ?? nameLine(t.steps.get(id), measure), h: NAME_H + 2 * TOKEN_HALO });
      zone.chips.forEach((c, m) => {
        const connector = c.connectorId ? t.connectors.get(c.connectorId) : undefined;
        const w = chipW(c.text, measure);
        const chip = { kind: c.kind, stepId: id, x: px - 14, y: py - 9 + m * 22, text: c.text, align: "right" as const, connectorId: c.connectorId, hint: c.hint ?? (connector ? breakdownOutcomeHint(connector, name, start) : hint) };
        chips.push(chip);
        board.fix({ id: `chip:${id}:${m}`, kind: "chip", text: c.text, x: chip.x - w, y: chip.y, w, h: CHIP_H });
        // A crossing goes by its chip: out of the Step into it, or out of it into the Step.
        if (c.connectorId && c.kind !== "chip") routes.set(c.connectorId, chipRoute(c.kind, { x: px, y: py }, { x: chip.x - w / 2, y: chip.y + CHIP_H / 2 }));
      });
    }
    if (t.holds.length > 0) {
      let y = lineY + 50;
      for (const id of t.holds) {
        at.set(id, { x: zone.hx, y });
        entry.holds.push({ id, x: zone.hx, y, hint: holdHint(name(id)) });
        const w = Math.max(measure(name(id), "side"), measure(HOLD_NOTE, "note"));
        board.fix({ id: `hold:${id}`, kind: "name", text: name(id), x: zone.hx - 14 - w, y: y - 10, w, h: 36 });
        board.obstacle("station", { x: zone.hx - 7, y: y - 7, w: 14, h: 14 });
        y += 32 + (opts.holdColumn?.(id) ?? 0) + 18;
      }
      const last = entry.holds.at(-1)!.y;
      const words = t.holds.map((id) => holdHint(name(id))).join(" ");
      const arrow = zone.entry || zone.arrive.length > 0;
      const line: Point[] = arrow ? [[zone.hx, last], [zone.hx, lineY + 3]] : [[zone.hx, last], [zone.hx, lineY], [x0 - 11, lineY]];
      const label: Label = arrow
        ? { x: zone.hx + 6, y: (lineY + entry.holds[0].y) / 2, text: HAND_LABEL, align: "start", hint: words }
        : { x: (zone.hx + x0 - 11) / 2, y: lineY, text: HAND_LABEL, hint: words };
      entry.spine = { line, head: arrow ? { x: zone.hx, y: lineY + 3, dir: "up" } : { x: x0 - 11, y: lineY, dir: "right" }, label };
      polylines.push({ id: "holds", points: line });
      board.addRuns(runsOf("holds", line));
      hints.set("holds", words);
      const w = labelW(HAND_LABEL, measure);
      board.fix({ id: "spine", kind: "label", text: HAND_LABEL, x: label.align === "start" ? label.x : label.x - w / 2, y: label.y - LABEL_H / 2, w, h: LABEL_H }, ["holds"]);
    }
  }
  // Up to here every box stands where the line puts it: if two meet, the line does not fit.
  const fits = headsFit && board.clashes.length === 0;

  const exits: ExitLeg[] = [];
  const unplaced = placeExits(t, { at, lineY, width: opts.width, measure, board, routes, hints, polylines, chips, exits });

  // The words on the arcs, each along its own run where it is clear: shallow ones first.
  const deepest = () => Math.max(lineY + 24, ...board.boxes.map((b) => b.y + b.h), ...board.runs.filter((r) => r.a[1] > lineY && r.b[1] > lineY).map((r) => Math.max(r.a[1], r.b[1])));
  // Rows under everything, a box `w` wide kept inside the width.
  function* rowsBelow(xFrom: number, xTo: number, prefer: number, w: number): Generator<Pt> {
    const top = deepest() + 6;
    const lo = Math.max(4, Math.min(xFrom, opts.width - w - 4));
    const hi = Math.max(lo, Math.min(xTo, opts.width - w - 4));
    for (let k = 0; k < 8; k++) yield* along(prefer, lo, hi, top + k * ROW);
  }
  const order = [...arcs].sort((p, q) => (p.side === q.side ? 0 : p.side === "over" ? -1 : 1));
  for (const a of order) {
    if (a.id.startsWith("track:")) continue;
    const c = t.connectors.get(a.connectorIds[0])!;
    const w = labelW(c.name, measure);
    const xl = Math.min(a.line[1][0], a.line[2][0]);
    const xr = Math.max(a.line[1][0], a.line[2][0]);
    const y = a.line[1][1];
    const mid = (xl + xr) / 2;
    const box = { id: `arc:${a.id}`, kind: "label" as const, text: c.name };
    // On its run on one line; else on two; else on one line across its run's corners; under the
    // line, else in a row below everything.
    const split = twoLines(c.name, "label", measure);
    const w2 = split.width + LABEL_PAD;
    const one = board.tryPlace({ ...box, w, h: LABEL_H }, along(mid - w / 2, xl + 4, xr - 4 - w, y - LABEL_H / 2), [a.id]);
    const two = one || split.lines.length < 2 ? undefined : board.tryPlace({ ...box, w: w2, h: LABEL2_H }, along(mid - w2 / 2, xl + 4, xr - 4 - w2, y - LABEL2_H / 2), [a.id]);
    const wide = one || two ? undefined : board.tryPlace({ ...box, w, h: LABEL_H }, [[mid - w / 2, y - LABEL_H / 2]], [a.id]);
    const placed =
      one ??
      two ??
      wide ??
      board.place(
        { ...box, w, h: LABEL_H },
        (function* () {
          if (a.side === "under") yield* rowsBelow(xl - w / 2, xr, mid - w / 2, w);
          else yield [Math.max(4, mid - w / 2), y - LABEL_H / 2] as Pt;
        })(),
        [a.id],
      );
    a.labels.push({ x: placed.x + placed.w / 2, y: placed.y + placed.h / 2, text: c.name, lines: two ? split.lines : undefined, back: a.back, connectorId: c.id });
  }
  // A track's drops say their outcomes under it, neighbours saying the same once between them;
  // its own words ("↩ Build · 4 loops") right of where it ends, else where they are clear.
  for (const tr of tracks) {
    const groups: { x: number; connectors: LineConnector[] }[] = [];
    for (const d of tr.drops) {
      const g = groups.at(-1);
      if (g && g.connectors.at(-1)!.name === d.connector.name) {
        g.connectors.push(d.connector);
        g.x = (g.x * (g.connectors.length - 1) + d.x) / g.connectors.length;
      } else groups.push({ x: d.x, connectors: [d.connector] });
    }
    groups.forEach((g, k) => {
      const text = g.connectors[0].name;
      const w = labelW(text, measure);
      const placed = board.place(
        { id: `drop:${tr.target}:${k}`, kind: "label", text, w, h: LABEL_H },
        (function* () {
          yield* along(g.x - w / 2, g.x - w / 2 - 40, g.x - w / 2 + 40, tr.y + 6, 4);
          yield* rowsBelow(g.x - w / 2 - 60, g.x - w / 2 + 60, g.x - w / 2, w);
        })(),
        [tr.arc.id, ...g.connectors.map((c) => `drop:${c.id}`)],
      );
      tr.arc.labels.push({ x: placed.x + w / 2, y: placed.y + LABEL_H / 2, text, back: true, connectorId: g.connectors.length === 1 ? g.connectors[0].id : undefined, hint: outcomesHint(g.connectors, name) });
    });
    const text = `↩ ${t.steps.get(tr.target)?.name ?? "a Step"} · ${tr.drops.length} loops`;
    const w = measure(text, "label") + LABEL_PAD;
    const placed = board.place(
      { id: `track:${tr.target}`, kind: "label", text, w, h: LABEL_H },
      (function* () {
        yield [tr.xe + 8, tr.y - LABEL_H / 2] as Pt;
        yield [tr.xe + 8, tr.y + 6] as Pt;
        yield [tr.xl - 8 - w, tr.y - LABEL_H / 2] as Pt;
        yield* along(tr.xe - w, tr.xl, tr.xe - w, tr.y + 6, 8);
        yield* rowsBelow(tr.xl, tr.xe + 8, tr.xe + 8, w);
      })(),
      [tr.arc.id],
    );
    tr.arc.labels.push({ x: placed.x, y: placed.y + LABEL_H / 2, text, back: true, align: "start" });
  }

  // Under everything on the line: the chips of main Steps (Connectors into the branch, and exits
  // whose legs could not be drawn clear).
  for (const c of [...t.chips.filter((c) => at.has(c.stepId) && t.main.includes(c.stepId)), ...unplaced]) {
    const w = chipW(c.text, measure);
    const x = at.get(c.stepId)!.x;
    const placed = board.place({ id: `chip:${c.connector.id}`, kind: "chip", text: c.text, w, h: CHIP_H }, rowsBelow(x - w / 2 - 80, x - w / 2 + 80, x - w / 2, w));
    chips.push({ kind: c.kind, stepId: c.stepId, x: placed.x + w / 2, y: placed.y, text: c.text, align: "center", connectorId: c.connector.id, hint: c.hint });
    if (c.kind === "exit") routes.set(c.connector.id, chipRoute("exit", { x, y: lineY }, { x: placed.x + w / 2, y: placed.y + CHIP_H / 2 }));
  }
  let bottom = deepest();

  let branch: Horizontal["branch"];
  const xd = xs[n - 1];
  if (!opts.noBranch && t.rows.length > 0) {
    const labelY = bottom + 20;
    const stations: BranchStation[] = [];
    const lines: Polyline[] = [];
    const loops: DrawnArc[] = [];
    const labels: Label[] = [];
    let y = labelY + 64;
    let rightEdge = xd - (opts.branchGap ?? 240);
    const rowSp = Math.max(180, Math.min(340, sp * 1.7));
    const rowYs: number[] = [];
    let extra = 0;
    const widthOf = (id: string) => opts.labelWidth?.(id) ?? nameLine(t.steps.get(id), measure);
    t.rows.forEach((row, r) => {
      if (r > 0) y += ROW_GAP + extra + t.rows[r - 1].loops.reduce((m, l) => Math.max(m, l.depth), 0) * 20;
      extra = 0;
      rowYs.push(y);
      const k = row.stations.length;
      // Each row ends left of where the row above begins, so their names and chips stay clear.
      // Its last Step's name line (and tokens) must end short of where the row turns into Done.
      const turn = xd - 60 * r;
      // Where that leaves no room on the left, the row ends nearer its turn, then its Steps stand
      // only as far apart as their names need; never past the turn.
      const hard = turn - (widthOf(row.stations[k - 1]) + 34);
      const lay = (end: number, apart: number) => {
        const out: number[] = new Array(k);
        out[k - 1] = Math.round(end);
        for (let i = k - 2; i >= 0; i--) out[i] = Math.round(out[i + 1] - Math.max(apart, widthOf(row.stations[i]) + 24));
        return out;
      };
      const leftmost = margin + 20;
      let xsRow = lay(Math.min(rightEdge, hard), rowSp);
      if (xsRow[0] < leftmost) xsRow = lay(hard, rowSp);
      if (xsRow[0] < leftmost) xsRow = lay(hard, 120);
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
        labels.push({ x: (last + j - 30) / 2, y, text: row.exit.name, connectorId: row.exit.id });
        const tail = r === 0 ? `H${j - 30} Q${j} ${y} ${j} ${y - 30} V${lineY}` : `H${j - 30} Q${j} ${y} ${j} ${y - 30} V${rowYs[r - 1] + 30} Q${j} ${rowYs[r - 1]} ${j + 30} ${rowYs[r - 1]} H${xd - 30} Q${xd} ${rowYs[0]} ${xd} ${rowYs[0] - 30} V${lineY}`;
        routes.set(row.exit.id, `M${last} ${y} ${tail}`);
      } else if (k > 1) {
        lines.push({ id: `row:${r}`, points: [[first, y], [last, y]] });
      }
      for (const l of row.loops) {
        const yl = y + 20 * l.depth;
        const xl = xsRow[l.lo] + LEG0;
        const xr = xsRow[l.hi] - LEG0;
        loops.push({ id: l.connector.id, side: "under", back: true, connectorIds: [l.connector.id], line: [[xr, y + 6], [xr, yl], [xl, yl], [xl, y + 6]], arrow: { x: xl, y: y + 6, dir: "up" }, labels: [] });
        routes.set(l.connector.id, `M${xsRow[l.hi]} ${y} L${xr} ${y + 6} V${yl} H${xl} V${y + 6} L${xsRow[l.lo]} ${y}`);
      }
    });
    for (const l of loops) lines.push({ id: l.id, points: l.line });
    for (const l of lines) board.addRuns(runsOf(l.id, l.points));
    for (const s of stations) board.obstacle("station", { x: s.x - 7, y: s.y - 7, w: 14, h: 14 });
    // The names of the branch's Steps over their stations, the words on its rows: where they stand.
    for (const s of stations) board.fix({ id: `name:${s.id}`, kind: "name", text: name(s.id), x: s.x - 6, y: s.y - NAME_TOP - TOKEN_HALO, w: widthOf(s.id), h: NAME_H + 2 * TOKEN_HALO });
    labels.forEach((l, i) => {
      const w = labelW(l.text, measure);
      const row = stations.find((s) => s.y === l.y)?.row ?? 0;
      board.fix({ id: `branch:${i}`, kind: "label", text: l.text, x: l.x - w / 2, y: l.y - LABEL_H / 2, w, h: LABEL_H }, [`row:${row}`]);
    });
    for (const a of loops) {
      const c = t.connectors.get(a.connectorIds[0])!;
      const w = labelW(c.name, measure);
      const [xl, xr, yl] = [a.line[2][0], a.line[1][0], a.line[1][1]];
      const placed = board.place({ id: `loop:${a.id}`, kind: "label", text: c.name, w, h: LABEL_H }, (function* () {
        yield* along((xl + xr) / 2 - w / 2, xl + 4, xr - 4 - w, yl - LABEL_H / 2);
        yield* along((xl + xr) / 2 - w / 2, xl - w, xr, yl + 4);
      })(), [a.id]);
      a.labels.push({ x: placed.x + w / 2, y: placed.y + LABEL_H / 2, text: c.name, back: true, connectorId: c.id });
    }
    // A branch Step's other Connectors in words, those into or out of another Workflow among them:
    // left of its row's first Step, else under it.
    stations.forEach((s) => {
      const first = !stations.some((o) => o.row === s.row && o.x < s.x);
      [...t.chips, ...t.exits, ...t.entries]
        .filter((c) => c.stepId === s.id)
        .forEach((c, m) => {
          const w = chipW(c.text, measure);
          const placed = board.place(
            { id: `chip:${c.connector.id}`, kind: "chip", text: c.text, w, h: CHIP_H },
            (function* () {
              if (first) yield [s.x - 14 - w, s.y - 9 + m * 22] as Pt;
              for (let k = 0; k < 6; k++) yield [s.x + 8, s.y + 10 + (m + k) * 22] as Pt;
              for (let k = 0; k < 6; k++) yield [s.x - w - 8, s.y + 10 + (m + k) * 22] as Pt;
            })(),
          );
          chips.push({ kind: c.kind, stepId: s.id, x: placed.x, y: placed.y, text: c.text, align: "left", connectorId: c.connector.id, hint: c.hint });
          if (c.kind !== "chip") routes.set(c.connector.id, chipRoute(c.kind, s, { x: placed.x + w / 2, y: placed.y + CHIP_H / 2 }));
        });
    });
    const leftmost = Math.min(...stations.map((s) => s.x));
    const titleText = opts.branchLabel ?? AFTER_BRANCH;
    const title = board.place({ id: "branch", kind: "note", text: titleText, w: measure(titleText, "label"), h: 16 }, (function* () {
      yield [leftmost - 6, labelY] as Pt;
      for (let k = 1; k < 4; k++) yield [leftmost - 6, labelY - k * 10] as Pt;
    })());
    branch = { label: { x: title.x, y: title.y }, stations, lines, loops, labels };
    polylines.push(...lines);
    for (const l of loops) hints.set(l.id, outcomesHint(connectorsOf(l.connectorIds), name));
    t.rows.forEach((row, r) => hints.set(`row:${r}`, outcomesHint([...row.segments.map((s) => s.connector), ...(row.exit ? [row.exit] : [])], name)));
    bottom = deepest();
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

  return { width: opts.width, height: Math.ceil(bottom + 8), density, at, lineY, headY, columnY, heads, main, segmentLabels, arcs, branch, chips, exits, entry, routes, polylines, hints, boxes: board.boxes, clashes: board.clashes, fits };
}

/**
 * The way a token goes by a chip, square-cornered: an exit down (or up) from its Step's station
 * to the chip's row, then along it into the chip; an entry out of the chip along its row, then
 * into the station.
 */
function chipRoute(kind: "exit" | "entry", station: { x: number; y: number }, chip: { x: number; y: number }): string {
  return kind === "exit" ? `M${station.x} ${station.y} V${chip.y} H${chip.x}` : `M${chip.x} ${chip.y} H${station.x} V${station.y}`;
}

type Drawing = {
  board: Board;
  routes: Map<string, string>;
};

/**
 * The marks over the heads of the main Steps Tasks reach from another Workflow, where the entry
 * arrow does not lead in: "from Triage · bug ↓", stacked over the start's where both stand at one
 * Step. Each entry's route comes down from its mark into the station.
 */
function placeArrivals(
  t: LineTopology,
  d: Drawing & { choices: HeadChoice[]; heads: Head[]; xs: number[]; lineY: number; arriving: ReadonlySet<string>; name: (id: string | null) => string },
): NonNullable<NonNullable<Horizontal["entry"]>["arrivals"]> {
  const out: NonNullable<NonNullable<Horizontal["entry"]>["arrivals"]> = [];
  const at = byStep(t.entries.filter((e) => !d.arriving.has(e.connector.id)));
  d.choices.forEach((c, i) => {
    let top = d.heads[i].top;
    for (const m of c.marks) {
      top -= m.h + 4;
      if (m.kind !== "entry") continue;
      const x = d.xs[i];
      const id = t.main[i];
      const left = m.side === "right" ? x + MARK_TIP - m.w : x - MARK_TIP;
      const here = at.get(id) ?? [];
      d.board.fix({ id: `arrival:${id}`, kind: "mark", text: here.map((e) => e.text).join(" "), x: left, y: top, w: m.w, h: m.h });
      out.push({ stepId: id, x, left, top, y: top + m.h / 2, arrow: m.side, lines: m.lines, hint: outcomesHint(here.map((e) => e.connector), d.name), connectorIds: here.map((e) => e.connector.id) });
      for (const e of here) d.routes.set(e.connector.id, `M${x} ${top + m.h} V${d.lineY}`);
    }
  });
  return out;
}

/**
 * A main Step's exits into other Workflows: chips one under another, each at the end of a short
 * leg down from the Step, where the legs cross no line and the chips meet nothing and stay inside
 * the width. A Step whose exits cannot all stand so has them all returned, to go under everything
 * as any Connector the line cannot route.
 */
function placeExits(
  t: LineTopology,
  d: Drawing & {
    at: ReadonlyMap<string, { x: number; y: number }>;
    lineY: number;
    width: number;
    measure: Measure;
    hints: Map<string, string>;
    polylines: Polyline[];
    chips: Horizontal["chips"];
    exits: ExitLeg[];
  },
): Crossing[] {
  const unplaced: Crossing[] = [];
  const { board, lineY } = d;
  const out = byStep(t.exits);
  for (const id of t.main) {
    const list = out.get(id);
    if (!list) continue;
    const x = d.at.get(id)!.x;
    const comb = list.map((e, k) => {
      const cy = lineY + EXIT_TOP + k * (CHIP_H + 6);
      const leg: Point[] = [[x, lineY + STATION_R], [x, cy], [x + EXIT_TICK, cy]];
      const w = chipW(e.text, d.measure);
      return { e, cy, leg, box: { id: `chip:${e.connector.id}`, kind: "chip" as const, text: e.text, x: x + EXIT_TICK, y: cy - CHIP_H / 2, w, h: CHIP_H } };
    });
    // A leg checked from just below its station, so a line standing there (a drop) still counts.
    const legClear = (leg: Point[]) => {
      const own: Seg[] = [[[leg[0][0], leg[0][1] + 1], leg[1]], [leg[1], leg[2]]];
      return own.every((g) => board.runs.every((r) => !meet(g, [r.a, r.b])) && [...board.boxes, ...board.obstacles.map((o) => o.box)].every((b) => !cuts({ a: g[0], b: g[1] }, b)));
    };
    if (!comb.every((c) => board.clear(c.box) && c.box.x + c.box.w <= d.width && legClear(c.leg))) {
      unplaced.push(...list);
      continue;
    }
    for (const c of comb) {
      const pid = `exit:${c.e.connector.id}`;
      board.addRuns(runsOf(pid, c.leg));
      board.fix(c.box, [pid]);
      d.polylines.push({ id: pid, points: c.leg });
      d.exits.push({ connectorId: c.e.connector.id, stepId: id, points: c.leg });
      d.hints.set(pid, c.e.hint);
      d.routes.set(c.e.connector.id, `M${x} ${lineY} V${c.cy} H${x + EXIT_TICK + c.box.w / 2}`);
      d.chips.push({ kind: "exit", stepId: id, x: c.box.x, y: c.box.y, text: c.e.text, align: "left", connectorId: c.e.connector.id, hint: c.e.hint });
    }
  }
  return unplaced;
}

/** A route between two stations with no Connector between them (a move by hand): straight. */
export function handRoute(h: Horizontal, from: string, to: string): string | undefined {
  const [a, b] = [h.at.get(from), h.at.get(to)];
  if (!a || !b) return undefined;
  return `M${a.x} ${a.y} L${b.x} ${b.y}`;
}

/** A Task moved by hand off the line, into a Step it does not draw (another Workflow's): down from its station, as an exit's leg runs. */
export function leaveRoute(h: Horizontal, from: string): string | undefined {
  const a = h.at.get(from);
  return a && `M${a.x} ${a.y} V${a.y + EXIT_TOP}`;
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

/** Where the rail runs when no loop back nests: its x in the line's box. */
const VERTICAL_RAIL = 32;
/** The room kept clear at the box's left edge: no bracket of a loop back runs nearer. */
export const VERTICAL_GUTTER = 12;
/** How far apart nested brackets run, and how far the innermost stands off the rail. */
const BRACKET_STEP = 7;
export const BRACKET_OFF = 8;

/** A loop back's bracket x, for its nesting depth, beside a rail at `rail`. */
export function bracketX(rail: number, depth: number): number {
  return rail - BRACKET_OFF - depth * BRACKET_STEP;
}

/**
 * The rail's x for a line: far enough right that its most nested bracket keeps the gutter, so a
 * Workflow with many loops into one Step moves the rail over rather than running into the edge.
 */
export function railX(t: LineTopology): number {
  const deepest = Math.max(0, ...brackets(t).map((b) => b.depth));
  return Math.max(VERTICAL_RAIL, VERTICAL_GUTTER + BRACKET_OFF + deepest * BRACKET_STEP);
}
