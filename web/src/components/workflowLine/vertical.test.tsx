import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wfId } from "@/test/fixtures";
import type { Chain, Trace } from "./data";
import { BIG, DARK, FIVE, MAIN, NEWS, SOFTWARE } from "./fixtures";
import { lineTopology, tracks } from "./layout";
import type { LineMember, LineTask, LineWorkflow } from "./model";
import { WorkflowLine } from "./WorkflowLine";

// The line runs top to bottom at every width (the final design, vf-1 … vf-6): Start's filled
// station first, the outcomes on the rail, returns as tracks beside it, marks only for what
// leaves the line, "Also starts here" beside the start, and the quiet row "When a Parent ends".

const rail = () => screen.getByRole("list", { name: "Steps on the line" });
const stations = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(":scope > li[data-station]")];
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("the line, top to bottom", () => {
  it("puts the start Step's filled station first, under Start, whose hover says where New Tasks start (vf-1)", () => {
    render(<WorkflowLine workflow={DARK("impl")} tasks={[]} now={0} />);
    const first = stations(rail())[0];
    expect(first).toHaveAttribute("data-station", "build");
    expect(first).toHaveAttribute("data-start");
    const start = screen.getByText("Start", { selector: "[data-start-label] *, [data-start-label]" }).closest("[data-start-label]")!;
    expect(start).toHaveAttribute("data-hint", "New Tasks start at Build, unless the filer names another Step");
    expect(before(start, first)).toBe(true);
    expect(document.querySelector('[data-dot="build"]')).toHaveAttribute("data-start");
    expect(stations(rail()).map((li) => li.getAttribute("data-head"))).toEqual(["Build", "Review", "Done"]);
  });

  it("says Start's sentence to the keyboard: Start takes the focus, shows it, and is described by it", async () => {
    render(<WorkflowLine workflow={DARK("impl")} tasks={[]} now={0} />);
    const start = document.querySelector<HTMLElement>("[data-start-label]")!;
    await userEvent.tab();
    expect(start).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("New Tasks start at Build, unless the filer names another Step");
    expect(start).toHaveAccessibleDescription("New Tasks start at Build, unless the filer names another Step");
    await userEvent.tab();
    expect(start).not.toHaveFocus();
  });

  it("describes every word that has a sentence, and lets each take the focus", () => {
    render(<WorkflowLine workflow={DARK("bugs")} tasks={[]} now={0} />);
    const carriers = [...document.querySelectorAll<HTMLElement>("[data-hint]")].filter((el) => !(el instanceof SVGElement));
    expect(carriers.length).toBeGreaterThan(8);
    for (const el of carriers) {
      expect(el, el.textContent ?? "").toHaveAttribute("tabindex", "0");
      expect(el).toHaveAccessibleDescription(el.getAttribute("data-hint")!);
    }
  });

  it("puts a crossing in beside Start, in the entry's words (vf-1: Bug triage · feature)", () => {
    render(<WorkflowLine workflow={DARK("impl")} tasks={[]} now={0} />);
    const chip = document.querySelector('[data-start-row] [data-chip="entry"]');
    expect(chip).toHaveTextContent("Bug triage · feature");
    expect(chip).toHaveAttribute("data-connector", "triage:feature");
  });

  it("starts a line no New Task starts on at its first Step, saying a Task arrives there by name (vf-3)", () => {
    render(<WorkflowLine workflow={DARK("bugs")} tasks={[]} now={0} />);
    expect(stations(rail())[0]).toHaveAttribute("data-station", "triage");
    expect(document.querySelector("[data-start-label]")).toHaveAttribute("data-hint", "A Task arrives here when its filer names Triage");
  });

  it("names each segment by its outcome on the rail, with an arrowhead into the next station", () => {
    render(<WorkflowLine workflow={DARK("bugs")} tasks={[]} now={0} />);
    const t = lineTopology(DARK("bugs"));
    for (const s of t.segments) {
      const label = rail().querySelector(`[data-segment="${s.from}"]`);
      expect(label, s.from).toHaveTextContent(s.connector!.name);
      expect(document.querySelector(`path[data-arrow="${s.from}"]`), s.from).not.toBeNull();
    }
  });

  it("draws a return as a track per Step returned to, labelled at the Step it leaves; Bug triage's two into Fix share one (vf-3)", () => {
    render(<WorkflowLine workflow={DARK("bugs")} tasks={[]} now={0} />);
    expect(document.querySelectorAll("[data-track]").length).toBe(1);
    expect(document.querySelector('[data-track="fix"]')).not.toBeNull();
    const review = rail().querySelector('li[data-station="creview"]')!;
    expect(within(review as HTMLElement).getByText(/needs changes → Fix/).closest("[data-return]")).toHaveTextContent("↩ needs changes → Fix");
    const verify = rail().querySelector('li[data-station="verify"]')!;
    expect(within(verify as HTMLElement).getByText(/fail → Fix/).closest("[data-return]")).toHaveTextContent("↩ fail → Fix");
  });

  it("gives every track its lane, as many lanes as tracks (BIG: rework, Build's five, rollback)", () => {
    render(<WorkflowLine workflow={BIG} tasks={[]} now={0} />);
    const drawn = [...document.querySelectorAll("[data-track]")].map((el) => [el.getAttribute("data-track"), el.getAttribute("data-lane")]);
    expect(drawn).toEqual(tracks(lineTopology(BIG)).map((k) => [k.target, String(k.lane)]));
  });

  it("marks only what leaves the line: not a bug into Done, feature into Implementation › Build (vf-3)", () => {
    render(<WorkflowLine workflow={DARK("bugs")} tasks={[]} now={0} />);
    const triage = rail().querySelector<HTMLElement>('li[data-station="triage"]')!;
    expect(within(triage).getByText(/not a bug → Done/).closest("[data-mark]")).toHaveAttribute("data-mark", "done");
    const exit = within(triage).getByText(/feature → Implementation › Build/).closest("[data-chip]")!;
    expect(exit).toHaveAttribute("data-exit", "triage:feature");
    expect(exit).toHaveTextContent("↗");
    // Nothing else is a mark but the Retrospective at Done: bug, ready and pass run on the rail; the returns are tracks.
    expect([...rail().querySelectorAll("[data-mark]")].map((m) => m.textContent)).toEqual(["● not a bug → Done", "↗ feature → Implementation › Build", "↗ Retrospective › Retro"]);
  });

  it("draws a hold on the line as a dashed station with its pill, its move on by hand the dotted segment (vf-6)", () => {
    render(<WorkflowLine workflow={NEWS} tasks={[]} now={0} />);
    const legal = rail().querySelector<HTMLElement>('li[data-station="legal"]')!;
    expect(legal).toHaveAttribute("data-hold");
    expect(within(legal).getByText("hold")).toBeInTheDocument();
    expect(document.querySelector('[data-dot="legal"]')).toHaveAttribute("stroke-dasharray");
    expect(legal.querySelector('[data-segment="legal"]')).toHaveTextContent("by hand");
    expect(document.querySelector('path[data-rail="legal"]')).toHaveAttribute("stroke-dasharray");
    expect(document.querySelector('path[data-arrow="legal"]')).not.toBeNull();
  });

  it("says each Step's Skill as a tag and its median bare, each with its sentence on hover", () => {
    const facts = { ...DARK("impl"), steps: DARK("impl").steps.map((s) => (s.id === "build" ? { ...s, medianMs: 6 * 60_000, takers: [{ id: "m1", name: "builder", kind: "agent" as const }] } : s)) };
    render(<WorkflowLine workflow={facts} tasks={[]} now={0} />);
    const build = rail().querySelector<HTMLElement>('li[data-station="build"]')!;
    expect(within(build).getByText("engineer").closest("[data-hint]")).toHaveAttribute("data-hint", "the Skill a Member needs to take Tasks here");
    expect(within(build).getByText("6m")).toHaveAttribute("data-hint", "median time a Task spends here");
    expect(within(build).getByRole("img", { name: /builder/ })).toBeInTheDocument();
  });
});

describe("Also starts here", () => {
  it("stands beside the start Step: Backlog with its hold pill and ⇢ Build, Plan with ● Done and ↳ Build (vf-1)", () => {
    render(<WorkflowLine workflow={DARK("impl")} tasks={[{ id: "t1", key: "DARK-30", title: "Later", stepId: "backlog", kind: "work", blockers: [] }]} now={0} />);
    const group = screen.getByRole("region", { name: "Also starts here" });
    expect(group.closest("li")).toHaveAttribute("data-station", "build");
    const backlog = group.querySelector<HTMLElement>('[data-side="backlog"]')!;
    expect(within(backlog).getByText("hold")).toBeInTheDocument();
    // Its Task waits in the hold: counted, "1 waiting", as vf-1 draws it.
    expect(within(backlog).getByRole("button", { name: "Backlog: 1 Task waiting" })).toBeInTheDocument();
    expect(backlog.querySelector("[data-mark]")).toHaveTextContent("⇢ Build");
    const plan = group.querySelector<HTMLElement>('[data-side="plan"]')!;
    expect([...plan.querySelectorAll("[data-mark]")].map((m) => m.textContent)).toEqual(["● done → Done", "↳ Build"]);
    // Neither is a station on the rail.
    expect(stations(rail()).map((li) => li.getAttribute("data-station"))).toEqual(["build", "review", "done"]);
  });

  it("takes a Step that stands before the start: BIG's Backlog, its pass into Triage by hand", () => {
    render(<WorkflowLine workflow={BIG} tasks={[]} now={0} />);
    const group = screen.getByRole("region", { name: "Also starts here" });
    expect(group.querySelector('[data-side="backlog"] [data-mark]')).toHaveTextContent("⇢ pass → Triage");
    expect(group.querySelector('[data-side="backlog"] [data-mark]')).toHaveAttribute("data-mark", "hand");
    expect(group.querySelector('[data-side="backlog"] [data-mark]')).toHaveAttribute("data-hint", "Backlog: a hold. No one is offered these; a human moves a Task on by hand, to any Step");
    expect(stations(rail())[0]).toHaveAttribute("data-station", "triage");
  });

  it("names no Step for the Subtasks Break down files: Triage is only the default (the software Workflow)", () => {
    render(<WorkflowLine workflow={SOFTWARE} tasks={[]} now={0} />);
    const files = screen.getByRole("region", { name: "Also starts here" }).querySelector('[data-mark="files"]')!;
    expect(files.getAttribute("data-hint")).toMatch(/files the Parent's other Subtasks, each at the Step its filer names, Triage when they name none$/);
  });
});

describe("When a Parent ends", () => {
  it("draws the Steps carrying the branch's Skills as their own quiet line with their own Done; nothing reaches the main Done from it (vf-2)", () => {
    render(<WorkflowLine workflow={MAIN} tasks={[]} now={0} label="main" />);
    const main = screen.getByRole("region", { name: "main" });
    const after = within(main).getByRole("region", { name: "When a Parent ends" });
    const line = within(after).getByRole("list", { name: "When a Parent ends" });
    expect(stations(line).map((li) => li.getAttribute("data-station"))).toEqual(["acceptance", "retro", "skillreview", "done"]);
    const mainRail = within(main).getByRole("list", { name: "Steps on the line" });
    expect(after.contains(mainRail)).toBe(false);
    // Retro's propose and Skill review's publish run on its rail; needs changes is its track.
    expect(line.querySelector('[data-segment="retro"]')).toHaveTextContent("propose");
    expect(line.querySelector('[data-segment="skillreview"]')).toHaveTextContent("publish");
    expect(after.querySelector('[data-track="retro"]')).not.toBeNull();
    // Its words read outcome → target: Retro's done into its own Done, Acceptance's fail back into the main line's Build.
    expect(line.querySelector('[data-connector="retro:done"]')).toHaveTextContent("● done → Done");
    expect(line.querySelector('[data-connector="acceptance:fail"]')).toHaveTextContent("↩ fail → Build");
    expect(line.querySelector('[data-connector="acceptance:fail"]')).toHaveAttribute("data-mark", "return");
    // Quiet, yet each Step says its Skill (vf-2: Retro ⌖ retro), its marks without their fill.
    expect(line.querySelector('li[data-station="retro"]')).toHaveTextContent(/^Retro\s*retro/);
    expect(line.querySelector('[data-connector="retro:done"]')).not.toHaveClass("bg-state-done-bg");
    // No Connector of the branch is drawn on the main rail.
    for (const id of ["retro:done", "retro:propose", "skillreview:publish", "skillreview:needs changes", "acceptance:pass"]) expect(mainRail.querySelector(`[data-connector="${id}"]`), id).toBeNull();
  });

  it("draws a Workflow of only branch Steps as its own main line, headed When a Parent ends, its first station filled, with no quiet row (vf-8)", () => {
    render(<WorkflowLine workflow={DARK("retros")} tasks={[]} now={0} label="retros" />);
    const main = screen.getByRole("region", { name: "retros" });
    const rail = within(main).getByRole("list", { name: "Steps on the line" });
    expect(stations(rail).map((li) => li.getAttribute("data-head"))).toEqual(["Retro", "Skill review", "Done"]);
    expect(stations(rail)[0]).toHaveAttribute("data-start");
    const head = main.querySelector("[data-start-label]")!;
    expect(head).toHaveTextContent("When a Parent ends");
    expect(head).not.toHaveTextContent("Start");
    expect(within(main).getByRole("button", { name: "About When a Parent ends" })).toBeInTheDocument();
    // Its outcomes run on the rail and its return is a track, as on any line.
    expect(rail.querySelector('[data-segment="retro"]')).toHaveTextContent("propose");
    expect(rail.querySelector('[data-segment="skillreview"]')).toHaveTextContent("publish");
    expect(rail.querySelector('[data-connector="retro:done"]')).toHaveTextContent("● done → Done");
    expect(within(main).queryByRole("region", { name: "When a Parent ends" })).toBeNull();
  });

  it("keeps the quiet row for a Workflow that mixes worked and branch Steps", () => {
    render(<WorkflowLine workflow={MAIN} tasks={[]} now={0} label="main" />);
    const main = screen.getByRole("region", { name: "main" });
    expect(main.querySelector("[data-start-label]")).toHaveTextContent("Start");
    expect(within(main).getByRole("region", { name: "When a Parent ends" })).toBeInTheDocument();
  });
});

describe("the Retrospective at Done", () => {
  it("is a chip at Done on a Workflow that does not hold the Project's retro Step", () => {
    render(<WorkflowLine workflow={DARK("impl")} tasks={[]} now={0} />);
    const done = rail().querySelector<HTMLElement>('li[data-station="done"]')!;
    const chip = done.querySelector("[data-retro]")!;
    expect(chip).toHaveTextContent("↗ Retrospective › Retro");
    expect(chip).toHaveAttribute("data-hint", "When a Parent ends, Darkory files its Retrospective at Retrospective › Retro");
  });

  it("is not there on the Workflow that holds it, nor on a Project of one Workflow, nor where no Step carries retro", () => {
    // NEWS: one Workflow, no retro Step, drawn as the Project's line and drawn by name.
    for (const wf of [DARK("retros"), MAIN, NEWS, { ...NEWS, drawn: "work" }, FIVE(wfId.triage)]) {
      const { unmount } = render(<WorkflowLine workflow={wf} tasks={[]} now={0} />);
      expect(document.querySelector("[data-retro]")).toBeNull();
      unmount();
    }
  });
});

describe("across Workflows (ADR 0019)", () => {
  it("draws Triage's four outcomes into other Workflows as exits, and the entry from Triage beside Bugs' Start", () => {
    const { unmount } = render(<WorkflowLine workflow={FIVE(wfId.triage)} tasks={[]} now={0} />);
    for (const text of ["bug → Bugs › Investigate", "feature → Features › Build", "prototype → Prototypes › Sketch", "question → Support › Support"]) {
      expect(within(rail()).getByText(text).closest("[data-chip]")).toHaveAttribute("data-exit");
    }
    unmount();

    render(<WorkflowLine workflow={FIVE(wfId.bugs)} tasks={[]} now={0} />);
    const entry = document.querySelector('[data-start-row] [data-chip="entry"]')!;
    expect(entry).toHaveTextContent("Triage · bug");
    expect(entry).toHaveAttribute("data-arrival");
  });
});

describe("the selected Task's strip (vf-7)", () => {
  const NOW = Date.UTC(2026, 9, 10, 3, 30);
  const min = (n: number) => NOW - n * 60_000;
  const agent = (name: string): LineMember => ({ id: `m-${name}`, name, kind: "agent", working: "running" });
  const held = (n: number, stepId: string, by: string, minutes: number, extra: Partial<LineTask> = {}): LineTask => ({
    id: `k-${n}`,
    key: `DARK-${n}`,
    title: `Task ${n}`,
    stepId,
    kind: "work",
    since: min(minutes + 5),
    holder: agent(by),
    heldSince: min(minutes),
    blockers: [],
    ...extra,
  });
  const waiting = (n: number, stepId: string, minutes: number, extra: Partial<LineTask> = {}): LineTask => ({ id: `k-${n}`, key: `DARK-${n}`, title: `Task ${n}`, stepId, kind: "work", since: min(minutes), blockers: [], ...extra });
  /** vf-7's DARK: builder holds DARK-21 at Build (18m), DARK-28 waits there, reviewer holds DARK-19 at Review. */
  const VF7: LineTask[] = [held(21, "build", "builder", 18), waiting(28, "build", 2), held(19, "review", "reviewer", 6)];
  const claim = (first: Chain["first"]) => (first.kind === "none" ? null : <button type="button">{`Claim ${first.task.key}`}</button>);

  function Selecting({
    tasks,
    initial = null,
    takeable = [],
    workflow = DARK("impl"),
    trace,
    open = true,
  }: {
    tasks: readonly LineTask[];
    initial?: string | null;
    takeable?: string[];
    workflow?: LineWorkflow;
    trace?: Trace;
    /** Whether the line can open a Task's peek (the strip's key a button). */
    open?: boolean;
  }) {
    const [selected, setSelected] = useState<string | null>(initial);
    return (
      <MemoryRouter>
        <input aria-label="Elsewhere" />
        <WorkflowLine
          label="Workflow"
          workflow={workflow}
          trace={trace}
          tasks={tasks}
          now={NOW}
          selected={selected}
          onSelect={setSelected}
          me={{ id: "m-me", takeable: new Set(takeable) }}
          actionFor={claim}
          onOpenTask={open ? () => {} : undefined}
          stepHref={(id) => `/tasks?step=${id}`}
        />
      </MemoryRouter>
    );
  }
  const line = () => screen.getByRole("region", { name: "Workflow" });
  const chip = (key: string) => line().querySelector<HTMLElement>(`button[data-task="${key}"]:not([data-step-list] *)`)!;
  const strip = (key: string) => screen.queryByRole("region", { name: `${key}'s way` });
  const dimmed = (el: Element | null) => !!el?.closest("[data-dim]");

  it("selecting DARK-21's chip puts its way above the line: the pill, its holder, key and age, what it can do next, and ×", async () => {
    render(<Selecting tasks={VF7} />);
    expect(strip("DARK-21")).toBeNull();
    await userEvent.click(chip("DARK-21"));
    const s = strip("DARK-21")!;
    expect(line()).toContainElement(s);
    expect(before(s, rail())).toBe(true);
    expect(s).toHaveTextContent(/^DARK-21's way/);
    expect(within(s).getByRole("img", { name: /^builder \(agent\)/ })).toBeInTheDocument();
    expect(s).toHaveTextContent("DARK-21");
    expect(s).toHaveTextContent("18m");
    expect(s).toHaveTextContent("next: pass → Review");
    expect(within(s).getByRole("button", { name: "Clear" })).toBeInTheDocument();
    // The station it is at is ringed; no other is.
    expect([...document.querySelectorAll("[data-picked]")].map((c) => c.getAttribute("data-picked"))).toEqual(["build"]);
    // Nothing must end first: no "First:" and no button.
    expect(s).not.toHaveTextContent("First:");
    expect(within(s).queryByRole("button", { name: /^Claim/ })).toBeNull();
  });

  it("names each of a Task's next outcomes with its target: one at Review lists both", async () => {
    render(<Selecting tasks={VF7} />);
    await userEvent.click(chip("DARK-19"));
    expect(strip("DARK-19")).toHaveTextContent("next: pass → Done · needs changes → Build");
  });

  it("moves the focus into the strip when it appears", async () => {
    render(<Selecting tasks={VF7} />);
    await userEvent.click(chip("DARK-21"));
    expect(strip("DARK-21")).toContainElement(document.activeElement as HTMLElement);
  });

  it("keeps the Task's way in full ink and fades everything else: the other Tasks, the counts, the untaken entry, Also starts here", async () => {
    render(<Selecting tasks={VF7} />);
    await userEvent.click(chip("DARK-21"));
    expect(dimmed(chip("DARK-21"))).toBe(false);
    expect(dimmed(chip("DARK-19"))).toBe(true);
    expect(dimmed(line().querySelector('button[data-count="build"]'))).toBe(true);
    expect(dimmed(screen.getByRole("region", { name: "Also starts here" }))).toBe(true);
    expect(dimmed(line().querySelector('[data-start-row] [data-chip="entry"]'))).toBe(true);
    // Its way in (Start, into Build) and the line itself stay.
    expect(dimmed(line().querySelector("[data-start-label]"))).toBe(false);
    for (const id of ["build", "review", "done"]) expect(dimmed(line().querySelector(`li[data-station="${id}"] [data-segment], li[data-station="${id}"]`)), id).toBe(false);
    expect(dimmed(line().querySelector("svg"))).toBe(false);
  });

  it("takes the focus only when the viewer picks: not for a selection that arrives from elsewhere, nor when the Task moves on", async () => {
    const { rerender } = render(<Selecting tasks={VF7} initial="k-21" />);
    expect(strip("DARK-21")).not.toBeNull();
    expect(strip("DARK-21")).not.toContainElement(document.activeElement as HTMLElement);

    rerender(<Selecting tasks={VF7} />);
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    elsewhere.focus();
    // DARK-21 moves on to Review while selected: the focus stays where it is.
    rerender(<Selecting tasks={[held(21, "review", "builder", 1), waiting(28, "build", 2), held(19, "review", "reviewer", 6)]} />);
    expect(strip("DARK-21")).toHaveTextContent("next: pass → Done");
    expect(elsewhere).toHaveFocus();
  });

  it("reads its way in from its own trace only: the entry it crossed in by stays lit, Start fades", () => {
    const trace = (taskId: string): Trace => ({ taskId, stays: [{ stepId: "build", since: 0, worked: 0, waited: 0 }], traversed: ["triage:feature"], next: ["build:pass"], current: "build" });
    const entry = () => line().querySelector('[data-start-row] [data-chip="entry"]');
    const start = () => line().querySelector("[data-start-label]");
    const { unmount } = render(<Selecting tasks={[held(21, "build", "builder", 18)]} initial="k-21" trace={trace("k-21")} />);
    expect(dimmed(entry())).toBe(false);
    expect(dimmed(start())).toBe(true);
    unmount();
    // Another Task's trace, the line showing DARK-21 alone (a Filter): DARK-21's way in is its Step.
    render(<Selecting tasks={[held(21, "build", "builder", 18)]} initial="k-21" trace={trace("k-99")} />);
    expect(dimmed(entry())).toBe(true);
    expect(dimmed(start())).toBe(false);
  });

  it("fades When a Parent ends while the way runs nowhere near it, and keeps it when a Task of the chain is there", async () => {
    const tasks = [held(21, "build", "builder", 18), waiting(30, "acceptance", 4)];
    const { unmount } = render(<Selecting tasks={tasks} workflow={MAIN} initial="k-21" />);
    expect(dimmed(screen.getByRole("region", { name: "When a Parent ends" }))).toBe(true);
    unmount();
    const blocked = [held(21, "build", "builder", 18, { blockers: [{ id: "k-30", key: "DARK-30", title: "Task 30" }] }), waiting(30, "acceptance", 4)];
    render(<Selecting tasks={blocked} workflow={MAIN} initial="k-21" />);
    expect(dimmed(screen.getByRole("region", { name: "When a Parent ends" }))).toBe(false);
  });

  it("rings the station of a Task selected on the quiet line, as on the main one", () => {
    render(<Selecting tasks={[held(30, "acceptance", "tuongaz", 4)]} workflow={MAIN} initial="k-30" />);
    const after = screen.getByRole("region", { name: "When a Parent ends" });
    expect([...document.querySelectorAll("[data-picked]")].map((c) => c.getAttribute("data-picked"))).toEqual(["acceptance"]);
    expect(after.querySelector('[data-picked="acceptance"]')).not.toBeNull();
  });

  it("says a Task at a hold moves on by hand: Legal on the line to Publish, a parked Backlog to Build", async () => {
    const { unmount } = render(<Selecting tasks={[waiting(5, "legal", 3)]} workflow={NEWS} initial="k-5" />);
    expect(strip("DARK-5")).toHaveTextContent("next: by hand → Publish");
    unmount();
    render(<Selecting tasks={[waiting(6, "backlog", 3)]} initial="k-6" />);
    expect(strip("DARK-6")).toHaveTextContent("next: by hand → Build");
  });

  it("selecting a second chip while one is selected moves the focus into the new strip", async () => {
    render(<Selecting tasks={VF7} />);
    await userEvent.click(chip("DARK-21"));
    await userEvent.click(chip("DARK-19"));
    expect(strip("DARK-21")).toBeNull();
    expect(strip("DARK-19")).toContainElement(document.activeElement as HTMLElement);
  });

  it("keeps the focus where the viewer put it when the Task they picked moves on in a live update", async () => {
    const { rerender } = render(<Selecting tasks={VF7} />);
    await userEvent.click(chip("DARK-21"));
    const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
    elsewhere.focus();
    rerender(<Selecting tasks={[held(21, "review", "builder", 1), waiting(28, "build", 2), held(19, "review", "reviewer", 6)]} />);
    expect(strip("DARK-21")).toHaveTextContent("next: pass → Done");
    expect(elsewhere).toHaveFocus();
  });

  it("focuses the strip itself, never its action, when the line opens no peek", async () => {
    const tasks = [waiting(27, "build", 30), waiting(22, "build", 3, { blockers: [{ id: "k-27", key: "DARK-27", title: "Task 27" }] })];
    render(<Selecting tasks={tasks} takeable={["k-27"]} open={false} />);
    await userEvent.click(line().querySelector<HTMLElement>('button[data-count="build"]')!);
    await userEvent.click(within(screen.getByRole("group", { name: /^Build · / })).getByRole("button", { name: /^DARK-22 / }));
    expect(within(strip("DARK-22")!).getByRole("button", { name: "Claim DARK-27" })).not.toHaveFocus();
    expect(strip("DARK-22")).toHaveFocus();
  });

  it("gives the focus to the line when the selected Task leaves it", async () => {
    const { rerender } = render(<Selecting tasks={VF7} />);
    await userEvent.click(chip("DARK-21"));
    rerender(<Selecting tasks={VF7.filter((x) => x.id !== "k-21")} />);
    expect(strip("DARK-21")).toBeNull();
    expect(line()).toHaveFocus();
  });

  it("× clears the selection and returns the focus to the chip", async () => {
    render(<Selecting tasks={VF7} />);
    await userEvent.click(chip("DARK-21"));
    await userEvent.click(within(strip("DARK-21")!).getByRole("button", { name: "Clear" }));
    expect(strip("DARK-21")).toBeNull();
    expect(chip("DARK-21")).toHaveFocus();
    expect(line().querySelector("[data-dim]")).toBeNull();
  });

  it("Escape clears it; a waiting Task chosen from its Step's list gives the focus back to the Step's count", async () => {
    render(<Selecting tasks={VF7} />);
    await userEvent.click(line().querySelector<HTMLElement>('button[data-count="build"]')!);
    await userEvent.click(within(screen.getByRole("group", { name: /^Build · / })).getByRole("button", { name: /^DARK-28 / }));
    expect(strip("DARK-28")).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard("{Escape}");
    expect(strip("DARK-28")).toBeNull();
    expect(line().querySelector('button[data-count="build"]')).toHaveFocus();
  });

  it("leaves the selection alone when a Step's list took the Escape", async () => {
    render(<Selecting tasks={VF7} />);
    await userEvent.click(chip("DARK-21"));
    await userEvent.click(line().querySelector<HTMLElement>('button[data-count="build"]')!);
    expect(screen.getByRole("group", { name: /^Build · / })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /^Build · / })).toBeNull();
    expect(strip("DARK-21")).not.toBeNull();
  });

  it("a blocked Task's strip says when it unblocks and what comes first, with its button; its chain is ringed on the line", async () => {
    const tasks = [held(21, "build", "builder", 18), waiting(27, "build", 30), waiting(22, "build", 3, { blockers: [{ id: "k-27", key: "DARK-27", title: "Task 27" }] })];
    render(<Selecting tasks={tasks} initial="k-22" takeable={["k-27"]} />);
    const s = strip("DARK-22")!;
    expect(s).toHaveTextContent("next: pass → Review");
    expect(s).toHaveTextContent("Unblocks when DARK-27 ends");
    expect(s).toHaveTextContent("First: take DARK-27");
    expect(within(s).getByRole("button", { name: "Claim DARK-27" })).toBeInTheDocument();
    // DARK-27 waits in Build's count: the count is ringed and stays in full ink.
    const count = line().querySelector('button[data-count="build"]');
    expect(count).toHaveAttribute("data-ringed");
    expect(dimmed(count)).toBe(false);
  });

  it("says there is nothing for the viewer, with no button, when nothing in the chain is theirs to do", async () => {
    const tasks = [waiting(27, "build", 30), waiting(22, "build", 3, { blockers: [{ id: "k-27", key: "DARK-27", title: "Task 27" }] })];
    render(<Selecting tasks={tasks} initial="k-22" />);
    const s = strip("DARK-22")!;
    expect(s).toHaveTextContent("First: nothing for you");
    expect(within(s).queryByRole("button", { name: /^Claim/ })).toBeNull();
  });
});

describe("a narrow line (a list column, a phone: under 768px)", () => {
  /** The line root measures `width` wide; every other box keeps jsdom's. */
  const atWidth = (width: number) => {
    const plain = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-line-root") ? new DOMRect(0, 0, width, 600) : plain.call(this);
    });
  };
  afterEach(() => vi.restoreAllMocks());
  /** A station's name row: the first cell of its grid. */
  const nameRow = (id: string) => rail().querySelector<HTMLElement>(`li[data-station="${id}"] > div:not([data-segment])`)!.firstElementChild as HTMLElement;
  const kinds = (row: HTMLElement) => [...row.children].map((el) => (el.hasAttribute("data-return") ? "return" : el.hasAttribute("data-facts") ? "facts" : el.hasAttribute("data-today") ? "today" : el.textContent));

  it("puts a return's label beside the Step's name and the facts on their own row under it (vf-8's columns, vf-10)", () => {
    atWidth(390);
    render(<WorkflowLine workflow={DARK("impl")} tasks={[]} now={0} doneToday={3} />);
    expect(kinds(nameRow("review"))).toEqual(["Review", "return", "facts"]);
    // The label's words as the column draws them; its hover still names where it leads.
    const label = nameRow("review").querySelector("[data-return]")!;
    expect(label).toHaveTextContent(/^↩ needs changes$/);
    expect(label).toHaveAttribute("data-hint", expect.stringContaining("Review → Build"));
    expect(nameRow("review").querySelector("[data-facts]")).toHaveTextContent("review");
    expect(kinds(nameRow("done"))).toEqual(["Done", "today"]);
    expect(nameRow("done").querySelector("[data-today]")).toHaveTextContent("3 today");
  });

  it("wide, keeps the facts beside the name and the label with the marks", () => {
    atWidth(1100);
    render(<WorkflowLine workflow={DARK("impl")} tasks={[]} now={0} doneToday={3} />);
    expect(kinds(nameRow("review"))).toEqual(["Review", "facts"]);
    const label = rail().querySelector('li[data-station="review"] [data-return]')!;
    expect(nameRow("review").contains(label)).toBe(false);
    expect(label).toHaveTextContent(/^↩ needs changes → Build$/);
    expect(kinds(nameRow("done"))).toEqual(["Done", "today"]);
  });
});
