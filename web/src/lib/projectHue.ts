/**
 * The hues a Project's mark takes, in OKLCH degrees, by the index the Project stores as its
 * colour (0 red to 11 pink): twelve around the wheel, so no two read alike. The theme sets only
 * the mark's lightness and strength (--mark-l, --mark-c in globals.css); the hue is the Project's
 * in light and dark alike.
 */
export const markHues = [25, 55, 85, 115, 145, 175, 205, 235, 265, 295, 325, 355] as const;

/** What each hue is called where a person picks one. */
export const markNames = ["Red", "Orange", "Amber", "Lime", "Green", "Teal", "Cyan", "Sky", "Blue", "Violet", "Magenta", "Pink"] as const;

/** A stored colour as an index into the hues; one out of range wraps round the wheel. */
function index(color: number): number {
  const n = markHues.length;
  return ((Math.trunc(color) % n) + n) % n;
}

/** The hue of a Project's stored colour. */
export function projectHue(color: number): number {
  return markHues[index(color)];
}

/** The name of a Project's stored colour: "Teal". */
export function markName(color: number): string {
  return markNames[index(color)];
}

/** The fill of a Project's mark, in the theme's lightness and strength. */
export function markFill(color: number): string {
  return `oklch(var(--mark-l) var(--mark-c) ${projectHue(color)})`;
}
