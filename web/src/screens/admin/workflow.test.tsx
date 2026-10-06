import { describe, expect, it } from "vitest";
import type { components } from "@/api/schema.gen";
import { insertAt, moveTargets, problem, rowsOf, setStatusesBody, type Row } from "./workflow";

type Status = components["schemas"]["Status"];

const current: Status[] = [
  { id: "st-backlog", name: "Backlog", kind: "backlog", position: 1 },
  { id: "st-todo", name: "Todo", kind: "todo", position: 2 },
  { id: "st-progress", name: "In progress", kind: "in_progress", position: 3 },
  { id: "st-review", name: "In review", kind: "in_progress", position: 4 },
  { id: "st-done", name: "Done", kind: "done", position: 5 },
  { id: "st-dropped", name: "Dropped", kind: "dropped", position: 6 },
];
const counts = new Map([
  ["st-todo", 5],
  ["st-review", 2],
  ["st-done", 6],
]);
const rows = () => rowsOf(current);
const without = (id: string) => rows().filter((r) => r.id !== id);
const edit = (id: string, change: Partial<Row>) => rows().map((r) => (r.id === id ? { ...r, ...change } : r));

describe("what the Workflow refuses before sending", () => {
  it("sends the list as it is", () => {
    expect(problem(rows(), current, counts)).toBeUndefined();
  });

  it("a list without a kind it must keep is refused invalid, naming the kind", () => {
    expect(problem(edit("st-todo", { kind: "backlog" }), current, new Map())).toEqual({
      code: "invalid",
      message: "The list needs a Todo Status.",
    });
    const noEndings = rows().filter((r) => r.kind !== "done" && r.kind !== "dropped");
    expect(problem(noEndings, current, new Map())?.message).toBe("The list needs a Done and a Dropped Status.");
    // Backlog is the one kind the list may go without.
    expect(problem(without("st-backlog"), current, new Map())).toBeUndefined();
  });

  it("names must be there and differ, ignoring case", () => {
    expect(problem(edit("st-review", { name: "  " }), current, counts)?.message).toBe("A Status needs a name.");
    expect(problem(edit("st-review", { name: "in progress" }), current, counts)?.message).toBe("Two Statuses are named in progress.");
  });

  it("deleting a Status that Tasks are in needs a Status to receive them", () => {
    expect(problem(without("st-review"), current, counts)).toEqual({
      code: "status_in_use",
      message: "2 Tasks are in In review; choose the Status they move to.",
    });
    expect(problem(without("st-review"), current, counts, { "st-review": "st-progress" })).toBeUndefined();
    // An open Task cannot move to a Status that ends it.
    expect(problem(without("st-review"), current, counts, { "st-review": "st-done" })?.message).toBe(
      "The Tasks in In review cannot move to Done: a Task does not change how it ended.",
    );
    // An empty Status goes without asking.
    expect(problem(without("st-backlog"), current, counts)).toBeUndefined();
  });

  it("a Status that Tasks are in keeps how it ends a Task", () => {
    expect(problem(edit("st-review", { kind: "todo" }), current, counts)).toBeUndefined();
    expect(problem([...edit("st-done", { kind: "in_progress" }), { key: "new", name: "Shipped", kind: "done" }], current, counts)).toEqual({
      code: "status_in_use",
      message: "6 Tasks are in Done, so its kind stays Done.",
    });
  });

  it("offers a deleted Status's Tasks the kept Statuses that end a Task the same way, its own kind first", () => {
    expect(moveTargets(current[3], without("st-review")).map((r) => r.name)).toEqual(["In progress", "Backlog", "Todo"]);
    expect(moveTargets(current[4], without("st-done")).map((r) => r.name)).toEqual([]);
  });
});

describe("PUT /v1/statuses", () => {
  it("carries the whole list in order: ids on the kept, none on the new, names trimmed, and the moves", () => {
    const next = without("st-review");
    next.splice(insertAt(next), 0, { key: "new", name: " QA ", kind: "in_progress" });
    expect(setStatusesBody(next, { "st-review": "st-progress" })).toEqual({
      items: [
        { id: "st-backlog", name: "Backlog", kind: "backlog" },
        { id: "st-todo", name: "Todo", kind: "todo" },
        { id: "st-progress", name: "In progress", kind: "in_progress" },
        { name: "QA", kind: "in_progress" },
        { id: "st-done", name: "Done", kind: "done" },
        { id: "st-dropped", name: "Dropped", kind: "dropped" },
      ],
      moves: { "st-review": "st-progress" },
    });
    expect(setStatusesBody(rows())).not.toHaveProperty("moves");
  });

  it("a new Status goes after the last open one, before Done", () => {
    expect(insertAt(rows())).toBe(4);
  });
});
