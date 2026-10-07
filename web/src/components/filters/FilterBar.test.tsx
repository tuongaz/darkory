// The Filter's button, menu and chips, ported from enably-v2's FilterBar tests: what a pick writes,
// what a chip says, and the operator the person may choose.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterChipRow, FilterMenuButton, type FilterBarProps } from "./FilterBar";
import type { FilterPill } from "./filterState";
import type { FilterField, FilterOption } from "./operators";

const polarity = ["is", "not", "in", "nin"];
const status: FilterField = { key: "status", type: "enum", ops: polarity, label: "Status" };
const holder: FilterField = { key: "holder", type: "ref", ops: polarity, label: "Held by" };
const aimed: FilterField = { key: "aimed_at", type: "ref", ops: ["is", "not", "in"], label: "Aimed at" };
const blocked: FilterField = { key: "blocked", type: "boolean", ops: ["is"], label: "Blocked" };
const search: FilterField = { key: "q", type: "text", ops: ["contains"], label: "Search" };

const options: Record<string, FilterOption[]> = {
  status: [
    { value: "st-todo", label: "Todo", group: "todo" },
    { value: "st-progress", label: "In progress", group: "in_progress", groupLabel: "Being worked" },
    { value: "st-done", label: "Done", group: "done" },
  ],
  holder: [
    { value: "none", label: "Nobody" },
    { value: "m-ada", label: "ada", hint: "Me" },
    { value: "m-builder", label: "builder" },
  ],
  aimed_at: [
    { value: "m-ada", label: "ada" },
    { value: "m-bob", label: "bob" },
  ],
  blocked: [
    { value: "true", label: "Blocked" },
    { value: "false", label: "Not blocked" },
  ],
};

function setup(props: Partial<FilterBarProps & { stacked: boolean }> = {}) {
  const onSetFilter = vi.fn();
  const onRemoveFilter = vi.fn();
  const onClearAll = vi.fn();
  const bar: FilterBarProps = {
    fields: [status, holder, aimed, blocked, search],
    pills: [],
    optionsFor: (field) => options[field],
    onSetFilter,
    onRemoveFilter,
    onClearAll,
    ...props,
  };
  render(
    <>
      <FilterMenuButton {...bar} />
      <FilterChipRow {...bar} stacked={props.stacked} />
    </>,
  );
  return { onSetFilter, onRemoveFilter, onClearAll };
}

const set = (field: string, op: string, ...values: string[]): FilterPill => ({ field, op, values });
/** An axis' value segment, named "<axis>: <value>". */
const valueSegment = (axis: string) => screen.getByRole("button", { name: new RegExp(`^${axis}: `) });
/** An axis' operator segment, named "<axis> — <operator>". */
const operatorSegment = (axis: string) => screen.getByRole("button", { name: new RegExp(`^${axis} — `) });
const openMenu = () => userEvent.click(screen.getByRole("button", { name: /^Filter/ }));

describe("the Filter", () => {
  it("is a button alone while nothing is set", () => {
    setup();
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("shows a set axis as a chip, counts it on the button, and folds it out of the menu", async () => {
    setup({ pills: [set("status", "is", "st-todo")] });
    expect(valueSegment("Status")).toHaveAccessibleName("Status: Todo");
    expect(screen.getByRole("button", { name: "Filter, 1 set" })).toHaveTextContent("1");
    await openMenu();
    expect(screen.queryByRole("option", { name: "Status" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Held by" })).toBeInTheDocument();
  });

  it("does not count or draw a pill for an axis the page does not have", () => {
    setup({ pills: [set("colour", "is", "red")] });
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("commits is from the menu's axis page, and stays open for a second value", async () => {
    const { onSetFilter } = setup();
    await openMenu();
    await userEvent.click(screen.getByRole("option", { name: "Status" }));
    await userEvent.click(await screen.findByRole("option", { name: "Todo" }));
    expect(onSetFilter).toHaveBeenCalledWith(set("status", "is", "st-todo"));
    expect(screen.getByRole("option", { name: "Done" })).toBeInTheDocument();
  });

  it("promotes a second value to is one of", async () => {
    const { onSetFilter } = setup({ pills: [set("status", "is", "st-todo")] });
    await userEvent.click(valueSegment("Status"));
    await userEvent.click(await screen.findByRole("option", { name: "Done" }));
    expect(onSetFilter).toHaveBeenCalledWith(set("status", "in", "st-todo", "st-done"));
  });

  it("goes back to is when one value is left", async () => {
    const { onSetFilter } = setup({ pills: [set("status", "in", "st-todo", "st-done")] });
    await userEvent.click(valueSegment("Status"));
    await userEvent.click(await screen.findByRole("option", { name: "Done" }));
    expect(onSetFilter).toHaveBeenCalledWith(set("status", "is", "st-todo"));
  });

  it("clears the axis when its last value is unticked, rather than writing an empty one", async () => {
    const { onSetFilter, onRemoveFilter } = setup({ pills: [set("status", "is", "st-todo")] });
    await userEvent.click(valueSegment("Status"));
    await userEvent.click(await screen.findByRole("option", { name: "Todo" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("status");
    expect(onSetFilter).not.toHaveBeenCalled();
  });

  it("clears the axis from All", async () => {
    const { onRemoveFilter } = setup({ pills: [set("status", "is", "st-todo")] });
    await userEvent.click(valueSegment("Status"));
    await userEvent.click(await screen.findByRole("option", { name: "All" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("status");
  });

  it("commits and closes an axis that takes one value", async () => {
    const { onSetFilter } = setup();
    await openMenu();
    await userEvent.click(screen.getByRole("option", { name: "Blocked" }));
    await userEvent.click(await screen.findByRole("option", { name: "Not blocked" }));
    expect(onSetFilter).toHaveBeenCalledWith(set("blocked", "is", "false"));
    expect(screen.queryByRole("option", { name: "Blocked" })).not.toBeInTheDocument();
  });

  it("reads several values as the first and +N", () => {
    setup({ pills: [set("status", "in", "st-todo", "st-progress", "st-done")] });
    expect(valueSegment("Status")).toHaveAccessibleName("Status: Todo +2");
  });

  it("keeps a value no option names as a row, so it can be unticked", async () => {
    const { onRemoveFilter } = setup({ pills: [set("holder", "is", "m-gone")] });
    expect(valueSegment("Held by")).toHaveAccessibleName("Held by: m-gone");
    await userEvent.click(valueSegment("Held by"));
    await userEvent.click(await screen.findByRole("option", { name: "m-gone" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("holder");
  });

  it("sets the values of each group apart, headed where the group has a name", async () => {
    setup();
    await openMenu();
    await userEvent.click(screen.getByRole("option", { name: "Status" }));
    expect(await screen.findByText("Being worked", { selector: "[cmdk-group-heading]" })).toBeInTheDocument();
    expect(document.querySelectorAll("[cmdk-group-heading]")).toHaveLength(1);
    expect(document.querySelectorAll("[cmdk-separator]")).toHaveLength(2);
  });

  it("clears one axis from its chip's ×, and every axis from Reset", async () => {
    const { onRemoveFilter, onClearAll } = setup({ pills: [set("status", "is", "st-todo"), set("holder", "is", "none")] });
    await userEvent.click(screen.getByRole("button", { name: "Clear Status" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("status");
    await userEvent.click(within(screen.getByRole("toolbar", { name: "Filters" })).getByRole("button", { name: "Reset" }));
    expect(onClearAll).toHaveBeenCalled();
  });

  it("drills into an axis with the arrows and Enter, not Enter alone", async () => {
    setup();
    await openMenu();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: /Filters$/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    // Back to the list, and the axis' own name beside it.
    expect(await screen.findByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByText("Held by")).toBeInTheDocument();
  });

  it("offers a search over the axes past eight of them", async () => {
    const many = Array.from({ length: 9 }, (_, i): FilterField => ({ key: `f${i}`, type: "enum", ops: ["is"], label: `Axis ${i}` }));
    setup({ fields: many });
    await openMenu();
    await userEvent.type(screen.getByPlaceholderText("Filter by…"), "Axis 7");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Axis 7"]);
  });
});

describe("Search", () => {
  it("is the menu's first field, written as q:contains as it is typed", async () => {
    const { onSetFilter } = setup();
    await openMenu();
    const box = screen.getByRole("searchbox", { name: "Search" });
    expect(box).toHaveFocus();
    await userEvent.type(box, "ca");
    expect(onSetFilter).toHaveBeenLastCalledWith(set("q", "contains", "ca"));
  });

  it("shows a live search as a chip, whose × clears it", async () => {
    const { onRemoveFilter } = setup({ pills: [set("q", "contains", "cart")] });
    expect(screen.getByRole("button", { name: "Search: cart" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear Search" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("q");
  });

  it("removes the axis when the field is emptied", async () => {
    const { onRemoveFilter } = setup({ pills: [set("q", "contains", "c")] });
    await userEvent.click(screen.getByRole("button", { name: "Search: c" }));
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("q");
  });
});

describe("choosing the operator", () => {
  it("offers the four operators the axis takes", async () => {
    setup({ pills: [set("status", "is", "st-todo")] });
    await userEvent.click(operatorSegment("Status"));
    expect(screen.getAllByRole("option").map((o) => o.querySelector("span")?.textContent)).toEqual(["is", "is not", "is one of", "is none of"]);
  });

  it("disables the singular operators while several values are set, and says why", async () => {
    setup({ pills: [set("status", "in", "st-todo", "st-done")] });
    expect(operatorSegment("Status")).toHaveAccessibleName("Status — is one of");
    await userEvent.click(operatorSegment("Status"));
    for (const name of ["is", "is not"]) {
      const row = screen.getByRole("option", { name });
      expect(row).toHaveAttribute("aria-disabled", "true");
      expect(row).toHaveAccessibleDescription("one value only");
    }
  });

  it("flips the sign and keeps the values", async () => {
    const { onSetFilter } = setup({ pills: [set("status", "in", "st-todo", "st-done")] });
    await userEvent.click(operatorSegment("Status"));
    await userEvent.click(screen.getByRole("option", { name: "is none of" }));
    expect(onSetFilter).toHaveBeenCalledWith(set("status", "nin", "st-todo", "st-done"));
  });

  it("writes an unset axis as is not in one gesture, with one write", async () => {
    const { onSetFilter } = setup();
    await openMenu();
    await userEvent.click(screen.getByRole("option", { name: "Held by" }));
    await userEvent.click(operatorSegment("Held by"));
    await userEvent.click(await screen.findByRole("option", { name: "is not" }));
    await userEvent.click(await screen.findByRole("option", { name: "Nobody" }));
    expect(onSetFilter).toHaveBeenCalledTimes(1);
    expect(onSetFilter).toHaveBeenCalledWith(set("holder", "not", "none"));
  });

  it("replaces the value under is not where the axis has no is none of", async () => {
    const { onSetFilter } = setup({ pills: [set("aimed_at", "not", "m-ada")] });
    await userEvent.click(valueSegment("Aimed at"));
    await userEvent.click(await screen.findByRole("option", { name: "bob" }));
    expect(onSetFilter).toHaveBeenCalledWith(set("aimed_at", "not", "m-bob"));
  });

  it("draws no operator on an axis that takes one", () => {
    setup({ pills: [set("blocked", "is", "true")] });
    expect(screen.queryByRole("button", { name: /^Blocked — / })).not.toBeInTheDocument();
  });
});

describe("on a phone", () => {
  it("gives each chip a line of its own, each with its ×", async () => {
    const { onRemoveFilter } = setup({ stacked: true, pills: [set("status", "is", "st-todo"), set("holder", "is", "none")] });
    const row = screen.getByRole("toolbar", { name: "Filters" });
    expect(row).toHaveClass("flex-col");
    expect(valueSegment("Status").closest("div")).toHaveClass("w-full");
    await userEvent.click(screen.getByRole("button", { name: "Clear Held by" }));
    expect(onRemoveFilter).toHaveBeenCalledWith("holder");
  });
});
