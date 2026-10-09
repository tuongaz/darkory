import { describe, expect, it } from "vitest";
import { FIXTURES, PAGE, PARENT } from "./fixtures";
import { horizontal, lineTopology, type Horizontal } from "./layout";

/*
 * The one-Workflow drawings, pinned: each fixture's topology, and its pixels at every width the
 * Workflow page and a Parent's card give it, as they stood before a Project could have several
 * Workflows. A change to the line that moves any of them shows here as a diff of the file.
 */

const byKey = ([a]: [unknown, unknown], [b]: [unknown, unknown]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** Maps as their entries sorted by key, Sets sorted, numbers to the nearest half pixel. */
function serialise(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (v instanceof Map) return [...v.entries()].sort(byKey);
      if (v instanceof Set) return [...v].map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (typeof v === "number") return Math.round(v * 2) / 2;
      return v;
    },
    2,
  );
}

/** What a drawing places: its hover sentences and its boxes' words follow from the topology. */
function placed(h: Horizontal) {
  return Object.fromEntries(
    Object.entries(h)
      .filter(([key]) => key !== "hints")
      .map(([key, v]) => [key, key === "boxes" ? h.boxes.map((box) => Object.fromEntries(Object.entries(box).filter(([k]) => k !== "text"))) : v]),
  );
}

const widths = [...new Set([...Object.values(PAGE), ...Object.values(PARENT)])].sort((a, b) => a - b);

describe("the one-Workflow layouts stay where they were", () => {
  for (const [name, wf] of Object.entries(FIXTURES)) {
    const topology = lineTopology(wf);
    it(`${name}'s topology`, async () => {
      await expect(serialise(topology)).toMatchFileSnapshot(`./__layouts__/${name.toLowerCase()}-topology.json`);
    });
    for (const width of widths) {
      it(`${name} at ${width}`, async () => {
        const h = horizontal(topology, { width, column: 66, holdColumn: () => 36 });
        await expect(serialise({ horizontal: placed(h) })).toMatchFileSnapshot(`./__layouts__/${name.toLowerCase()}-${width}.json`);
      });
    }
  }
});
