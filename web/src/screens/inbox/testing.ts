// Records the tests of this folder share.

/** The default Statuses of a new Organisation, as GET /v1/statuses lists them. */
export const statuses = {
  items: [
    { id: "st-backlog", name: "Backlog", kind: "backlog", position: 1 },
    { id: "st-todo", name: "Todo", kind: "todo", position: 2 },
    { id: "st-progress", name: "In progress", kind: "in_progress", position: 3 },
    { id: "st-review", name: "In review", kind: "in_progress", position: 4 },
    { id: "st-done", name: "Done", kind: "done", position: 5 },
    { id: "st-dropped", name: "Dropped", kind: "dropped", position: 6 },
  ],
};
