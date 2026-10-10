import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { wfId, wfStep } from "@/test/fixtures";
import { ESCALATE, FIVE, FIXTURES, HOTFIX, MARKS, PAGE, PARENT, WRAP } from "./fixtures";
import { crossings, horizontal, lineTopology, type Horizontal, type HorizontalOptions, type LineTopology } from "./layout";
import { drawnWorkflow, type LineWorkflow } from "./model";
import { overlaps } from "./place";
import type { Trace } from "./data";
import { WorkflowLine } from "./WorkflowLine";
import { ENTRY_LABEL } from "./words";

/*
 * The line never drops a Connector (ADR 0019, decision 9): whatever Workflow it draws and however
 * wide, every Connector touching a drawn Step is in the drawing, on a line or in words, and has a
 * way for a token to travel.
 */

/** The Steps a drawing draws: every one of the topology's, or with `noBranch` (a Task's line off the branch) those off the branch rows. */
const drawnOf = (t: LineTopology, noBranch = false): ReadonlySet<string> => {
  const off = new Set(noBranch ? t.rows.flatMap((r) => r.stations) : []);
  return new Set([...t.steps.keys()].filter((id) => !off.has(id)));
};

/**
 * The Connectors touching a drawing's drawn Steps: within it, out of it, into it; not one to or
 * from a Step of its own Workflow it leaves undrawn (the branch, off a Task's line).
 */
const touching = (wf: LineWorkflow, t: LineTopology, drawn: ReadonlySet<string> = drawnOf(t)) => {
  const undrawn = (id: string | null) => id !== null && t.steps.has(id) && !drawn.has(id);
  return wf.connectors.filter((c) => (drawn.has(c.from) || (c.to !== null && drawn.has(c.to))) && !undrawn(c.from) && !undrawn(c.to));
};

/** A Task's path as TaskLine traces it: waiting at the line's first Step, its outcomes out of there its next moves. */
const traceAt = (wf: LineWorkflow, t: LineTopology): Trace => {
  const at = t.main.find((id) => t.steps.has(id))!;
  return { stays: [{ stepId: at, since: 0, worked: 0, waited: 60_000 }], traversed: [], next: wf.connectors.filter((c) => c.from === at).map((c) => c.id), current: at };
};

/** Every Connector a drawing shows: on the main line, an arc or a track, a branch row, a chip, the entry arrow or a mark. */
function shown(h: Horizontal): Set<string> {
  const ids = [
    ...h.main.map((m) => m.connectorId),
    ...h.arcs.flatMap((a) => a.connectorIds),
    ...(h.branch?.loops.flatMap((a) => a.connectorIds) ?? []),
    ...(h.branch?.labels.map((l) => l.connectorId) ?? []),
    ...h.chips.map((c) => c.connectorId),
    ...(h.entry?.arrow?.connectorIds ?? []),
    ...(h.entry?.arrivals?.flatMap((m) => m.connectorIds) ?? []),
  ];
  return new Set(ids.filter((id): id is string => !!id));
}

const sweep = (from: number) => [...new Set([...Array.from({ length: Math.floor((1800 - from) / 13) + 1 }, (_, k) => from + k * 13), ...Object.values(PAGE), ...Object.values(PARENT)])];

/** How the line is drawn: on the Workflow page, and as a single Task's line (TaskLine, across from 440 px). */
const shapes: Record<string, Omit<HorizontalOptions, "width">> = {
  page: { column: 66, holdColumn: () => 36 },
  "a Task's line": { column: 30, density: "tokens", heads: "compact" },
};

const drawings: [string, LineWorkflow, number][] = [
  ...Object.entries(FIXTURES).map(([name, wf]): [string, LineWorkflow, number] => [name, wf, 480]),
  ...Object.entries(wfId).map(([name, id]): [string, LineWorkflow, number] => [`five: ${name}`, FIVE(id), 440]),
  ["Work of Wrap", WRAP("work"), 440],
  ["Wrap", WRAP("wrap"), 440],
  ["marks", MARKS(false), 440],
  ["marks after a Backlog", MARKS(true), 440],
  ["MAIN escalating", ESCALATE(), 440],
  ["BIG escalating", HOTFIX(), 440],
];

describe("every Connector touching a drawn Step is drawn, at every width", () => {
  for (const [name, wf, from] of drawings) {
    const t = lineTopology(wf);
    for (const [shape, opts] of Object.entries(shapes)) {
      it(`${name}, ${shape}`, () => {
        for (const width of sweep(from)) {
          const h = horizontal(t, { ...opts, width });
          const ids = shown(h);
          for (const c of touching(wf, t)) {
            expect(ids.has(c.id), `${c.id} at ${width}`).toBe(true);
            expect(h.routes.get(c.id), `${c.id}'s route at ${width}`).toMatch(/^M/);
          }
        }
      });
    }
  }

  it("and down a phone, each exit and entry as a chip naming its Connector", () => {
    for (const [name, wf] of drawings) {
      const t = lineTopology(wf);
      const { container } = render(<WorkflowLine workflow={wf} tasks={[]} now={0} />);
      for (const c of [...t.exits, ...t.entries]) {
        const tag = container.querySelector(`[data-chip="${c.kind}"][data-connector="${c.connector.id}"]`);
        expect(tag, `${name}: ${c.text}`).not.toBeNull();
        expect(tag!.hasAttribute(c.kind === "exit" ? "data-exit" : "data-arrival"), `${name}: ${c.text}`).toBe(true);
        expect(tag).toHaveTextContent(c.kind === "entry" ? c.text.replace(/^from /, "") : c.text);
        expect(tag).toHaveAttribute("data-hint", c.hint);
      }
      cleanup();
    }
  });
});

describe("and down the page, as the renderer draws it", () => {
  afterEach(cleanup);

  /** The line as the page draws it, and as TaskLine draws a single Task's: off the branch (`noBranch`), and with its path traced. */
  const rendered: Record<string, (wf: LineWorkflow, t: LineTopology) => Partial<Parameters<typeof WorkflowLine>[0]>> = {
    page: () => ({}),
    "a Task's line off the branch": () => ({ noBranch: true }),
    "a Task's traced line": (wf, t) => ({ noBranch: true, trace: traceAt(wf, t) }),
  };

  for (const [name, wf] of drawings) {
    for (const [shape, propsOf] of Object.entries(rendered)) {
      it(`${name}, ${shape}`, () => {
        const t = lineTopology(wf);
        const props = propsOf(wf, t);
        const drawn = drawnOf(t, props.noBranch);
        const { container } = render(<WorkflowLine workflow={wf} tasks={[]} now={0} {...props} />);
        const named = new Set([
          ...[...container.querySelectorAll("[data-connector]")].map((el) => el.getAttribute("data-connector")),
          ...[...container.querySelectorAll("[data-connectors]")].flatMap((el) => JSON.parse(el.getAttribute("data-connectors")!) as string[]),
        ]);
        // Every Connector touching a drawn Step is somewhere in the drawing, by its id.
        for (const c of touching(wf, t, drawn)) expect(named.has(c.id), `${c.id}, ${name}`).toBe(true);
        // Each exit and entry is a chip of its kind.
        for (const c of [...t.exits, ...t.entries].filter((x) => drawn.has(x.stepId))) expect(container.querySelector(`[data-chip="${c.kind}"][data-connector=${JSON.stringify(c.connector.id)}]`), `${c.text}, ${name}`).not.toBeNull();
      });
    }
  }
});

describe("a crossing between two branches (Work's Acceptance says accepted into Wrap's Retro)", () => {
  it("is an exit chip on Work's branch row, beside Acceptance, its route leaving Acceptance square-cornered", () => {
    const t = lineTopology(WRAP("work"));
    expect(t.rows.map((r) => r.stations)).toEqual([["acceptance"]]);
    expect(t.exits.map((e) => [e.stepId, e.text])).toEqual([["acceptance", "accepted → Wrap › Retro"]]);
    const h = horizontal(t, { width: 1000, column: 66 });
    const chip = h.chips.find((c) => c.connectorId === "acceptance:accepted")!;
    expect(chip).toMatchObject({ kind: "exit", stepId: "acceptance", hint: "Acceptance → Wrap › Retro: when the holder says accepted" });
    const at = h.at.get("acceptance")!;
    expect(h.routes.get("acceptance:accepted")).toMatch(new RegExp(`^M${at.x} ${at.y} V[\\d.]+ H[\\d.]+$`));
    expect(overlaps(h.boxes)).toEqual([]);
  });

  it("is an entry chip on Wrap's branch row, beside Retro, its route arriving at Retro", () => {
    const t = lineTopology(WRAP("wrap"));
    expect(t.main).toEqual(["done"]);
    expect(t.rows.map((r) => r.stations)).toEqual([["retro", "skillreview"]]);
    expect(t.entries.map((e) => [e.stepId, e.text])).toEqual([["retro", "from Work · accepted"]]);
    const h = horizontal(t, { width: 1000, column: 66 });
    expect(h.chips.find((c) => c.connectorId === "acceptance:accepted")).toMatchObject({ kind: "entry", stepId: "retro", text: "from Work · accepted", hint: "Work › Acceptance → Retro: when the holder says accepted" });
    const at = h.at.get("retro")!;
    expect(h.routes.get("acceptance:accepted")).toMatch(new RegExp(`H${at.x} V${at.y}$`));
  });
});

describe("marks over a head", () => {
  it("where New Tasks start at the line's first Step, the arrow says so, and an entry into it is a mark over its head", () => {
    const t = lineTopology(MARKS(false));
    expect(t.main[0]).toBe("build");
    const h = horizontal(t, { width: 1000, column: 30 });
    expect(h.entry?.arrow?.label.text).toBe(ENTRY_LABEL);
    expect(h.entry?.arrow?.connectorIds).toEqual([]);
    expect(h.entry?.mark).toBeUndefined();
    expect(h.entry?.arrivals?.map((m) => [m.stepId, m.lines, m.connectorIds])).toEqual([["build", ["from Support · bug"], ["support:bug"]]]);
    const build = h.heads.find((x) => x.id === "build")!;
    expect(h.entry!.arrivals![0].top + 20).toBeLessThanOrEqual(build.top);
    expect(overlaps(h.boxes)).toEqual([]);
    expect(h.clashes).toEqual([]);
  });

  it("where New Tasks start at a Step after the line's first that Tasks also enter, two marks stack over it: where they start nearest, the entry over it", () => {
    const t = lineTopology(MARKS(true));
    expect(t.main).toEqual(["backlog", "build", "qa", "done"]);
    for (const width of [744, 1000, 1160]) {
      const h = horizontal(t, { width, column: 30 });
      const start = h.entry!.mark!;
      const [entry] = h.entry!.arrivals!;
      const build = h.heads.find((x) => x.id === "build")!;
      expect(start.x, String(width)).toBe(h.at.get("build")!.x);
      expect(entry.stepId).toBe("build");
      expect(entry.x).toBe(start.x);
      // Nearest the head the start's mark, then the entry's above it.
      expect(start.top).toBeLessThan(build.top);
      expect(entry.top).toBeLessThan(start.top);
      expect(h.boxes.filter((b) => b.kind === "mark").map((b) => b.id)).toEqual(["mark", "arrival:build"]);
      expect(overlaps(h.boxes), String(width)).toEqual([]);
      expect(h.clashes, String(width)).toEqual([]);
    }
  });

  it("breaks a mark that wraps after its ·, never before it", () => {
    const t = lineTopology(MARKS(true, "found a bug in the product"));
    const wrapped: string[][] = [];
    for (let width = 300; width <= 1000; width += 13) {
      for (const m of horizontal(t, { width, column: 30 }).entry?.arrivals ?? []) {
        for (const line of m.lines) expect(line.startsWith("·"), `${line} at ${width}`).toBe(false);
        if (m.lines.length > 1) wrapped.push(m.lines);
      }
    }
    // Narrow, the mark has to wrap; it does so only after its "·".
    expect(wrapped.length).toBeGreaterThan(0);
    for (const lines of wrapped) expect(lines).toEqual(["from Support ·", "found a bug in the product"]);
  });
});

describe("an exit whose leg would cross what runs under the line", () => {
  it("goes under everything as a chip, its route square-cornered down from its Step, where a second chip on its leg would meet an arc (MAIN's QA, inside needs changes)", () => {
    const t = lineTopology(ESCALATE());
    expect(t.exits.map((e) => e.text)).toEqual(["escalate → Ops › Hotfix", "outage → Ops › Hotfix"]);
    for (const width of [1000, 1198]) {
      const h = horizontal(t, { width, column: 66 });
      expect(h.exits, String(width)).toEqual([]);
      expect(h.polylines.filter((p) => p.id.startsWith("exit:"))).toEqual([]);
      const qa = h.at.get("qa")!;
      for (const e of t.exits) {
        const chip = h.chips.find((c) => c.connectorId === e.connector.id)!;
        expect(chip).toMatchObject({ kind: "exit", align: "center", hint: e.hint });
        expect(chip.y).toBeGreaterThan(h.lineY + 60);
        expect(h.routes.get(e.connector.id)).toBe(`M${qa.x} ${h.lineY} V${chip.y + 10} H${chip.x}`);
      }
      expect(overlaps(h.boxes)).toEqual([]);
      expect(crossings(h.polylines)).toEqual([]);
    }
  });

  it("goes under everything when its leg would run along a drop onto a return track (BIG's QA, whose fail drops onto the track into Build)", () => {
    const t = lineTopology(HOTFIX());
    const track = t.under.find((e) => e.kind === "track");
    expect(track?.kind === "track" && track.drops.map((d) => d.connector.from)).toContain("qa");
    expect(t.exits.map((e) => e.text)).toEqual(["esc → Ops › Fix"]);
    // Wide enough that the chip itself would stand clear between QA's drop and the next: only its leg cannot.
    for (const width of [1600, 1800]) {
      const h = horizontal(t, { width, column: 36 });
      expect(h.exits, String(width)).toEqual([]);
      const qa = h.at.get("qa")!;
      const chip = h.chips.find((c) => c.connectorId === "qa:esc")!;
      expect(chip).toMatchObject({ kind: "exit", align: "center", text: "esc → Ops › Fix", hint: "QA → Ops › Fix: when the holder says esc" });
      expect(chip.y).toBeGreaterThan(h.lineY + 40);
      expect(h.routes.get("qa:esc")).toBe(`M${qa.x} ${h.lineY} V${chip.y + 10} H${chip.x}`);
      expect(overlaps(h.boxes)).toEqual([]);
      expect(crossings(h.polylines)).toEqual([]);
    }
  });

  it("stays inside a narrow line: Triage's four exits at 440 px go under everything, each with its words on hover", () => {
    const t = lineTopology(FIVE(wfId.triage));
    const h = horizontal(t, { width: 440, column: 30, density: "tokens", heads: "compact" });
    expect(h.polylines.filter((p) => p.id.startsWith("exit:"))).toEqual([]);
    const chips = h.chips.filter((c) => c.stepId === wfStep.triage);
    expect(chips.map((c) => c.text)).toEqual(t.exits.map((e) => e.text));
    expect(chips.map((c) => c.hint)).toEqual(t.exits.map((e) => e.hint));
    expect(overlaps(h.boxes)).toEqual([]);
    for (const b of h.boxes.filter((x) => x.kind === "chip")) {
      expect(b.x, b.text).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, b.text).toBeLessThanOrEqual(440);
    }
  });
});

describe("the Workflow a line draws", () => {
  it("is the one picked; an id the Project does not have reads as the first by position; of one Workflow, none", () => {
    const wf = FIVE();
    expect(drawnWorkflow(wf, wfId.bugs)).toBe(wfId.bugs);
    expect(drawnWorkflow(wf, "wf-gone")).toBe(wfId.triage);
    expect(drawnWorkflow(wf)).toBe(wfId.triage);
    expect(drawnWorkflow(FIXTURES.MAIN, "wf-gone")).toBeUndefined();
    // A Project of one Workflow draws every Step, its one Workflow picked or not.
    expect(drawnWorkflow(FIXTURES.MAIN, "work")).toBeUndefined();
  });
});
