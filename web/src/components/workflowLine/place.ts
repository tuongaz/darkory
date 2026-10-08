/*
 * Where the line's words go so that none covers another, or a line it does not sit on. Every
 * word, chip and Step head is a box; the drawn lines are runs between points. A box is placed at
 * the first of the places offered to it that is clear; the line's promise is that no two boxes
 * meet (`overlaps`).
 */

export type Pt = [number, number];
export type Box = { x: number; y: number; w: number; h: number };

/** What a box is, for the proofs and the DOM (`data-box`). */
export type BoxKind = "head" | "mark" | "label" | "chip" | "entry" | "name" | "note";

export type Placed = Box & { id: string; kind: BoxKind; text: string };

/** A drawn run a box must not cover, unless the box belongs to it (`owner`). */
export type Run = { owner: string; a: Pt; b: Pt };

const EPS = 0.5;

/** Two boxes share more than a hair of area. */
export function meets(a: Box, b: Box): boolean {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS;
}

/** A run crosses into a box (Liang–Barsky on the box shrunk by a hair). */
export function cuts(r: { a: Pt; b: Pt }, box: Box): boolean {
  const [x0, y0] = r.a;
  const [dx, dy] = [r.b[0] - x0, r.b[1] - y0];
  const [xmin, xmax, ymin, ymax] = [box.x + EPS, box.x + box.w - EPS, box.y + EPS, box.y + box.h - EPS];
  if (xmin >= xmax || ymin >= ymax) return false;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, x0 - xmin) && clip(dx, xmax - x0) && clip(-dy, y0 - ymin) && clip(dy, ymax - y0) && t1 - t0 > 1e-6;
}

export function runsOf(owner: string, points: Pt[]): Run[] {
  const out: Run[] = [];
  for (let i = 0; i < points.length - 1; i++) out.push({ owner, a: points[i], b: points[i + 1] });
  return out;
}

/** The boxes placed so far and the runs drawn, asked whether a place is clear. */
export class Board {
  readonly boxes: Placed[] = [];
  readonly runs: Run[] = [];
  /** Boxes that met another box or a run when placed where they had to go. */
  readonly clashes: [string, string][] = [];

  /** Things drawn that are not words but no word may cover: the stations. */
  readonly obstacles: { id: string; box: Box }[] = [];

  addRuns(rs: Run[]) {
    this.runs.push(...rs);
  }

  obstacle(id: string, box: Box) {
    this.obstacles.push({ id, box });
  }

  /** What a box at this place would meet: boxes, stations, and runs not its own. */
  blockers(b: Box, own: readonly string[] = []): string[] {
    const out: string[] = [];
    for (const p of this.boxes) if (meets(p, b)) out.push(p.id);
    for (const o of this.obstacles) if (meets(o.box, b)) out.push(o.id);
    for (const r of this.runs) if (!own.includes(r.owner) && cuts(r, b)) out.push(r.owner);
    return out;
  }

  clear(b: Box, own: readonly string[] = []): boolean {
    for (const p of this.boxes) if (meets(p, b)) return false;
    for (const o of this.obstacles) if (meets(o.box, b)) return false;
    for (const r of this.runs) if (!own.includes(r.owner) && cuts(r, b)) return false;
    return true;
  }

  /** Put a box where it must go, recording what it meets. */
  fix(p: Placed, own: readonly string[] = []): Placed {
    for (const id of new Set(this.blockers(p, own))) this.clashes.push([p.id, id]);
    this.boxes.push(p);
    return p;
  }

  /** Put a box at the first clear place of those offered, if one is. */
  tryPlace(p: Omit<Placed, "x" | "y">, places: Iterable<Pt>, own: readonly string[] = []): Placed | undefined {
    for (const [x, y] of places) {
      const at = { ...p, x, y };
      if (this.clear(at, own)) {
        this.boxes.push(at);
        return at;
      }
    }
    return undefined;
  }

  /** Put a box at the first clear place of those offered; the first place when none is. */
  place(p: Omit<Placed, "x" | "y">, places: Iterable<Pt>, own: readonly string[] = []): Placed {
    let first: Placed | undefined;
    for (const [x, y] of places) {
      const at = { ...p, x, y };
      first ??= at;
      if (this.clear(at, own)) {
        this.boxes.push(at);
        return at;
      }
    }
    return this.fix(first ?? { ...p, x: 0, y: 0 }, own);
  }
}

/** Places along a run from `from` to `to` (left edges), nearest `prefer` first, in steps. */
export function* along(prefer: number, from: number, to: number, y: number, step = 6): Generator<Pt> {
  if (to < from) return;
  const p = Math.max(from, Math.min(to, prefer));
  yield [p, y];
  for (let d = step; p - d >= from || p + d <= to; d += step) {
    if (p - d >= from) yield [p - d, y];
    if (p + d <= to) yield [p + d, y];
  }
}

/** The pairs of boxes that meet: the line's promise is none. */
export function overlaps(boxes: readonly Placed[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (meets(boxes[i], boxes[j])) out.push([boxes[i].id, boxes[j].id]);
  return out;
}
