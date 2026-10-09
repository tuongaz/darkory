import { describe, expect, it } from "vitest";
import { wfId } from "@/test/fixtures";
import { FIVE, FIXTURES, PAGE, PARENT, SOFTWARE } from "./fixtures";
import { crossings, densityFor, horizontal, lineTopology, NAME_TOP, TOKEN_HALO, type Density, type Horizontal, type LineTopology } from "./layout";
import { overlaps } from "./place";
import { HAND_LABEL, gapHint } from "./words";

/*
 * The line's promise on every Workflow it is proved on, at every width a screen gives it: no two
 * words, chips or Step heads meet, and none sits on a line it does not belong to. Where they could
 * not all stand clear the line runs down the page instead (WorkflowLine), so a horizontal line is
 * only ever drawn when its every box is clear.
 */

/** What WorkflowLine draws at a width: the density it picks, and whether the line stays across. */
function drawn(t: LineTopology, width: number, compact = false): { h?: Horizontal; density: Density } {
  const at = (d: Density) => horizontal(t, { width, density: d, heads: compact ? "compact" : d, column: 0, noBranch: true });
  let density = densityFor(t, width);
  if (!at(density).fits && density === "tokens" && at("beads").fits) density = "beads";
  if (width < 640 || !at(density).fits) return { density };
  return { density, h: horizontal(t, { width, density, heads: compact ? "compact" : density, column: density === "tokens" ? 66 : 18, holdColumn: () => 36 }) };
}

/** Each of ADR 0019's five Workflows drawn alone: Triage with its four exits, the others each with its entry. */
const DRAWN = Object.fromEntries(Object.entries(wfId).map(([name, id]) => [`five: ${name}`, FIVE(id)]));

describe("no two words, chips or heads meet, on any Workflow at any width", () => {
  for (const [name, wf] of Object.entries({ ...FIXTURES, ...DRAWN })) {
    const t = lineTopology(wf);
    for (const [screen, width] of [...Object.entries(PAGE).map(([s, w]) => [`page at ${s}`, w] as const), ...Object.entries(PARENT).map(([s, w]) => [`a Parent at ${s}`, w] as const)]) {
      it(`${name}, ${screen}`, () => {
        const { h } = drawn(t, width);
        if (!h) return;
        expect(h.boxes.length).toBeGreaterThan(t.main.length);
        expect(overlaps(h.boxes)).toEqual([]);
        expect(h.clashes).toEqual([]);
        expect(crossings(h.polylines)).toEqual([]);
        for (const b of h.boxes) {
          expect(b.x, b.id).toBeGreaterThanOrEqual(0);
          expect(b.x + b.w, b.id).toBeLessThanOrEqual(width);
          expect(b.y, b.id).toBeGreaterThanOrEqual(0);
          expect(b.y + b.h, b.id).toBeLessThanOrEqual(h.height);
        }
      });
    }
  }
});

describe("between the screens too", () => {
  for (const [name, wf] of Object.entries({ ...FIXTURES, ...DRAWN })) {
    it(`${name}, every width from 480 to 1800`, () => {
      const t = lineTopology(wf);
      for (let width = 480; width <= 1800; width += 13) {
        const { h } = drawn(t, width);
        if (!h) continue;
        expect(h.clashes, String(width)).toEqual([]);
        expect(overlaps(h.boxes), String(width)).toEqual([]);
      }
    });
  }
});

describe("the software Workflow (14 Steps)", () => {
  const t = lineTopology(SOFTWARE);

  it("keeps a Step after a Parent clear of its row's words with a picked-up Task on it: the token's halo counted", () => {
    // Seen in the proof run at 1440: "propose" and "publish" under the LS-6 token's "now" halo.
    for (const width of [PAGE[1440], PAGE[1920]]) {
      const h = drawn(t, width).h;
      if (!h?.branch) throw new Error(`no branch at ${width}`);
      for (const s of h.branch.stations) {
        const name = h.boxes.find((b) => b.id === `name:${s.id}`);
        expect(name, s.id).toBeDefined();
        // The name line, its tokens and their halo end above the station and the words on its row.
        expect(name!.y, s.id).toBe(s.y - NAME_TOP - TOKEN_HALO);
        expect(name!.y + name!.h, s.id).toBeLessThan(s.y - 8);
        for (const l of h.boxes.filter((b) => b.kind === "label" && Math.abs(b.y + b.h / 2 - s.y) < 10)) {
          expect(name!.y + name!.h <= l.y || name!.x + name!.w <= l.x || l.x + l.w <= name!.x, `${s.id} and ${l.text}`).toBe(true);
        }
      }
    }
  });

  it("runs Triage to Release on the line; Plan breaks down, Backlog parks, Acceptance, Retro and Skill review come after a Parent", () => {
    expect(t.main).toEqual(["triage", "design", "threat-model", "design-review", "build", "code-review", "security-review", "qa", "release", "done"]);
    expect(t.before).toBe("plan");
    expect(t.holds).toEqual(["backlog"]);
    expect(t.rows.map((r) => r.stations)).toEqual([["acceptance"], ["retro", "skill-review"]]);
  });

  it("says nothing moves from Triage to Design or from Design review to Build: their outcomes lead elsewhere", () => {
    const h = horizontal(t, { width: 1160, column: 18 });
    expect(t.segments.filter((s) => !s.connector).map((s) => [s.from, s.hand])).toEqual([
      ["triage", false],
      ["design-review", false],
    ]);
    expect(h.segmentLabels.map((l) => l.text)).not.toContain(HAND_LABEL);
    expect(h.main.filter((m) => m.gap).map((m) => m.from)).toEqual(["triage", "design-review"]);
    expect(h.hints.get("seg:triage")).toBe(gapHint("Triage", "Design"));
  });

  it("says the two needs changes into Build once, between their drops", () => {
    const h = horizontal(t, { width: 1160, column: 18 });
    const track = h.arcs.find((a) => a.id === "track:build")!;
    expect(track.labels.map((l) => l.text)).toEqual(["needs changes", "fail", "not ready", "↩ Build · 4 loops"]);
  });

  it("stays across the Workflow page from 1440 up, and runs down the page in a Parent's card", () => {
    expect(drawn(t, PAGE[1440]).h).toBeDefined();
    expect(drawn(t, PAGE[1920]).h).toBeDefined();
    expect(drawn(t, PARENT[1440]).h).toBeUndefined();
  });
});

describe("a Workflow drawn alone with its exits (Triage of five)", () => {
  const t = lineTopology(FIVE(wfId.triage));

  it("draws each exit as a chip, a word the no-overlap proof sees, at every width the page gives it", () => {
    for (const width of Object.values(PAGE)) {
      const h = drawn(t, width).h;
      if (!h) throw new Error(`Triage runs down the page at ${width}`);
      const exits = h.boxes.filter((b) => b.kind === "chip" && t.exits.some((e) => e.text === b.text));
      expect(exits.map((b) => b.text), String(width)).toEqual(t.exits.map((e) => e.text));
      expect(overlaps(h.boxes), String(width)).toEqual([]);
      expect(h.clashes, String(width)).toEqual([]);
      expect(crossings(h.polylines), String(width)).toEqual([]);
    }
  });
});
