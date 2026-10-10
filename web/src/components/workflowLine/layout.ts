import { branchSkills, DONE_STATION, sideSteps, type LineConnector, type LineStep, type LineWorkflow } from "./model";
import { outcomeHint } from "./words";

/*
 * What the Workflow line draws, without a DOM, so tests can prove the drawing rules (the vertical
 * final design, vf-1 … vf-10):
 * - one main line of the Steps in Workflow order, ending on Done; a pair of neighbours joined by a
 *   Connector is a solid segment named by its outcome, a pair with none is dotted ("by hand" where
 *   the first has no outcome on; a gap its outcomes lead around says nothing);
 * - the rail runs from the Step new Tasks start at (`railOf`); the Steps before it, the breakdown
 *   Step and the holds no Connector joins stand in "Also starts here" beside the start;
 * - the Steps where Darkory files a Parent's own Subtasks (acceptance, retro, skill-review) are the
 *   rows of the quiet line "When a Parent ends", which runs into a Done of its own;
 * - a Connector back up the rail, or past a Step, is a track in a lane beside it; the Connectors
 *   into one Step share one track, and lanes are picked for the fewest crossings (`tracks`);
 * - a Connector no rail or track carries is a chip by its Step ("fail → Build"); one between a drawn
 *   Step and another Workflow's (`LineWorkflow.drawn`, ADR 0019) is an exit by the Step it leaves
 *   ("bug → Bugs › Investigate") or an entry on the Step it reaches ("from Triage · bug"); no
 *   Connector touching a drawn Step is dropped.
 * `lineTopology` decides all of that in station order; `rails.ts` and `Vertical.tsx` draw it.
 */

/**
 * A neighbour pair on the main line: solid along its Connector. Where none joins them it is
 * dotted: "by hand" (`hand`) when the earlier Step has no outcome forward, so a human moves its Tasks
 * on; a bare gap when its outcomes all lead elsewhere (a skip, Done, the branch), so nothing moves
 * along it and a Task reaches the right Step only by being filed there (or moved there by hand).
 */
export type Segment = { from: string; to: string; connector?: LineConnector; hand?: boolean };

/** A loop back inside a branch row. Indexes are the row's. */
export type RowLoop = { connector: LineConnector; lo: number; hi: number };

/** One row of the branch: Steps chained by their Connectors, running into Done by `exit`. */
export type BranchRow = {
  stations: string[];
  segments: { lo: number; connector: LineConnector }[];
  loops: RowLoop[];
  exit?: LineConnector;
};

/**
 * A Connector shown in words by its Step, with what it says on hover: a `chip` no rail or track
 * carries ("fail → Build"); or one between a drawn Step and a Step of another Workflow (ADR 0019),
 * an `exit` by the drawn Step it leaves ("bug → Bugs › Investigate") or an `entry` on the drawn
 * Step it reaches ("from Triage · bug").
 */
export type Chip = { kind: "chip" | "exit" | "entry"; stepId: string; connector: LineConnector; text: string; hint: string };

/** An exit or an entry: a Connector crossing into or out of the Workflow drawn. */
export type Crossing = Chip & { kind: "exit" | "entry" };

/**
 * A Step's Connectors in words, as the line stands them beside it: those no rail or track carries,
 * its exits, then its entries.
 */
export function chipsAt(t: Pick<LineTopology, "chips" | "exits" | "entries">, stepId: string): Chip[] {
  return [...t.chips, ...t.exits, ...t.entries].filter((c) => c.stepId === stepId);
}

export type LineTopology = {
  /** Main-line station ids in order, Done last. */
  main: string[];
  /** Where new Tasks start (on the main line), when the Workflow has a Step. */
  start?: string;
  /**
   * Every Step drawn is a branch Step as `sideSteps` reads it (a Workflow of a Parent's own
   * Subtasks, the Retrospective): they are the main line, which a Parent's end starts, and there
   * is no quiet row. A branch Step a worked Step leads into is worked, so its Workflow is not this.
   */
  afterOnly: boolean;
  /** The breakdown Step on the branch "Break down", off the line before the start Step. */
  before?: string;
  /** The holds no Connector joins, parked off the line by the entry, in Workflow order. */
  holds: string[];
  /** Every Connector the line draws, by id. */
  connectors: Map<string, LineConnector>;
  steps: Map<string, LineStep>;
  segments: Segment[];
  rows: BranchRow[];
  chips: Chip[];
  /** Connectors out of a drawn Step into another Workflow's, in Workflow order. */
  exits: Crossing[];
  /** Connectors into a drawn Step from another Workflow's, by the Step they reach. */
  entries: Crossing[];
  /** The Steps of other Workflows the line names, as "Bugs › Investigate". */
  others: Map<string, string>;
};

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

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
  // Every drawn Step is a branch Step as `sideSteps` reads it (one a worked Step leads into is worked),
  // or the Project's start, when it has nothing but branch Steps.
  const afterOnly = ordered.length > 0 && ordered.every((s) => sides.after.has(s.id) || (s.id === sides.start && !!s.skill && branchSkills.includes(s.skill.name)));
  const sideIds = new Set(afterOnly ? [] : [...sides.after].filter((id) => steps.has(id)));
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
  const segments: Segment[] = main.slice(0, -1).map((from, i) => ({ from, to: main[i + 1] }));
  const chips: Chip[] = [];
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
    const a = index.get(c.from)!;
    if (index.get(to) === a + 1 && !segments[a].connector) segments[a].connector = c;
  }
  // A Step with an outcome that leads on (to a later Step, Done, or off the line) moves its Tasks
  // along it; one with none, or only loops back, has its Tasks moved on by hand.
  const leadsOn = new Set([...connectors.filter((c) => c.to === null || !index.has(c.to) || index.get(c.to)! > index.get(c.from)!).map((c) => c.from), ...exits.map((e) => e.stepId)]);
  for (const s of segments) if (!s.connector) s.hand = !leadsOn.has(s.from);

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
      else if (b < a) row.loops.push({ connector: c, lo: b, hi: a });
      else chip(c);
    }
    const last = stations.at(-1)!;
    for (const c of sideOut.filter((o) => at.has(o.from))) {
      if (c.to === null && c.from === last && !row.exit) row.exit = c;
      else chip(c);
    }
    return row;
  });

  return { main, start, afterOnly, before, holds, connectors: new Map(connectors.map((c) => [c.id, c])), steps, segments, rows, chips, exits, entries, others };
}

/* ------------------------------------------------------------------------------------------ */
/* The line down the page: the rail from Start, returns as tracks in lanes beside it.         */
/* ------------------------------------------------------------------------------------------ */

/**
 * The main line split where the rail begins: the stations before the start Step stand in "Also
 * starts here" beside it (a Backlog that only leads into Triage), the rail runs from the start
 * Step (its first station, filled) to Done. With no start Step on the line, the rail is all of it.
 */
export function railOf(t: Pick<LineTopology, "main" | "start">): { lead: string[]; rail: string[] } {
  const at = t.start === undefined ? -1 : t.main.indexOf(t.start);
  return at <= 0 ? { lead: [], rail: [...t.main] } : { lead: t.main.slice(0, at), rail: t.main.slice(at) };
}

/** A stub's height at its station: just above its centre, at it, or just below. */
export type StubHeight = -1 | 0 | 1;

/** One end of a track: a stub from the station at `at` (an index into the line's stations), at `dy`. */
export type TrackEnd = { at: number; dy: StubHeight; connectors: LineConnector[] };

/**
 * The Connectors into one Step that the rail cannot carry (returns, and skips over a Step), drawn
 * as one track in a lane beside the rail: a stub from each Step they leave, one into the Step they
 * reach with its arrowhead. Lane 0 is the one nearest the rail.
 */
export type LaneTrack = { target: string; to: number; lo: number; hi: number; connectors: LineConnector[]; ends: TrackEnd[]; lane: number };

/**
 * A line's tracks, one per Step reached, from the Connectors between its stations (`stations`, Done
 * last) that are not a segment of the rail (`along`). Lanes and stub heights are picked for the
 * fewest crossings (`trackCrossings`); among equals a track nested in another runs inside it, and
 * of two that overlap the longer runs inside.
 */
export function laneTracks(stations: readonly string[], connectors: readonly LineConnector[], along: ReadonlySet<string>): LaneTrack[] {
  const index = new Map(stations.map((id, i) => [id, i]));
  const by = new Map<string, LineConnector[]>();
  for (const c of connectors) {
    if (along.has(c.id) || c.to === null || !index.has(c.from) || !index.has(c.to) || c.from === c.to) continue;
    by.set(c.to, [...(by.get(c.to) ?? []), c]);
  }
  const list: LaneTrack[] = [...by].map(([target, cs]) => {
    const to = index.get(target)!;
    const from = new Map<number, LineConnector[]>();
    for (const c of cs) from.set(index.get(c.from)!, [...(from.get(index.get(c.from)!) ?? []), c]);
    const ends: TrackEnd[] = [{ at: to, dy: -1, connectors: [] }, ...[...from].sort((a, b) => a[0] - b[0]).map(([at, connectors]): TrackEnd => ({ at, dy: 1, connectors }))];
    const ats = ends.map((e) => e.at);
    return { target, to, lo: Math.min(...ats), hi: Math.max(...ats), connectors: cs, ends, lane: 0 };
  });
  list.sort((a, b) => a.to - b.to);
  if (list.length === 0) return list;

  // Which ends could meet another track's (on a row another track ends at): their heights are worth trying both ways.
  const rows = new Map<number, number>();
  for (const k of list) for (const r of new Set([k.lo, k.hi, ...k.ends.map((e) => e.at)])) rows.set(r, (rows.get(r) ?? 0) + 1);
  const free = list.flatMap((k) => k.ends.filter((e) => (rows.get(e.at) ?? 0) > 1));
  const preference = (lanes: number[]) => {
    let n = 0;
    for (let a = 0; a < list.length; a++) {
      for (let b = 0; b < list.length; b++) {
        if (a === b || lanes[a] >= lanes[b]) continue;
        const [inner, outer] = [list[a], list[b]];
        const nested = outer.lo <= inner.lo && inner.hi <= outer.hi;
        const holds = inner.lo <= outer.lo && outer.hi <= inner.hi;
        const overlap = inner.lo < outer.hi && outer.lo < inner.hi;
        // Inside: the nested one; of two overlapping, the longer.
        if (holds && !nested) n++;
        else if (!nested && !holds && overlap && inner.hi - inner.lo < outer.hi - outer.lo) n++;
      }
    }
    return n;
  };
  let best: { cost: number; pref: number; lanes: number[]; dys: StubHeight[] } | undefined;
  const tryLanes = (lanes: number[]) => {
    list.forEach((k, i) => (k.lane = lanes[i]));
    const dys = pickHeights(list, free, best?.cost);
    const cost = trackCrossings(list);
    const pref = preference(lanes);
    if (!best || cost < best.cost || (cost === best.cost && pref < best.pref)) best = { cost, pref, lanes, dys };
  };
  if (list.length <= EVERY_ORDER) {
    for (const p of permutations(list.length)) tryLanes(p);
  } else {
    // Many tracks: nested ones inside, then swap two lanes at a time while that helps, the
    // stubs' heights held; then the heights picked again for the lanes kept.
    const order = list.map((_, i) => i).sort((a, b) => list[a].hi - list[a].lo - (list[b].hi - list[b].lo));
    tryLanes(order.reduce<number[]>((lanes, i, rank) => ((lanes[i] = rank), lanes), []));
    const score = (lanes: number[]) => {
      list.forEach((k, i) => (k.lane = lanes[i]));
      return { cost: trackCrossings(list, best!.cost + 1), pref: preference(lanes) };
    };
    free.forEach((e, i) => (e.dy = best!.dys[i]));
    let lanes = best!.lanes;
    let now = score(lanes);
    for (let better = true; better; ) {
      better = false;
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const next = [...lanes];
          [next[a], next[b]] = [next[b], next[a]];
          const s = score(next);
          if (s.cost < now.cost || (s.cost === now.cost && s.pref < now.pref)) [lanes, now, better] = [next, s, true];
        }
      }
    }
    if (lanes !== best!.lanes) tryLanes(lanes);
  }
  list.forEach((k, i) => (k.lane = best!.lanes[i]));
  free.forEach((e, i) => (e.dy = best!.dys[i]));
  return list;
}

/** Up to this many tracks every order of lanes is tried; past it, the nested order improved by swaps. */
const EVERY_ORDER = 4;
/** Up to this many ends that could meet another track's every set of heights is tried; past it, one end at a time. */
const EVERY_HEIGHT = 7;

/**
 * The heights of the ends that could meet another track's, tried every way (or improved one at a
 * time when many), the fewest crossings kept. A set of heights no better than `bound` (the best
 * lanes so far) is given up as soon as it is counted that high.
 */
function pickHeights(list: LaneTrack[], free: TrackEnd[], bound = Infinity): StubHeight[] {
  const heights: StubHeight[] = [-1, 0, 1];
  const set = (dys: StubHeight[]) => free.forEach((e, i) => (e.dy = dys[i]));
  let best = free.map((e): StubHeight => (e.connectors.length === 0 ? -1 : 1));
  set(best);
  let cost = trackCrossings(list);
  if (free.length <= EVERY_HEIGHT) {
    for (let code = 0; code < 3 ** free.length && cost > 0; code++) {
      const dys = free.map((_, i) => heights[Math.floor(code / 3 ** i) % 3]);
      set(dys);
      const c = trackCrossings(list, Math.min(cost, bound + 1));
      if (c < cost) [best, cost] = [dys, c];
    }
  } else {
    // One end at a time from each start (the defaults, every end at one height, the defaults
    // turned over), the best kept: from one start alone the search sticks where moving any one
    // end makes it no better but moving two would.
    const starts: StubHeight[][] = [best, ...heights.map((h) => free.map(() => h)), best.map((d): StubHeight => (d === -1 ? 1 : -1))];
    for (const start of starts) {
      let at = start;
      set(at);
      let now = trackCrossings(list);
      for (let changed = true; changed && now > 0; ) {
        changed = false;
        for (let i = 0; i < free.length; i++) {
          for (const h of heights) {
            const dys = at.map((d, j) => (j === i ? h : d));
            set(dys);
            const c = trackCrossings(list, now);
            if (c < now) [at, now, changed] = [dys, c, true];
          }
        }
      }
      if (now < cost) [best, cost] = [at, now];
      if (cost === 0) break;
    }
  }
  set(best);
  return best;
}

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  return permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)]));
}

/**
 * Where tracks cross: a stub running out past a track in a lane nearer the rail, at a height
 * inside that track's run; or two stubs of different tracks at one station and one height.
 * Counting stops at `limit`: a search only needs to know a choice is no better.
 */
export function trackCrossings(list: readonly LaneTrack[], limit = Infinity): number {
  const key = (e: TrackEnd) => e.at * 3 + e.dy + 1;
  let n = 0;
  for (const a of list) {
    for (const b of list) {
      if (a === b) continue;
      let [top, bot] = [Infinity, -Infinity];
      for (const f of b.ends) [top, bot] = [Math.min(top, key(f)), Math.max(bot, key(f))];
      for (const e of a.ends) {
        const k = key(e);
        if (b.lane < a.lane && top <= k && k <= bot) n++;
        if (a.lane < b.lane && b.ends.some((f) => key(f) === k)) n++;
        if (n >= limit) return n;
      }
    }
  }
  return n;
}

/** The main rail's tracks: every Connector between two of its stations that is not one of its segments. */
export function tracks(t: LineTopology): LaneTrack[] {
  const { rail } = railOf(t);
  const along = new Set(t.segments.flatMap((s) => (s.connector ? [s.connector.id] : [])));
  return laneTracks(rail, [...t.connectors.values()], along);
}
