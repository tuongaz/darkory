import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { quiet, type FlowState } from "@/components/workflow/live";
import { DARK } from "./fixtures";
import type { LineMember, LineTask } from "./model";
import { WorkflowLine } from "./WorkflowLine";

// The Tasks at a Step (vf-4, vf-1): its held Tasks as chips, at most three, then one count that
// opens the Step's list in place: the waiting Tasks oldest first, five, then the rest as a link to
// the Tasks list filtered to the Step. A Step with nothing shows nothing.

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

/** fixture.json's busy Build: builder holds DARK-21 (18m); DARK-28 … DARK-40 wait, 2m to 1h 28m. */
const ages = [2, 5, 9, 14, 21, 27, 33, 41, 48, 55, 62, 75, 88];
const BUSY: LineTask[] = [held(21, "build", "builder", 18), ...ages.map((a, i) => waiting(28 + i, "build", a)), held(19, "review", "reviewer", 6)];

const href = (stepId: string) => `/projects/DARK/tasks?filter.tasks=${encodeURIComponent(`step:is:${stepId}`)}`;
function draw(tasks: readonly LineTask[], flow?: FlowState, onSelect: (id: string | null) => void = () => {}) {
  return render(
    <MemoryRouter>
      <WorkflowLine workflow={DARK("impl")} tasks={tasks} now={NOW} stepHref={href} flow={flow} onSelect={onSelect} />
    </MemoryRouter>,
  );
}
const station = (id: string) => document.querySelector<HTMLElement>(`li[data-station="${id}"]`)!;
const chips = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("button[data-task]")].map((b) => b.getAttribute("data-task"));
const count = (el: HTMLElement) => el.querySelector<HTMLElement>("button[data-count]");

describe("the Tasks at a Step", () => {
  it("shows a Step's held Tasks as chips and the rest as one count, 'N waiting' (vf-4)", () => {
    draw(BUSY);
    expect(chips(station("build"))).toEqual(["DARK-21"]);
    const pill = count(station("build"))!;
    expect(pill).toHaveTextContent("13 waiting");
    expect(pill).toHaveAccessibleName("Build: 13 Tasks waiting");
    expect(pill).toHaveAttribute("aria-expanded", "false");
    // Review holds its one Task: a chip and no count.
    expect(chips(station("review"))).toEqual(["DARK-19"]);
    expect(count(station("review"))).toBeNull();
  });

  it("shows at most three held chips; past three the count reads 'N more' and holds the rest", () => {
    draw([held(1, "build", "a", 40), held(2, "build", "b", 30), held(3, "build", "c", 20), held(4, "build", "d", 10), waiting(5, "build", 3), waiting(6, "build", 1)]);
    expect(chips(station("build"))).toEqual(["DARK-1", "DARK-2", "DARK-3"]);
    expect(count(station("build"))).toHaveTextContent("3 more");
    expect(count(station("build"))).toHaveAccessibleName("Build: 3 more Tasks");
  });

  it("opens the Step's list in place on a click: the waiting Tasks oldest first, five, then 'N more Tasks' to the Tasks list at the Step", async () => {
    draw(BUSY);
    const pill = count(station("build"))!;
    await userEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("group", { name: "Build · 13 waiting" });
    expect(pill.getAttribute("aria-controls")).toBe(list.id);
    expect(station("build")).toContainElement(list);
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("data-task"))).toEqual(["DARK-40", "DARK-39", "DARK-38", "DARK-37", "DARK-36"]);
    expect(rows[0]).toHaveTextContent("DARK-40Task 401h 28m");
    expect(within(list).getByRole("link", { name: "8 more Tasks" })).toHaveAttribute("href", href("build"));
  });

  it("closes the list on a second click and on Escape", async () => {
    draw(BUSY);
    const pill = count(station("build"))!;
    await userEvent.click(pill);
    await userEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: /^Build · / })).toBeNull();
    await userEvent.click(pill);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /^Build · / })).toBeNull();
    expect(pill).toHaveFocus();
  });

  it("closes the list on Escape only from the count or the list, and leaves the selection alone", async () => {
    const calls: (string | null)[] = [];
    render(
      <MemoryRouter>
        <WorkflowLine workflow={DARK("impl")} tasks={BUSY} now={NOW} stepHref={href} selected="k-21" onSelect={(id) => calls.push(id)} />
        <input aria-label="elsewhere" />
      </MemoryRouter>,
    );
    await userEvent.click(count(station("build"))!);
    // An Escape typed elsewhere on the page is not the list's.
    screen.getByRole("textbox", { name: "elsewhere" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("group", { name: "Build · 13 waiting" })).toBeInTheDocument();
    // (There it clears the selection, as it always has.) From a row: the list closes, the selection stays.
    calls.length = 0;
    within(screen.getByRole("group", { name: "Build · 13 waiting" })).getAllByRole("button")[0].focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /^Build · / })).toBeNull();
    expect(count(station("build"))).toHaveFocus();
    expect(calls).toEqual([]);
  });

  it("keeps one list open on a line: opening another Step's closes the first, in 'Also starts here' too", async () => {
    draw([...BUSY, waiting(50, "backlog", 60), waiting(51, "backlog", 30)]);
    const backlog = document.querySelector<HTMLElement>('[data-side="backlog"]')!;
    // The hold's count reads like any other, with the hold's dashed glyph.
    expect(count(backlog)).toHaveTextContent("2 waiting");
    expect(count(backlog)!.querySelector("[data-state]")).toHaveAttribute("data-state", "hold");
    await userEvent.click(count(station("build"))!);
    await userEvent.click(count(backlog)!);
    expect(screen.queryByRole("group", { name: /^Build · / })).toBeNull();
    const list = screen.getByRole("group", { name: "Backlog · 2 waiting" });
    expect(within(list).getAllByRole("button").map((r) => r.getAttribute("data-task"))).toEqual(["DARK-50", "DARK-51"]);
    // Five or fewer: no link to the rest.
    expect(within(list).queryByRole("link")).toBeNull();
  });

  it("says what a blocked row waits on, and reads only where the line can select nothing", async () => {
    const tasks = [waiting(1, "build", 9, { blockers: [{ id: "k-27", key: "DARK-27", title: "Blocker" }] }), waiting(2, "build", 3)];
    render(
      <MemoryRouter>
        <WorkflowLine workflow={DARK("impl")} tasks={tasks} now={NOW} />
      </MemoryRouter>,
    );
    await userEvent.click(count(station("build"))!);
    const list = screen.getByRole("group", { name: "Build · 2 waiting" });
    expect(within(list).queryByRole("button")).toBeNull();
    expect(list.querySelector('[data-task="DARK-1"]')).toHaveTextContent("DARK-1Task 1blocked by DARK-279m");
  });

  it("closes a list whose count empties, and never opens it again on its own", async () => {
    const line = (tasks: readonly LineTask[]) => (
      <MemoryRouter>
        <WorkflowLine workflow={DARK("impl")} tasks={tasks} now={NOW} stepHref={href} onSelect={() => {}} />
      </MemoryRouter>
    );
    const { rerender } = render(line([waiting(1, "build", 9)]));
    await userEvent.click(count(station("build"))!);
    rerender(line([]));
    rerender(line([waiting(1, "build", 9)]));
    expect(count(station("build"))).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: /^Build · / })).toBeNull();
  });

  it("draws nothing at a Step with no Tasks", () => {
    draw(BUSY);
    const cell = station("done").querySelector("[data-tasks]")!;
    expect(cell.childElementCount).toBe(0);
    expect(count(station("done"))).toBeNull();
  });

  it("keeps a held Task's blocker on its chip, in red words", () => {
    draw([held(22, "plan", "planner", 3, { blockers: [{ id: "k-27", key: "DARK-27", title: "Blocker" }] })]);
    const chip = document.querySelector<HTMLElement>('[data-side="plan"] button[data-task="DARK-22"]')!;
    expect(chip).toHaveTextContent("blocked by DARK-27");
    expect(chip).toHaveAttribute("data-blocked");
  });

  it("stands a waiting Task as a chip while its live moment plays, then folds it into the count", () => {
    const arrived: FlowState = { ...quiet, arrived: new Set(["k-30"]) };
    const { rerender } = draw(BUSY, arrived);
    expect(chips(station("build"))).toEqual(["DARK-21", "DARK-30"]);
    expect(count(station("build"))).toHaveTextContent("12 waiting");
    rerender(
      <MemoryRouter>
        <WorkflowLine workflow={DARK("impl")} tasks={BUSY} now={NOW} stepHref={href} />
      </MemoryRouter>,
    );
    expect(chips(station("build"))).toEqual(["DARK-21"]);
    expect(count(station("build"))).toHaveTextContent("13 waiting");
  });

  it("pulses the count once when a Task folds into it, never on the first draw", () => {
    vi.useFakeTimers();
    try {
      const line = (flow?: FlowState) => (
        <MemoryRouter>
          <WorkflowLine workflow={DARK("impl")} tasks={BUSY} now={NOW} stepHref={href} flow={flow} />
        </MemoryRouter>
      );
      const { rerender } = render(line({ ...quiet, arrived: new Set(["k-30"]) }));
      expect(count(station("build"))).not.toHaveAttribute("data-pulse");
      rerender(line());
      expect(count(station("build"))).toHaveTextContent("13 waiting");
      expect(count(station("build"))).toHaveAttribute("data-pulse");
      act(() => vi.advanceTimersByTime(2_500));
      expect(count(station("build"))).not.toHaveAttribute("data-pulse");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pulses no count when Tasks reach it otherwise: a Filter or scope change, a refetch, a deselection", () => {
    const line = (tasks: readonly LineTask[], selected?: string) => (
      <MemoryRouter>
        <WorkflowLine workflow={DARK("impl")} tasks={tasks} now={NOW} stepHref={href} selected={selected} onSelect={() => {}} />
      </MemoryRouter>
    );
    // A Filter that let DARK-21 and a Review Task through, then cleared.
    const { rerender } = render(line([BUSY[0], waiting(50, "review", 3)], "k-30"));
    rerender(line(BUSY, "k-30"));
    expect(count(station("build"))).toHaveTextContent("12 waiting");
    expect(document.querySelector("[data-count][data-pulse]")).toBeNull();
    // Deselected, DARK-30 drops into the count without a pulse.
    rerender(line(BUSY));
    expect(count(station("build"))).toHaveTextContent("13 waiting");
    expect(document.querySelector("[data-count][data-pulse]")).toBeNull();
  });

  it("selects a waiting Task from its row, and the selected Task stands as a chip at its Step", async () => {
    let picked: string | null = null;
    const { rerender } = draw(BUSY, undefined, (id) => (picked = id));
    await userEvent.click(count(station("build"))!);
    await userEvent.click(within(screen.getByRole("group", { name: "Build · 13 waiting" })).getByRole("button", { name: /^DARK-38 / }));
    expect(picked).toBe("k-38");
    rerender(
      <MemoryRouter>
        <WorkflowLine workflow={DARK("impl")} tasks={BUSY} now={NOW} stepHref={href} selected="k-38" onSelect={() => {}} />
      </MemoryRouter>,
    );
    expect(chips(station("build"))).toContain("DARK-38");
  });
});
