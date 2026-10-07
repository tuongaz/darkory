// A View ↔ the pills, and the Views control, ported from enably's saved-views tests.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FilterField } from "./operators";
import { sameFilters, viewPills, viewTokens } from "./views";
import { ViewsMenu, type ViewsMenuProps } from "./ViewsMenu";

const fields: FilterField[] = [
  { key: "status", type: "enum", ops: ["is", "not", "in", "nin"], label: "Status" },
  { key: "q", type: "text", ops: ["contains"], label: "Search" },
];

describe("a View's tokens and the pills", () => {
  it("saves the address's own tokens, each value encoded", () => {
    expect(viewTokens([{ field: "status", op: "in", values: ["st-a", "st-b"] }, { field: "q", op: "contains", values: ["a,b"] }])).toEqual([
      "status:in:st-a,st-b",
      "q:contains:a%2Cb",
    ]);
  });

  it("reads tokens back as pills, dropping what the list cannot apply", () => {
    expect(viewPills(["status:nin:st-a,st-b", "q:contains:cart%20page", "colour:is:red", "status:btw:x,y", "nonsense"], fields)).toEqual([
      { field: "status", op: "nin", values: ["st-a", "st-b"] },
      { field: "q", op: "contains", values: ["cart page"] },
    ]);
  });

  it("round-trips the pills", () => {
    const pills = [{ field: "status", op: "is", values: ["st-a"] }];
    expect(viewPills(viewTokens(pills), fields)).toEqual(pills);
  });

  it("compares tokens whatever their order, or the order of a token's values", () => {
    expect(sameFilters(["status:in:a,b", "q:contains:x"], ["q:contains:x", "status:in:b,a"])).toBe(true);
    expect(sameFilters(["status:in:a,b"], ["status:nin:a,b"])).toBe(false);
    expect(sameFilters(["status:is:a"], ["status:is:a", "q:contains:x"])).toBe(false);
    expect(sameFilters([], [])).toBe(true);
  });
});

function setup(props: Partial<ViewsMenuProps> = {}) {
  const handlers = {
    onApply: vi.fn(),
    onSaveNew: vi.fn(async () => true),
    onOverwrite: vi.fn(async () => true),
    onDelete: vi.fn(),
    onClearError: vi.fn(),
  };
  render(
    <ViewsMenu
      views={[
        { id: "v-1", name: "My open work" },
        { id: "v-2", name: "Blocked builds" },
      ]}
      appliedId={undefined}
      edited={false}
      error={null}
      saving={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

const open = () => userEvent.click(screen.getByRole("button", { name: "Views" }));

describe("the Views control", () => {
  it("lists the Member's Views and applies one", async () => {
    const { onApply } = setup();
    await open();
    await userEvent.click(screen.getByRole("option", { name: /Blocked builds/ }));
    expect(onApply).toHaveBeenCalledWith("v-2");
    expect(screen.queryByRole("option", { name: /My open work/ })).not.toBeInTheDocument();
  });

  it("saves the list under a typed name, then closes", async () => {
    const { onSaveNew } = setup();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Save as view…" }));
    await userEvent.type(screen.getByRole("textbox", { name: "View name" }), "  Mine  ");
    await userEvent.click(screen.getByRole("button", { name: "Save View" }));
    expect(onSaveNew).toHaveBeenCalledWith("Mine");
    expect(screen.queryByRole("textbox", { name: "View name" })).not.toBeInTheDocument();
  });

  it("keeps the form and the typed name up beside a refusal", async () => {
    const onSaveNew = vi.fn(async () => false);
    setup({ onSaveNew, error: "You already have a View named “Mine” for this list." });
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Save as view…" }));
    await userEvent.type(screen.getByRole("textbox", { name: "View name" }), "Mine");
    await userEvent.click(screen.getByRole("button", { name: "Save View" }));
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue("Mine");
    expect(screen.getByRole("alert")).toHaveTextContent("already have a View named");
  });

  it("deletes and overwrites from a row without applying it", async () => {
    const { onApply, onDelete, onOverwrite } = setup();
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Delete My open work" }));
    expect(onDelete).toHaveBeenCalledWith("v-1");
    await userEvent.click(screen.getByRole("button", { name: "Overwrite Blocked builds" }));
    expect(onOverwrite).toHaveBeenCalledWith("v-2");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("offers nothing to save, nor to overwrite, while the list is the applied View as it was", async () => {
    setup({ appliedId: "v-1" });
    await open();
    expect(screen.queryByRole("button", { name: "Save as view…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overwrite My open work" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overwrite Blocked builds" })).toBeInTheDocument();
  });

  it("marks the applied View edited once the pills differ, and offers to save or overwrite it", async () => {
    setup({ appliedId: "v-1", edited: true });
    await open();
    expect(screen.getByRole("option", { name: /My open work/ })).toHaveTextContent("edited");
    expect(screen.getByRole("button", { name: "Save as view…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overwrite My open work" })).toBeInTheDocument();
  });

  it("says in plain words that there are none yet", async () => {
    setup({ views: [] });
    await open();
    expect(screen.getByText("No Views yet.")).toBeInTheDocument();
  });
});
