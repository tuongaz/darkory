import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@/api/client";
import { mockApi } from "@/test/api";
import { ada, signedIn, task, wfId, wfStep, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { workflowRows } from "./workflowRows";

// The Workflows page (named-workflows-plan.md, Round 2): a Project of two or more opens on a list
// of its Workflows with their figures; a row opens that Workflow's page, whose chip goes to
// another's; a Project of one opens its Workflow's page in place.

// Bugs: 2 at Investigate (1 worked), 1 at Fix; Support: 3 at Support (2 worked).
const graph = () =>
  workflowsFixture(undefined, {
    investigate: { tasks: 2, working: 1 },
    fix: { tasks: 1, working: 0 },
    support: { tasks: 3, working: 2 },
  });
const doneToday = (n: number, extra: Partial<Task> = {}) =>
  task(n, { state: "done", step_id: undefined, ended_at: new Date().toISOString(), ...extra });

function serve(tasks: Task[], record = graph()) {
  return mockApi({
    ...signedIn(ada),
    "GET /v1/projects/:project/workflow": record,
    "GET /v1/skills": { items: workflowsSkills },
    "GET /v1/tasks": ({ query }) => ({ items: tasks.filter((t) => !query.get("state") || t.state === query.get("state")) }),
    "GET /v1/activity": { items: [], last_seq: 0 },
    "GET /v1/runner/sessions": { items: [], runner: false },
  });
}

const table = () => screen.findByRole("table", { name: "Workflows" });
const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);

afterEach(() => localStorage.clear());

describe("the Workflows page of a Project of several", () => {
  it("lists each Workflow in order with its Steps, waiting, working and done today", async () => {
    // One done in Bugs; one the server places in no Workflow, listed in the first, as on the board.
    serve([doneToday(7, { workflow_id: wfId.bugs }), doneToday(8)]);
    renderApp("/projects/WEB/workflows");
    const list = await table();
    expect(within(list).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Workflow", "Steps", "Waiting", "Working", "Done today"]);
    await waitFor(() => expect(cells(within(list).getByRole("row", { name: "Bugs" }))).toEqual(["Bugs", "4", "2", "1", "1"]));
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows.map(cells)).toEqual([
      ["Triage", "1", "0", "0", "1"],
      ["Bugs", "4", "2", "1", "1"],
      ["Features", "4", "0", "0", "0"],
      ["Prototypes", "2", "0", "0", "0"],
      ["Support", "4", "1", "2", "0"],
    ]);
    // No chip: the list is every Workflow.
    expect(screen.queryByRole("button", { name: /^Workflow: / })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Workflows")).toBeInTheDocument();
  });

  it("opens a Workflow's page from its row, the crumbs leading back to the list", async () => {
    serve([task(2, { step_id: wfStep.investigate, workflow_id: wfId.bugs, skill_id: undefined })]);
    renderApp("/projects/WEB/workflows");
    const link = within(await table()).getByRole("link", { name: "Bugs" });
    expect(link).toHaveAttribute("href", `/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(link);
    expect(await screen.findByRole("button", { name: "Workflow: Bugs" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("region", { name: "Workflow" }).querySelector('button[data-task="WEB-2"]')).not.toBeNull());
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Workflows" })).toHaveAttribute("href", "/projects/WEB/workflows");
    expect(screen.getByRole("link", { name: "Edit Bugs" })).toHaveAttribute("href", `/settings/projects/WEB/workflows/${wfId.bugs}`);
  });

  it("goes to a sibling's page with the chip, remembered as the board's pick; the list never reads it", async () => {
    serve([]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(await screen.findByRole("button", { name: "Workflow: Bugs" }));
    await userEvent.click(await screen.findByRole("option", { name: "Support" }));
    expect(await screen.findByRole("button", { name: "Workflow: Support" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit Support" })).toHaveAttribute("href", `/settings/projects/WEB/workflows/${wfId.support}`);
    expect(localStorage.getItem("darkory.workflow.WEB")).toBe(wfId.support);
    await userEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Workflows" }));
    expect(await table()).toBeInTheDocument();
  });

  it("opens the Workflow a ?workflow= names, as the board's address says it", async () => {
    serve([]);
    renderApp(`/projects/WEB/workflows?workflow=${wfId.support}`);
    expect(await screen.findByRole("button", { name: "Workflow: Support" })).toBeInTheDocument();
  });

  it("says a Workflow the address names that is none of the Project's is not found", async () => {
    serve([]);
    renderApp("/projects/WEB/workflows/nothing-here");
    expect((await screen.findAllByText("Not found")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: "Workflow" })).toBeNull();
  });
});

describe("the Workflows page of a Project of one", () => {
  it("is that Workflow's page in place: no list, no chip", async () => {
    mockApi({
      ...signedIn(ada),
      "GET /v1/tasks": { items: [task(2)] },
      "GET /v1/activity": { items: [], last_seq: 0 },
      "GET /v1/runner/sessions": { items: [], runner: false },
    });
    renderApp("/projects/WEB/workflows");
    await waitFor(() => expect(screen.getByRole("region", { name: "Workflow" }).querySelector('button[data-task="WEB-2"]')).not.toBeNull());
    expect(screen.queryByRole("table", { name: "Workflows" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Workflow: / })).toBeNull();
    // The page is the list's address: its crumb is no link.
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).queryByRole("link", { name: "Workflows" })).toBeNull();
  });
});

describe("workflowRows", () => {
  it("never counts a Step's waiting below none", () => {
    const rows = workflowRows(workflowsFixture(undefined, { triage: { tasks: 1, working: 2 } }), []);
    expect(rows[0]).toMatchObject({ name: "Triage", waiting: 0, working: 2 });
  });
});
