import type { Point } from "./layout";

/**
 * A drawn polyline as an SVG path: square corners rounded by `r`, and a diagonal run (the layout's
 * stand-in for a quarter turn) drawn as that turn: out of a horizontal run it bends down or up
 * into the vertical, out of a vertical one it bends into the horizontal.
 */
export function smooth(points: Point[], r = 7): string {
  if (points.length < 2) return "";
  let d = `M${points[0][0]} ${points[0][1]}`;
  let cursor: Point = points[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const diagonal = a[0] !== b[0] && a[1] !== b[1];
    if (diagonal) {
      const prev = points[i - 2];
      const fromHorizontal = prev ? prev[1] === a[1] : true;
      const c: Point = fromHorizontal ? [b[0], a[1]] : [a[0], b[1]];
      if (cursor !== a) d += ` L${a[0]} ${a[1]}`;
      d += ` Q${c[0]} ${c[1]} ${b[0]} ${b[1]}`;
      cursor = b;
      continue;
    }
    const next = points[i + 1];
    if (!next || (next[0] !== b[0] && next[1] !== b[1])) {
      d += ` L${b[0]} ${b[1]}`;
      cursor = b;
      continue;
    }
    // A square corner at b: stop short of it and turn on a quarter curve.
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(next[0] - b[0], next[1] - b[1]);
    const k = Math.min(r, l1 / 2, l2 / 2);
    const p: Point = [b[0] + ((a[0] - b[0]) / (l1 || 1)) * k, b[1] + ((a[1] - b[1]) / (l1 || 1)) * k];
    const q: Point = [b[0] + ((next[0] - b[0]) / (l2 || 1)) * k, b[1] + ((next[1] - b[1]) / (l2 || 1)) * k];
    d += ` L${p[0]} ${p[1]} Q${b[0]} ${b[1]} ${q[0]} ${q[1]}`;
    cursor = q;
  }
  return d;
}

/** An open arrowhead whose tip is at (x, y), pointing up into a station or down into one. */
export function arrowhead(x: number, y: number, dir: "up" | "down" | "left" | "right"): string {
  switch (dir) {
    case "up":
      return `M${x - 4} ${y + 7} L${x} ${y} L${x + 4} ${y + 7}`;
    case "down":
      return `M${x - 4} ${y - 7} L${x} ${y} L${x + 4} ${y - 7}`;
    case "left":
      return `M${x + 7} ${y - 4} L${x} ${y} L${x + 7} ${y + 4}`;
    case "right":
      return `M${x - 7} ${y - 4} L${x} ${y} L${x - 7} ${y + 4}`;
  }
}

export type Box = { x: number; y: number; w: number; h: number };

export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where a callout goes: of the places offered, the one covering the least of what it must not
 * cover (tokens, the chain), kept inside the band. Ties go to the earlier place.
 */
export function placeCallout(candidates: Box[], avoid: Box[], bounds: { w: number; h: number }): Box {
  let best: Box | undefined;
  let bestCost = Infinity;
  for (const c of candidates) {
    const box = { ...c, x: Math.max(8, Math.min(c.x, bounds.w - c.w - 8)), y: Math.max(4, Math.min(c.y, bounds.h - c.h - 4)) };
    const cost = avoid.reduce((n, a) => n + overlap(box, a), 0) + (box.x !== c.x || box.y !== c.y ? 1 : 0);
    if (cost < bestCost) {
      best = box;
      bestCost = cost;
    }
  }
  return best ?? { x: 8, y: 4, w: candidates[0]?.w ?? 0, h: candidates[0]?.h ?? 0 };
}
