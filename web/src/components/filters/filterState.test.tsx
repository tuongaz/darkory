// useFilterState and its wire format, ported from enably-v2's use-filter-state tests.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { parseFilter, serializeFilter, stepFilterSearch, useFilterState } from "./filterState";

function Probe({ entity = "tasks" }: { entity?: string }) {
  const location = useLocation();
  const f = useFilterState(entity);
  return (
    <div>
      <output data-testid="search">{location.search}</output>
      <output data-testid="pills">{JSON.stringify(f.pills)}</output>
      <button onClick={() => f.setFilter({ field: "step", op: "in", values: ["st-build"] })}>set-step</button>
      <button onClick={() => f.setFilter({ field: "q", op: "contains", values: ["Smith, J"] })}>set-comma</button>
      <button onClick={() => f.removeFilter("step")}>remove-step</button>
      <button onClick={() => f.clearAll()}>clear-all</button>
      <button onClick={() => f.replaceAll([{ field: "step", op: "is", values: ["st-done"] }])}>replace-all</button>
    </div>
  );
}

function renderAt(url: string, entity = "tasks") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Probe entity={entity} />
    </MemoryRouter>,
  );
}

const search = () => screen.getByTestId("search").textContent ?? "";
const pills = () => JSON.parse(screen.getByTestId("pills").textContent || "[]");

describe("useFilterState", () => {
  it("keeps the other parameters when a filter changes", async () => {
    renderAt("/projects/WEB/tasks?view=board&task=WEB-3");
    await userEvent.click(screen.getByText("set-step"));
    expect(search()).toContain("view=board");
    expect(search()).toContain("task=WEB-3");
    expect(pills()).toEqual([{ field: "step", op: "in", values: ["st-build"] }]);
  });

  it("reads its pills from the address", () => {
    renderAt("/x?filter.tasks=step%3Ain%3Ast-build%2Cst-done");
    expect(pills()).toEqual([{ field: "step", op: "in", values: ["st-build", "st-done"] }]);
  });

  it("keeps each list's pills under its own name", async () => {
    renderAt("/x?filter.members=kind%3Ais%3Aagent");
    await userEvent.click(screen.getByText("set-step"));
    expect(search()).toContain("filter.tasks=");
    expect(search()).toContain("filter.members=");
    expect(pills()).toEqual([{ field: "step", op: "in", values: ["st-build"] }]);
  });

  it("replaces the pill on the same field rather than adding a second", async () => {
    renderAt("/x?filter.tasks=step%3Ais%3Ast-done");
    await userEvent.click(screen.getByText("set-step"));
    expect(pills()).toEqual([{ field: "step", op: "in", values: ["st-build"] }]);
  });

  it("removes one pill and leaves the others", async () => {
    renderAt("/x?filter.tasks=step%3Ais%3Ast-done&filter.tasks=skill%3Ais%3As-build");
    await userEvent.click(screen.getByText("remove-step"));
    expect(pills()).toEqual([{ field: "skill", op: "is", values: ["s-build"] }]);
  });

  it("clears every pill and leaves the rest of the address", async () => {
    renderAt("/x?filter.tasks=step%3Ais%3Ast-done&view=list");
    await userEvent.click(screen.getByText("clear-all"));
    expect(pills()).toEqual([]);
    expect(search()).toBe("?view=list");
  });

  it("replaces every pill in one write", async () => {
    renderAt("/x?filter.tasks=holder%3Ais%3Am-ada&filter.tasks=step%3Ain%3Ast-build");
    await userEvent.click(screen.getByText("replace-all"));
    expect(pills()).toEqual([{ field: "step", op: "is", values: ["st-done"] }]);
  });

  it("sets two axes one after the other", async () => {
    renderAt("/x");
    await act(async () => screen.getByText("set-step").click());
    await act(async () => screen.getByText("set-comma").click());
    expect(pills()).toHaveLength(2);
  });
});

describe("the wire format", () => {
  it("percent-encodes a value carrying a delimiter", () => {
    expect(serializeFilter({ field: "q", op: "contains", values: ["Smith, J"] })).toBe("q:contains:Smith%2C%20J");
    expect(serializeFilter({ field: "q", op: "contains", values: ["a:b"] })).toBe("q:contains:a%3Ab");
    expect(serializeFilter({ field: "q", op: "contains", values: ["50%"] })).toBe("q:contains:50%25");
  });

  it("joins several values with commas", () => {
    expect(serializeFilter({ field: "step", op: "in", values: ["a", "b"] })).toBe("step:in:a,b");
  });

  it("carries a date's offset through", () => {
    const pill = { field: "filed_at", op: "btw", values: ["2026-10-04T00:00:00.000+11:00", "2026-10-06T23:59:59.999+11:00"] };
    expect(serializeFilter(pill)).toBe("filed_at:btw:2026-10-04T00%3A00%3A00.000%2B11%3A00,2026-10-06T23%3A59%3A59.999%2B11%3A00");
    expect(parseFilter(serializeFilter(pill))).toEqual(pill);
  });

  it("round-trips", () => {
    for (const pill of [
      { field: "step", op: "in", values: ["st-build", "st-done"] },
      { field: "q", op: "contains", values: ["a:b,c%d"] },
      { field: "filed_at", op: "last", values: ["7d"] },
    ]) {
      expect(parseFilter(serializeFilter(pill))).toEqual(pill);
    }
  });

  it("refuses a malformed token rather than throwing mid-render", () => {
    expect(parseFilter("justafield")).toBeNull();
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("step:is:")).toBeNull();
    expect(() => parseFilter("step:is:%")).not.toThrow();
    expect(parseFilter("step:is:%")).toBeNull();
    expect(parseFilter("step:is:%zz")).toBeNull();
    // One bad value refuses the whole token, not just its own slot.
    expect(parseFilter("step:is:ok,%")).toBeNull();
  });

  it("keeps an encoded colon in a value, and reads + as itself", () => {
    expect(parseFilter("q:contains:a%3Ab")).toEqual({ field: "q", op: "contains", values: ["a:b"] });
    expect(parseFilter("q:contains:a+b")).toEqual({ field: "q", op: "contains", values: ["a+b"] });
  });
});

describe("stepFilterSearch", () => {
  const read = (search: string) => new URLSearchParams(search).getAll("filter.tasks").map(parseFilter);
  it("names the Step, first", () => {
    expect(stepFilterSearch("st-build")).toBe(`filter.tasks=${encodeURIComponent("step:is:st-build")}`);
  });

  it("carries the other pills, one per field, the first of each winning, and drops any other Step", () => {
    const search = stepFilterSearch("st-build", [
      { field: "parent", op: "is", values: ["k-7"] },
      { field: "step", op: "in", values: ["st-qa", "st-review"] },
      { field: "blocked", op: "is", values: ["true"] },
      { field: "parent", op: "is", values: ["k-9"] },
    ]);
    expect(read(search)).toEqual([
      { field: "step", op: "is", values: ["st-build"] },
      { field: "parent", op: "is", values: ["k-7"] },
      { field: "blocked", op: "is", values: ["true"] },
    ]);
  });
});

