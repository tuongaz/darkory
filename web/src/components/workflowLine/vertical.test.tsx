import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { wfId } from "@/test/fixtures";
import { BIG, DARK, FIVE, MAIN, NEWS, SOFTWARE } from "./fixtures";
import { lineTopology, tracks } from "./layout";
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
    expect(within(backlog).getByRole("button", { name: "DARK-30 Later, in the hold" })).toBeInTheDocument();
    expect(backlog.querySelector("[data-mark]")).toHaveTextContent("⇢ Build");
    const plan = group.querySelector<HTMLElement>('[data-side="plan"]')!;
    expect([...plan.querySelectorAll("[data-mark]")].map((m) => m.textContent)).toEqual(["● Done", "↳ Build"]);
    // Neither is a station on the rail.
    expect(stations(rail()).map((li) => li.getAttribute("data-station"))).toEqual(["build", "review", "done"]);
  });

  it("takes a Step that stands before the start: BIG's Backlog, its pass into Triage by hand", () => {
    render(<WorkflowLine workflow={BIG} tasks={[]} now={0} />);
    const group = screen.getByRole("region", { name: "Also starts here" });
    expect(group.querySelector('[data-side="backlog"] [data-mark]')).toHaveTextContent("⇢ pass → Triage");
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
    // No Connector of the branch is drawn on the main rail.
    for (const id of ["retro:done", "retro:propose", "skillreview:publish", "skillreview:needs changes", "acceptance:pass"]) expect(mainRail.querySelector(`[data-connector="${id}"]`), id).toBeNull();
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
    for (const wf of [DARK("retros"), MAIN, FIVE(wfId.triage)]) {
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
