import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { wfId } from "@/test/fixtures";
import { ESCALATE, FIVE, FIXTURES, HOTFIX, MARKS, WRAP } from "./fixtures";
import { lineTopology, tracks, type LineTopology } from "./layout";
import { drawnWorkflow, type LineWorkflow } from "./model";
import type { Trace } from "./data";
import { WorkflowLine } from "./WorkflowLine";

/*
 * The line never drops a Connector (ADR 0019, decision 9): whatever Workflow it draws and however
 * wide, every Connector touching a drawn Step is in the drawing, on the rail, a track or in words.
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
  return { taskId: "k-1", stays: [{ stepId: at, since: 0, worked: 0, waited: 60_000 }], traversed: [], next: wf.connectors.filter((c) => c.from === at).map((c) => c.id), current: at };
};

const drawings: [string, LineWorkflow][] = [
  ...Object.entries(FIXTURES).map(([name, wf]): [string, LineWorkflow] => [name, wf]),
  ...Object.entries(wfId).map(([name, id]): [string, LineWorkflow] => [`five: ${name}`, FIVE(id)]),
  ["Work of Wrap", WRAP("work")],
  ["Wrap", WRAP("wrap")],
  ["marks", MARKS(false)],
  ["marks after a Backlog", MARKS(true)],
  ["MAIN escalating", ESCALATE()],
  ["BIG escalating", HOTFIX()],
];

describe("every Connector touching a drawn Step is drawn", () => {
  it("each exit and entry as a chip naming its Connector, with its words", () => {
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

describe("as the renderer draws it", () => {
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
  it("is an exit chip on Work's quiet line, by Acceptance", () => {
    const t = lineTopology(WRAP("work"));
    expect(t.rows.map((r) => r.stations)).toEqual([["acceptance"]]);
    expect(t.exits.map((e) => [e.stepId, e.text])).toEqual([["acceptance", "accepted → Wrap › Retro"]]);
    render(<WorkflowLine workflow={WRAP("work")} tasks={[]} now={0} />);
    const chip = document.querySelector('[data-station="acceptance"] [data-chip="exit"]');
    expect(chip).toHaveAttribute("data-connector", "acceptance:accepted");
    expect(chip).toHaveAttribute("data-hint", "Acceptance → Wrap › Retro: when the holder says accepted");
    cleanup();
  });

  it("is an entry chip beside Retro, the first Step of Wrap's own line (only branch Steps: they are its main line), its route arriving at Retro", () => {
    const t = lineTopology(WRAP("wrap"));
    expect(t.main).toEqual(["retro", "skillreview", "done"]);
    expect(t.afterOnly).toBe(true);
    expect(t.rows).toEqual([]);
    expect(t.entries.map((e) => [e.stepId, e.text])).toEqual([["retro", "from Work · accepted"]]);
    // On the line, the crossing in is a chip beside its head, as beside Start.
    render(<WorkflowLine workflow={WRAP("wrap")} tasks={[]} now={0} />);
    const chip = document.querySelector('[data-start-row] [data-chip="entry"]');
    expect(chip).toHaveAttribute("data-connector", "acceptance:accepted");
    expect(chip).toHaveTextContent("Work · accepted");
  });
});

describe("an entry into the Step New Tasks start at", () => {
  afterEach(cleanup);

  it("is a chip beside Start, whether that Step is the line's first or comes after a Backlog", () => {
    for (const backlog of [false, true]) {
      const t = lineTopology(MARKS(backlog));
      expect(t.start).toBe("build");
      expect(t.entries.map((e) => [e.stepId, e.text])).toEqual([["build", "from Support · bug"]]);
      render(<WorkflowLine workflow={MARKS(backlog)} tasks={[]} now={0} />);
      const chip = document.querySelector('[data-start-row] [data-chip="entry"]');
      expect(chip, String(backlog)).toHaveAttribute("data-connector", "support:bug");
      expect(chip).toHaveTextContent("Support · bug");
      cleanup();
    }
  });
});

describe("an exit from a Step a return leaves", () => {
  afterEach(cleanup);

  it("is a chip by its Step, with its words, beside the track (MAIN's QA inside needs changes; BIG's QA, whose fail returns into Build)", () => {
    for (const [wf, exits] of [
      [ESCALATE(), ["escalate → Ops › Hotfix", "outage → Ops › Hotfix"]],
      [HOTFIX(), ["esc → Ops › Fix"]],
    ] as const) {
      const t = lineTopology(wf);
      expect(t.exits.map((e) => e.text)).toEqual(exits);
      expect(tracks(t).some((k) => k.connectors.some((c) => c.from === "qa"))).toBe(true);
      render(<WorkflowLine workflow={wf} tasks={[]} now={0} />);
      for (const e of t.exits) {
        const chip = document.querySelector(`[data-station="qa"] [data-chip="exit"][data-connector=${JSON.stringify(e.connector.id)}]`);
        expect(chip, e.text).toHaveAttribute("data-hint", e.hint);
      }
      cleanup();
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
