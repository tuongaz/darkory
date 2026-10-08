/*
 * How wide the line's words run, so the layout can keep every word, chip and Step head clear of
 * the others without a DOM: each kind of text the line draws is one `Font`, and a `Measure` says
 * how many px a text takes in it. In a browser the line measures with a canvas in the page's own
 * fonts; elsewhere (tests) it estimates from Inter's advance widths, erring wide.
 */

export type Font =
  /** A label on a line (11px), measured semibold: a lit label turns semibold and must not outgrow its box. */
  | "label"
  /** A dashed chip (11px). */
  | "chip"
  /** "New Tasks start here" (11.5px medium). */
  | "entry"
  /** A Step's name over its station at bead density (12.5px semibold). */
  | "head"
  /** A Step's name over its station at token density (13.5px semibold). */
  | "headLarge"
  /** A Step's name alone, on a single Task's line or a folded one (13px semibold). */
  | "compact"
  /** A Skill's name under a bead head (10.5px mono). */
  | "skill"
  /** A Skill's name beside a token head's name (11px mono). */
  | "skillLarge"
  /** "3 Tasks", "1 today" (11px). */
  | "count"
  /** A branch Step's name (13px semibold). */
  | "side"
  /** Small words under a name: "hold · moved on by hand", "Break down" (11px). */
  | "note";

const FONTS: Record<Font, { size: number; weight: number; mono?: boolean }> = {
  label: { size: 11, weight: 600 },
  chip: { size: 11, weight: 400 },
  entry: { size: 11.5, weight: 500 },
  head: { size: 12.5, weight: 600 },
  headLarge: { size: 13.5, weight: 600 },
  compact: { size: 13, weight: 600 },
  skill: { size: 10.5, weight: 400, mono: true },
  skillLarge: { size: 11, weight: 400, mono: true },
  count: { size: 11, weight: 400 },
  side: { size: 13, weight: 600 },
  note: { size: 11, weight: 400 },
};

export type Measure = (text: string, font: Font) => number;

// Inter's advance widths in em at weight 400, by character, rounded up.
const NARROW = new Map<string, number>(
  Object.entries({
    " ": 0.28, i: 0.25, l: 0.25, j: 0.26, I: 0.28, t: 0.36, f: 0.35, r: 0.39, "·": 0.3, ".": 0.29, ",": 0.29, ":": 0.29, "'": 0.22,
    "-": 0.45, "(": 0.36, ")": 0.36, "/": 0.4, s: 0.53, c: 0.55, z: 0.53, k: 0.55, v: 0.55, x: 0.55, y: 0.55, a: 0.57, e: 0.58,
    m: 0.9, w: 0.82, M: 0.9, W: 1.0, "→": 1.0, "↩": 0.9, "↓": 0.7, "+": 0.62,
  }),
);

function emOf(ch: string): number {
  const n = NARROW.get(ch);
  if (n !== undefined) return n;
  if (ch >= "0" && ch <= "9") return 0.63;
  if (ch >= "A" && ch <= "Z") return 0.7;
  return 0.61;
}

/** Inter (or a mono) by its advance widths: a little wider than the browser draws it. */
export const estimate: Measure = (text, font) => {
  const f = FONTS[font];
  if (f.mono) return text.length * f.size * 0.62;
  let em = 0;
  for (const ch of text) em += emOf(ch);
  const bold = f.weight >= 600 ? 1.05 : f.weight >= 500 ? 1.025 : 1;
  return em * f.size * bold;
};

const SANS = `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

let shared: Measure | undefined | null = null;

/**
 * How wide the line's words run on this page: its own fonts through one canvas, or the estimate
 * where there is none. `fresh` asks again once the page's fonts have loaded.
 */
export function pageMeasure(fresh = false): Measure {
  if (shared === null || fresh) shared = canvasMeasure();
  return shared ?? estimate;
}

/** The page's own fonts, through a canvas; undefined where there is no canvas to ask (tests). */
export function canvasMeasure(): Measure | undefined {
  if (typeof document === "undefined" || typeof navigator === "undefined" || /jsdom/i.test(navigator.userAgent)) return undefined;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return undefined;
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${font}\u0000${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const f = FONTS[font];
    ctx.font = `${f.weight} ${f.size}px ${f.mono ? MONO : SANS}`;
    // A pixel to spare, so sub-pixel rounding never makes two words touch.
    const w = Math.ceil(ctx.measureText(text).width) + 1;
    cache.set(key, w);
    return w;
  };
}

/**
 * A text broken onto at most two lines at the space that makes its wider line narrowest; one line
 * when it has no space.
 */
export function twoLines(text: string, font: Font, measure: Measure): { lines: string[]; width: number } {
  const words = text.split(" ");
  if (words.length < 2) return { lines: [text], width: measure(text, font) };
  let best = { lines: [text], width: Infinity };
  for (let k = 1; k < words.length; k++) {
    const lines = [words.slice(0, k).join(" "), words.slice(k).join(" ")];
    const width = Math.max(...lines.map((l) => measure(l, font)));
    if (width < best.width) best = { lines, width };
  }
  return best;
}
