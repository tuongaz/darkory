// useFilterState and its wire format, ported from enably-v2's use-filter-state tests.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { parseFilter, serializeFilter, useFilterState } from "./filterState";

function Probe({ entity = "tasks" }: { entity?: string }) {
  const location = useLocation();
  const f = useFilterState(entity);
  return (
    <div>
      <output data-testid="search">{location.search}</output>
      <output data-testid="pills">{JSON.stringify(f.pills)}</output>
      <button onClick={() => f.setFilter({ field: "status", op: "in", values: ["st-todo"] })}>set-status</button>
      <button onClick={() => f.setFilter({ field: "q", op: "contains", values: ["Smith, J"] })}>set-comma</button>
      <button onClick={() => f.removeFilter("status")}>remove-status</button>
      <button onClick={() => f.clearAll()}>clear-all</button>
      <button onClick={() => f.replaceAll([{ field: "status", op: "is", values: ["st-done"] }])}>replace-all</button>
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
    renderAt("/teams/WEB/tasks?view=board&task=WEB-3");
    await userEvent.click(screen.getByText("set-status"));
    expect(search()).toContain("view=board");
    expect(search()).toContain("task=WEB-3");
    expect(pills()).toEqual([{ field: "status", op: "in", values: ["st-todo"] }]);
  });

  it("reads its pills from the address", () => {
    renderAt("/x?filter.tasks=status%3Ain%3Ast-todo%2Cst-done");
    expect(pills()).toEqual([{ field: "status", op: "in", values: ["st-todo", "st-done"] }]);
  });

  it("keeps each list's pills under its own name", async () => {
    renderAt("/x?filter.features=state%3Ais%3Aopen");
    await userEvent.click(screen.getByText("set-status"));
    expect(search()).toContain("filter.tasks=");
    expect(search()).toContain("filter.features=");
    expect(pills()).toEqual([{ field: "status", op: "in", values: ["st-todo"] }]);
  });

  it("replaces the pill on the same field rather than adding a second", async () => {
    renderAt("/x?filter.tasks=status%3Ais%3Ast-done");
    await userEvent.click(screen.getByText("set-status"));
    expect(pills()).toEqual([{ field: "status", op: "in", values: ["st-todo"] }]);
  });

  it("removes one pill and leaves the others", async () => {
    renderAt("/x?filter.tasks=status%3Ais%3Ast-done&filter.tasks=skill%3Ais%3As-build");
    await userEvent.click(screen.getByText("remove-status"));
    expect(pills()).toEqual([{ field: "skill", op: "is", values: ["s-build"] }]);
  });

  it("clears every pill and leaves the rest of the address", async () => {
    renderAt("/x?filter.tasks=status%3Ais%3Ast-done&view=list");
    await userEvent.click(screen.getByText("clear-all"));
    expect(pills()).toEqual([]);
    expect(search()).toBe("?view=list");
  });

  it("replaces every pill in one write", async () => {
    renderAt("/x?filter.tasks=holder%3Ais%3Am-ada&filter.tasks=status%3Ain%3Ast-todo");
    await userEvent.click(screen.getByText("replace-all"));
    expect(pills()).toEqual([{ field: "status", op: "is", values: ["st-done"] }]);
  });

  it("sets two axes one after the other", async () => {
    renderAt("/x");
    await act(async () => screen.getByText("set-status").click());
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
    expect(serializeFilter({ field: "status", op: "in", values: ["a", "b"] })).toBe("status:in:a,b");
  });

  it("carries a date's offset through", () => {
    const pill = { field: "filed_at", op: "btw", values: ["2026-10-04T00:00:00.000+11:00", "2026-10-06T23:59:59.999+11:00"] };
    expect(serializeFilter(pill)).toBe("filed_at:btw:2026-10-04T00%3A00%3A00.000%2B11%3A00,2026-10-06T23%3A59%3A59.999%2B11%3A00");
    expect(parseFilter(serializeFilter(pill))).toEqual(pill);
  });

  it("round-trips", () => {
    for (const pill of [
      { field: "status", op: "in", values: ["st-todo", "st-done"] },
      { field: "q", op: "contains", values: ["a:b,c%d"] },
      { field: "filed_at", op: "last", values: ["7d"] },
    ]) {
      expect(parseFilter(serializeFilter(pill))).toEqual(pill);
    }
  });

  it("refuses a malformed token rather than throwing mid-render", () => {
    expect(parseFilter("justafield")).toBeNull();
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("status:is:")).toBeNull();
    expect(() => parseFilter("status:is:%")).not.toThrow();
    expect(parseFilter("status:is:%")).toBeNull();
    expect(parseFilter("status:is:%zz")).toBeNull();
    // One bad value refuses the whole token, not just its own slot.
    expect(parseFilter("status:is:ok,%")).toBeNull();
  });

  it("keeps an encoded colon in a value, and reads + as itself", () => {
    expect(parseFilter("q:contains:a%3Ab")).toEqual({ field: "q", op: "contains", values: ["a:b"] });
    expect(parseFilter("q:contains:a+b")).toEqual({ field: "q", op: "contains", values: ["a+b"] });
  });
});
