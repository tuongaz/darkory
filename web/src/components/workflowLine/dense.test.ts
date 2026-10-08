import { describe, expect, it } from "vitest";
import { FIXTURES, SOFTWARE } from "./fixtures";
import { crossings, densityFor, horizontal, lineTopology, NAME_TOP, TOKEN_HALO, type Density, type Horizontal, type LineTopology } from "./layout";
import { overlaps } from "./place";
import { HAND_LABEL, gapHint } from "./words";

/*
 * The line's promise on every Workflow it is proved on, at every width a screen gives it: no two
 * words, chips or Step heads meet, and none sits on a line it does not belong to. Where they could
 * not all stand clear the line runs down the page instead (WorkflowLine), so a horizontal line is
 * only ever drawn when its every box is clear.
 */

/** The line's own width on the Workflow page at each window width (the sidebar and padding off), and in a Parent's card. */
const PAGE = { 1024: 744, 1280: 1000, 1440: 1160, 1920: 1640 } as const;
const PARENT = { 1024: 506, 1280: 762, 1440: 786, 1920: 786 } as const;

/** What WorkflowLine draws at a width: the density it picks, and whether the line stays across. */
function drawn(t: LineTopology, width: number, compact = false): { h?: Horizontal; density: Density } {
  const at = (d: Density) => horizontal(t, { width, density: d, heads: compact ? "compact" : d, column: 0, noBranch: true });
  let density = densityFor(t, width);
  if (!at(density).fits && density === "tokens" && at("beads").fits) density = "beads";
  if (width < 640 || !at(density).fits) return { density };
  return { density, h: horizontal(t, { width, density, heads: compact ? "compact" : density, column: density === "tokens" ? 66 : 18, holdColumn: () => 36 }) };
}

describe("no two words, chips or heads meet, on any Workflow at any width", () => {
  for (const [name, wf] of Object.entries(FIXTURES)) {
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
  for (const [name, wf] of Object.entries(FIXTURES)) {
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
