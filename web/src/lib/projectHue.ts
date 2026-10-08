/**
 * The hues a Project's mark takes, in OKLCH degrees: twelve around the wheel, red to pink, so no
 * two read alike. The theme sets only the mark's lightness and strength (--mark-l, --mark-c in
 * globals.css); the hue is the Project's in light and dark alike.
 */
export const markHues = [25, 55, 85, 115, 145, 175, 205, 235, 265, 295, 325, 355] as const;

/** A Project's hue, picked by its key (FNV-1a), so a Project keeps its colour wherever it shows. */
export function projectHue(key: string): number {
  let h = 0x811c9dc5;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return markHues[h % markHues.length];
}
