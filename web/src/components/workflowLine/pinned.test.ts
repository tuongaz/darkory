import { describe, expect, it } from "vitest";
import { FIXTURES, PAGE, PARENT } from "./fixtures";
import { horizontal, lineTopology } from "./layout";

/*
 * The one-Workflow drawings, pinned: each fixture's topology and pixels at every width the
 * Workflow page and a Parent's card give it, as they stood before a Project could have several
 * Workflows. A change to the line that moves any of them shows here as a diff of the file.
 */

/** Maps as their entries sorted by key, numbers to the nearest half pixel. */
function serialise(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (v instanceof Map) return [...v.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
      if (v instanceof Set) return [...v].sort();
      if (typeof v === "number") return Math.round(v * 2) / 2;
      return v;
    },
    2,
  );
}

const widths = [...new Set([...Object.values(PAGE), ...Object.values(PARENT)])].sort((a, b) => a - b);

describe("the one-Workflow layouts stay where they were", () => {
  for (const [name, wf] of Object.entries(FIXTURES)) {
    const topology = lineTopology(wf);
    for (const width of widths) {
      it(`${name} at ${width}`, async () => {
        const h = horizontal(topology, { width, column: 66, holdColumn: () => 36 });
        await expect(serialise({ topology, horizontal: h })).toMatchFileSnapshot(`./__layouts__/${name.toLowerCase()}-${width}.json`);
      });
    }
  }
});
