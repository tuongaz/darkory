import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { Member, Task, Workflows } from "@/api/client";
import { LiveActivity } from "@/api/live";
import { Providers, Root } from "@/App";
import { newQueryClient } from "@/queryClient";
import { mockApi, refuse } from "@/test/api";
import { ada, bob, signedIn, task, wfId, wfStep, workflow, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { answer, type Body } from "@/test/workflowPut";
import { workflowRows } from "./workflowRows";

// The Workflows page (shell-navigation-plan.md, Task 3): every Project opens on a list of its
// Workflows with their figures, a Project of one included; a row opens that Workflow's page, whose
// chip goes to another's. For an admin each row carries its acts (‹ › ✎ 🗑, folded into one ⋯ on a
// phone) and the bar's primary is + Workflow; each act is one PUT of the whole graph, said in a toast.

// Bugs: 2 at Investigate (1 worked), 1 at Fix; Support: 3 at Support (2 worked).
const graph = () =>
  workflowsFixture(undefined, {
    investigate: { tasks: 2, working: 1 },
    fix: { tasks: 1, working: 0 },
    support: { tasks: 3, working: 2 },
  });
const doneAt = (n: number, at: Date, extra: Partial<Task> = {}) => task(n, { state: "done", step_id: undefined, ended_at: at.toISOString(), ...extra });
const doneToday = (n: number, extra: Partial<Task> = {}) => doneAt(n, new Date(), extra);
const yesterday = () => new Date(Date.now() - 36 * 3600 * 1000);

/**
 * The `/v1/tasks` the page reads, as `/v1` answers it: `state=`, and each `completed_at:gte:<time>`
 * filter, when the Task ended done, which a Task of the client reads as its `ended_at`.
 */
function listed(tasks: Task[], query: URLSearchParams): Task[] {
  const since = query
    .getAll("filter")
    .map((f) => /^completed_at:gte:(.+)$/.exec(f)?.[1])
    .filter((x): x is string => !!x);
  return tasks.filter(
    (t) => (!query.get("state") || t.state === query.get("state")) && since.every((at) => t.state === "done" && !!t.ended_at && Date.parse(t.ended_at) >= Date.parse(at)),
  );
}

/** Signed in as `who`, WEB's Workflows served from `record` and replaced by each PUT, which is recorded. */
function serve(tasks: Task[], record: Workflows = graph(), who: Member = ada) {
  let current = record;
  const puts: Body[] = [];
  const api = mockApi({
    ...signedIn(who),
    "GET /v1/projects/:project/workflow": () => current,
    "PUT /v1/projects/:project/workflow": ({ body }) => {
      puts.push(body as Body);
      const made = answer(current, body as Body);
      if (made instanceof Response) return made;
      current = made;
      return current;
    },
    "GET /v1/skills": { items: workflowsSkills },
    "GET /v1/tasks": ({ query }) => ({ items: listed(tasks, query) }),
    "GET /v1/activity": { items: [], last_seq: 0 },
    "GET /v1/runner/sessions": { items: [], runner: false },
  });
  return { ...api, puts, current: () => current };
}

function Address() {
  const l = useLocation();
  return <output aria-label="Address">{l.pathname + l.search}</output>;
}
/** The whole app at `path`, with where it is now read out beside it. */
function renderWithAddress(path: string) {
  render(
    <Providers client={newQueryClient()} live={new LiveActivity()}>
      <MemoryRouter initialEntries={[path]}>
        <Root />
        <Address />
      </MemoryRouter>
    </Providers>,
  );
}
const address = () => screen.getByLabelText("Address").textContent;

const table = () => screen.findByRole("table", { name: "Workflows" });
// The figures: Workflow · Steps · Waiting · Working · Done today; an admin's act cells follow them.
const cells = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .slice(0, 5)
    .map((c) => c.textContent);
const names = async () =>
  within(await table())
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.getAttribute("aria-label"));

afterEach(() => localStorage.clear());

describe("the Workflows page of a Project of several", () => {
  it("lists each Workflow in order with its Steps, waiting, working and done today", async () => {
    // One done in Bugs; one the server places in no Workflow, listed in the first, as on the board;
    // one done in Bugs yesterday, not counted.
    const { calls } = serve([doneToday(7, { workflow_id: wfId.bugs }), doneToday(8), doneAt(9, yesterday(), { workflow_id: wfId.bugs })]);
    renderApp("/projects/WEB/workflows");
    const list = await table();
    // The figures' heads; an admin's act columns are named for a screen reader alone.
    expect(within(list).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Workflow", "Steps", "Waiting", "Working", "Done today", "Order", "Edit or delete", "More"]);
    await waitFor(() => expect(cells(within(list).getByRole("row", { name: "Bugs" }))).toEqual(["Bugs", "4", "2", "1", "1"]));
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows.map(cells)).toEqual([
      ["Triage", "1", "0", "0", "1"],
      ["Bugs", "4", "2", "1", "1"],
      ["Features", "4", "0", "0", "0"],
      ["Prototypes", "2", "0", "0", "0"],
      ["Support", "4", "1", "2", "0"],
    ]);
    const read = calls.find((c) => c.path === "/v1/tasks" && c.query.get("state") === "done");
    expect(read?.query.getAll("filter")).toEqual([expect.stringMatching(/^completed_at:gte:/)]);
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
    expect(screen.getByRole("link", { name: "Edit Bugs" })).toHaveAttribute("href", `/projects/WEB/workflows/${wfId.bugs}/edit`);
  });

  it("goes to a sibling's page with the chip, remembered as the board's pick; the list never reads it", async () => {
    serve([]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(await screen.findByRole("button", { name: "Workflow: Bugs" }));
    await userEvent.click(await screen.findByRole("option", { name: "Support" }));
    expect(await screen.findByRole("button", { name: "Workflow: Support" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit Support" })).toHaveAttribute("href", `/projects/WEB/workflows/${wfId.support}/edit`);
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
  it("orders each row with ‹ ›, the first never earlier, the last never later; nothing sent on opening", async () => {
    const { puts } = serve([]);
    renderApp("/projects/WEB/workflows");
    const list = within(await table());
    expect(await names()).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
    await waitFor(() => expect(list.getByRole("button", { name: "Move Bugs earlier" })).toBeEnabled());
    expect(list.getByRole("button", { name: "Move Triage earlier" })).toBeDisabled();
    expect(list.getByRole("button", { name: "Move Support later" })).toBeDisabled();
    expect(list.getByRole("button", { name: "Delete Bugs" })).toBeEnabled();
    expect(within(screen.getByRole("group", { name: "Page" })).getByRole("button", { name: "Workflow" })).toBeEnabled();
    expect(puts).toEqual([]);
  });

  it("adds a Workflow at once and opens its editor with the name to type", async () => {
    const { puts, current } = serve([]);
    renderWithAddress("/projects/WEB/workflows");
    await table();
    await userEvent.click(within(screen.getByRole("group", { name: "Page" })).getByRole("button", { name: "Workflow" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].workflows).toEqual([
      { id: wfId.triage, name: "Triage", position: 1 },
      { id: wfId.bugs, name: "Bugs", position: 2 },
      { id: wfId.features, name: "Features", position: 3 },
      { id: wfId.prototypes, name: "Prototypes", position: 4 },
      { id: wfId.support, name: "Support", position: 5 },
      { name: "Workflow 6", position: 6 },
    ]);
    expect(puts[0].steps).toHaveLength(graph().steps.length);
    const name = await screen.findByRole("textbox", { name: "Name of the Workflow" });
    expect(name).toHaveValue("Workflow 6");
    await waitFor(() => expect(name).toHaveFocus());
    const made = current().workflows.find((w) => w.name === "Workflow 6")!;
    expect(address()).toBe(`/projects/WEB/workflows/${made.id}/edit`);
    expect(within(screen.getByRole("list", { name: "Steps" })).queryAllByRole("listitem")).toEqual([]);
    expect(await screen.findByText("Added Workflow 6")).toBeInTheDocument();
    // Named at once and saved with the draft; Save lands on its page.
    await userEvent.clear(name);
    await userEvent.type(name, "Ops{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].workflows.at(-1)).toEqual({ id: made.id, name: "Ops", position: 6 });
    await waitFor(() => expect(address()).toBe(`/projects/WEB/workflows/${made.id}`));
  });

  it("moves a Workflow later at once and says where New Tasks start when that changes", async () => {
    const { puts } = serve([]);
    renderApp("/projects/WEB/workflows");
    const list = within(await table());
    const later = list.getByRole("button", { name: "Move Triage later" });
    await waitFor(() => expect(later).toBeEnabled());
    await userEvent.click(later);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].workflows.slice(0, 2)).toEqual([
      { id: wfId.bugs, name: "Bugs", position: 1 },
      { id: wfId.triage, name: "Triage", position: 2 },
    ]);
    await waitFor(async () => expect(await names()).toEqual(["Bugs", "Triage", "Features", "Prototypes", "Support"]));
    // Bugs first: New Tasks start at its first Step now, and the toast says so.
    expect(await screen.findByText("Moved Triage later. New Tasks start at Investigate.")).toBeInTheDocument();
    await userEvent.click(list.getByRole("button", { name: "Move Support earlier" }));
    await waitFor(() => expect(puts).toHaveLength(2));
    await waitFor(async () => expect(await names()).toEqual(["Bugs", "Triage", "Features", "Support", "Prototypes"]));
    // Where New Tasks start is unchanged: the move alone is said.
    expect(await screen.findByText("Moved Support earlier")).toBeInTheDocument();
    expect(screen.queryByText(/^Moved Support earlier\./)).toBeNull();
  });

  it("sends one PUT for two clicks in the same moment", async () => {
    const { puts } = serve([]);
    renderApp("/projects/WEB/workflows");
    const later = within(await table()).getByRole("button", { name: "Move Features later" });
    await waitFor(() => expect(later).toBeEnabled());
    // Both in one moment: React draws nothing between them.
    act(() => {
      later.click();
      later.click();
    });
    await waitFor(async () => expect(await names()).toEqual(["Triage", "Bugs", "Prototypes", "Features", "Support"]));
    expect(puts).toHaveLength(1);
  });

  it("asks before deleting, then writes once: its Tasks need a Step of another, the outcome into it is removed unless led on", async () => {
    const { puts } = serve([], workflowsFixture(undefined, { fix: { tasks: 1 } }));
    renderApp("/projects/WEB/workflows");
    await userEvent.click(within(await table()).getByRole("button", { name: "Delete Bugs" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Bugs" }));
    expect(dialog.getByText("The Steps of Bugs go with it: Investigate, Fix, Review, Verify.")).toBeInTheDocument();
    expect(dialog.getByText("1 Task at Fix")).toBeInTheDocument();
    expect(dialog.getByRole("combobox", { name: "Where bug out of Triage leads instead" })).toHaveTextContent("Remove this outcome");
    expect(dialog.getByRole("button", { name: "Delete Bugs" })).toBeDisabled();
    await userEvent.click(dialog.getByRole("combobox", { name: "Step that receives the Tasks at Fix" }));
    await userEvent.click(await screen.findByRole("option", { name: "Triage" }));
    // The Workflow, its four Steps and the outcome into it from Triage.
    expect(dialog.getByText("6 changes")).toBeInTheDocument();
    expect(puts).toEqual([]);
    await userEvent.click(dialog.getByRole("button", { name: "Delete Bugs" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].moves).toEqual({ [wfStep.fix]: wfStep.triage });
    expect(puts[0].workflows.map((w) => w.name)).toEqual(["Triage", "Features", "Prototypes", "Support"]);
    expect(puts[0].connectors.some((c) => c.from === wfStep.triage && c.name === "bug")).toBe(false);
    await waitFor(async () => expect(await names()).toEqual(["Triage", "Features", "Prototypes", "Support"]));
    expect(await screen.findByText("Deleted Bugs")).toBeInTheDocument();
  });

  it("says in a toast what /v1 refuses, in its words, and the list stays", async () => {
    const api = serve([]);
    api.routes["PUT /v1/projects/:project/workflow"] = refuse(400, "invalid", 'two Workflows are named "Bugs"; names are unique, ignoring case');
    renderApp("/projects/WEB/workflows");
    const earlier = within(await table()).getByRole("button", { name: "Move Bugs earlier" });
    await waitFor(() => expect(earlier).toBeEnabled());
    await userEvent.click(earlier);
    expect(await screen.findByText('two Workflows are named "Bugs"; names are unique, ignoring case')).toBeInTheDocument();
    expect(await names()).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
  });

  it("folds a row's acts into one ⋯ menu for a phone: Edit, Move earlier, Move later, Delete", async () => {
    serve([]);
    renderApp("/projects/WEB/workflows");
    await userEvent.click(within(await table()).getByRole("button", { name: "More for Triage" }));
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Edit", "Move earlier", "Move later", "Delete"]);
    expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveAttribute("href", `/projects/WEB/workflows/${wfId.triage}/edit`);
    expect(menu.getByRole("menuitem", { name: "Move earlier" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(menu.getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("dialog", { name: "Delete Triage" })).toBeInTheDocument();
  });

  it("opens a Workflow's editor from its row's pencil", async () => {
    serve([]);
    renderWithAddress("/projects/WEB/workflows");
    const pencil = within(await table()).getByRole("link", { name: "Edit Bugs" });
    expect(pencil).toHaveAttribute("href", `/projects/WEB/workflows/${wfId.bugs}/edit`);
    await userEvent.click(pencil);
    expect(await screen.findByRole("textbox", { name: "Name of the Workflow" })).toHaveValue("Bugs");
    expect(address()).toBe(`/projects/WEB/workflows/${wfId.bugs}/edit`);
  });

  it("shows a Member who is not an admin the figures and no acts", async () => {
    serve([], graph(), bob);
    renderApp("/projects/WEB/workflows");
    const list = within(await table());
    expect(list.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Workflow", "Steps", "Waiting", "Working", "Done today"]);
    expect(list.queryAllByRole("button")).toEqual([]);
    expect(list.queryByRole("link", { name: /^Edit / })).toBeNull();
    // Nothing for the bar's second row: no + Workflow.
    expect(screen.queryByRole("group", { name: "Page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Workflow" })).toBeNull();
  });
});

describe("the Workflows page of a Project of one", () => {
  it("lists its one Workflow, with + Workflow and the acts for an admin", async () => {
    serve([], workflow());
    renderApp("/projects/WEB/workflows");
    const t = await table();
    expect(within(t).getAllByRole("row")).toHaveLength(2);
    expect(within(t).getByRole("link", { name: "Work" })).toHaveAttribute("href", "/projects/WEB/workflows/wf-work");
    // The + Workflow primary.
    expect(screen.getByRole("group", { name: "Page" })).toHaveTextContent("Workflow");
    // The last stays.
    expect(within(t).getByRole("button", { name: /^Delete /, hidden: true })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Workflow: / })).toBeNull();
  });

  it("keeps its one Workflow in the ⋯ menu too: Delete is off", async () => {
    serve([], workflow());
    renderApp("/projects/WEB/workflows");
    await userEvent.click(within(await table()).getByRole("button", { name: "More for Work" }));
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
    expect(menu.getByRole("menuitem", { name: "Move earlier" })).toHaveAttribute("aria-disabled", "true");
    expect(menu.getByRole("menuitem", { name: "Move later" })).toHaveAttribute("aria-disabled", "true");
  });

  it("opens its one Workflow's page from the row, which names it as its last crumb, with no chip", async () => {
    serve([task(2)], workflow());
    renderApp("/projects/WEB/workflows");
    await userEvent.click(within(await table()).getByRole("link", { name: "Work" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Workflow" }).querySelector('button[data-task="WEB-2"]')).not.toBeNull());
    expect(screen.queryByRole("button", { name: /^Workflow: / })).toBeNull();
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByRole("link", { name: "Workflows" })).toHaveAttribute("href", "/projects/WEB/workflows");
    // The Workflow's name, plain: the page it is.
    expect(crumbs.getByText("Work").closest("a")).toBeNull();
    // Only the Project and Workflows link away.
    expect(crumbs.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Edit Work" })).toHaveAttribute("href", "/projects/WEB/workflows/wf-work/edit");
  });
});

describe("workflowRows", () => {
  it("never counts a Step's waiting below none", () => {
    const rows = workflowRows(workflowsFixture(undefined, { triage: { tasks: 1, working: 2 } }), []);
    expect(rows[0]).toMatchObject({ name: "Triage", waiting: 0, working: 2 });
  });
});
