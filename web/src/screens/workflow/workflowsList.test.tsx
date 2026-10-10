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
import { liveClaimOf } from "@/screens/board/testData";
import { answer, type Body } from "@/test/workflowPut";

// The Workflows page (workflow-vertical-plan.md, Task 4; vf-8): every Project opens on its
// Workflows, each drawn as its own line in a column, a Project of one included; a column's name
// opens that Workflow's page, whose chip goes to another's. For an admin each column's head carries
// its acts (the grip, Edit, the ⋯ with Move earlier, Move later and Delete) and the bar's primary is
// + Workflow; each act is one PUT of the whole graph, said in a toast.

// Bugs: 2 at Investigate (1 worked), 1 at Fix; Support: 3 at Support (2 worked).
const graph = () =>
  workflowsFixture(undefined, {
    investigate: { tasks: 2, working: 1 },
    fix: { tasks: 1, working: 0 },
    support: { tasks: 3, working: 2 },
  });
const doneAt = (n: number, at: Date, extra: Partial<Task> = {}) => task(n, { state: "done", step_id: undefined, ended_at: at.toISOString(), ...extra });
const doneToday = (n: number, extra: Partial<Task> = {}) => doneAt(n, new Date(), extra);

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

const list = () => screen.findByRole("list", { name: "Workflows" });
/** The list's columns, one per Workflow, in order (the lines' own Steps are lists too: only the list's own items). */
const columns = (l: HTMLElement) => [...l.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.tagName === "LI");
const names = async () => columns(await list()).map((c) => c.getAttribute("aria-label"));
const column = async (name: string) => within((await list()).querySelector<HTMLElement>(`:scope > [aria-label="${name}"]`)!);
/** A column's line: its Steps' rows, in order, as the line names them. */
const stations = (col: ReturnType<typeof within>) => [...col.getByRole("list", { name: "Steps on the line" }).querySelectorAll(":scope > li[data-station]")].map((li) => li.getAttribute("data-head"));
/** The ⋯ of a column, opened: its menu. */
async function more(name: string) {
  await userEvent.click((await column(name)).getByRole("button", { name: `More for ${name}` }));
  return within(await screen.findByRole("menu"));
}

afterEach(() => localStorage.clear());

describe("the Workflows page of a Project of several", () => {
  it("draws each Workflow as its own line, in order: Start, then its Steps, then Done", async () => {
    serve([]);
    renderApp("/projects/WEB/workflows");
    expect(await names()).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
    const bugs = await column("Bugs");
    await waitFor(() => expect(stations(bugs)).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]));
    // Its line starts at its first Step: Start above it, its station the start.
    expect(bugs.getByRole("list", { name: "Steps on the line" }).querySelector(":scope > li[data-station]")).toHaveAttribute("data-start");
    expect(bugs.getByText("Start")).toBeInTheDocument();
    expect(stations(await column("Features"))).toEqual(["Build", "Code review", "QA", "Release", "Done"]);
    expect(stations(await column("Triage"))).toEqual(["Triage", "Done"]);
    // No chip: the list is every Workflow; no table of figures.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Workflow: / })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Workflows")).toBeInTheDocument();
  });

  it("heads each column with the open Tasks listed on its Workflow, as its page lists them", async () => {
    // Two open in Bugs; one open the server places in no Workflow, listed on every one, as on the
    // board; one done in Bugs today, not open.
    serve([
      task(2, { step_id: wfStep.investigate, workflow_id: wfId.bugs, skill_id: undefined }),
      task(3, { step_id: wfStep.fix, workflow_id: wfId.bugs, skill_id: undefined }),
      task(4, { step_id: undefined, workflow_id: undefined, skill_id: undefined }),
      doneToday(7, { workflow_id: wfId.bugs }),
    ]);
    renderApp("/projects/WEB/workflows");
    await waitFor(async () => expect((await column("Bugs")).getByText("3 Tasks")).toBeInTheDocument());
    expect((await column("Triage")).getByText("1 Task")).toBeInTheDocument();
    // Done today is said at its line's Done.
    expect((await column("Bugs")).getByText("1 today")).toBeInTheDocument();
  });

  it("says a Workflow with no open Task listed has none", async () => {
    serve([task(2, { step_id: wfStep.investigate, workflow_id: wfId.bugs, skill_id: undefined })]);
    renderApp("/projects/WEB/workflows");
    await waitFor(async () => expect((await column("Bugs")).getByText("1 Task")).toBeInTheDocument());
    expect((await column("Support")).getByText("no open Tasks")).toBeInTheDocument();
  });

  it("reads the Project's Workflows and open Tasks once for every line", async () => {
    const { calls } = serve([task(2, { step_id: wfStep.investigate, workflow_id: wfId.bugs, skill_id: undefined })]);
    renderApp("/projects/WEB/workflows");
    await waitFor(async () => expect((await column("Bugs")).getByText("1 Task")).toBeInTheDocument());
    expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/projects/WEB/workflow")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/v1/tasks" && c.query.get("project") === "WEB" && c.query.get("state") === "open")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/v1/tasks" && c.query.get("project") === "WEB" && c.query.get("state") === "done")).toHaveLength(1);
  });

  it("puts a Task at its Step on its own Workflow's line; selecting it shows its strip in that column alone", async () => {
    const held = task(2, { step_id: wfStep.investigate, workflow_id: wfId.bugs, skill_id: undefined, claim: liveClaimOf(ada, "k-2") });
    serve([held]);
    renderApp("/projects/WEB/workflows");
    const bugs = await column("Bugs");
    const chip = await bugs.findByRole("button", { name: /^WEB-2\b/ });
    expect((await column("Triage")).queryByRole("button", { name: /^WEB-2\b/ })).toBeNull();
    await userEvent.click(chip);
    expect(await bugs.findByRole("region", { name: "WEB-2's way" })).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: "WEB-2's way" })).toHaveLength(1);
  });

  it("opens a Workflow's page from its column's name, the crumbs leading back to the list", async () => {
    serve([task(2, { step_id: wfStep.investigate, workflow_id: wfId.bugs, skill_id: undefined })]);
    renderApp("/projects/WEB/workflows");
    const link = (await column("Bugs")).getByRole("link", { name: "Bugs" });
    expect(link).toHaveAttribute("href", `/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(link);
    expect(await screen.findByRole("button", { name: "Workflow: Bugs" })).toBeInTheDocument();
    // WEB-2 waits at Investigate: counted there.
    expect(await within(screen.getByRole("region", { name: "Workflow" })).findByRole("button", { name: "Investigate: 1 Task waiting" })).toBeInTheDocument();
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
    expect(await list()).toBeInTheDocument();
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

  it("heads each column for an admin with the grip, Edit and the ⋯; the first never earlier, the last never later; nothing sent on opening", async () => {
    const { puts } = serve([]);
    renderApp("/projects/WEB/workflows");
    const bugs = await column("Bugs");
    // Its name says its keys: no instructions for keys it does not take.
    expect(bugs.getByRole("button", { name: /^Drag to order Bugs/ })).not.toHaveAttribute("aria-describedby");
    expect(bugs.getByRole("link", { name: "Edit Bugs" })).toHaveAttribute("href", `/projects/WEB/workflows/${wfId.bugs}/edit`);
    let menu = await more("Triage");
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Move earlier", "Move later", "Delete"]);
    expect(menu.getByRole("menuitem", { name: "Move earlier" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
    menu = await more("Support");
    expect(menu.getByRole("menuitem", { name: "Move later" })).toHaveAttribute("aria-disabled", "true");
    expect(menu.getByRole("menuitem", { name: "Delete" })).not.toHaveAttribute("aria-disabled");
    await userEvent.keyboard("{Escape}");
    expect(within(screen.getByRole("group", { name: "Page" })).getByRole("button", { name: "Workflow" })).toBeEnabled();
    expect(puts).toEqual([]);
  });

  it("adds a Workflow at once and opens its editor with the name to type", async () => {
    const { puts, current } = serve([]);
    renderWithAddress("/projects/WEB/workflows");
    await list();
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
    // No Step yet: the line is Done alone.
    expect(within(screen.getByRole("list", { name: "Steps on the line" })).getAllByRole("listitem").map((li) => li.getAttribute("data-head"))).toEqual(["Done"]);
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
    let menu = await more("Triage");
    await waitFor(() => expect(menu.getByRole("menuitem", { name: "Move later" })).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(menu.getByRole("menuitem", { name: "Move later" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].workflows.slice(0, 2)).toEqual([
      { id: wfId.bugs, name: "Bugs", position: 1 },
      { id: wfId.triage, name: "Triage", position: 2 },
    ]);
    await waitFor(async () => expect(await names()).toEqual(["Bugs", "Triage", "Features", "Prototypes", "Support"]));
    // Bugs first: New Tasks start at its first Step now, and the toast says so.
    expect(await screen.findByText("Moved Triage later. New Tasks start at Investigate.")).toBeInTheDocument();
    menu = await more("Support");
    await waitFor(() => expect(menu.getByRole("menuitem", { name: "Move earlier" })).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(menu.getByRole("menuitem", { name: "Move earlier" }));
    await waitFor(() => expect(puts).toHaveLength(2));
    await waitFor(async () => expect(await names()).toEqual(["Bugs", "Triage", "Features", "Support", "Prototypes"]));
    // Where New Tasks start is unchanged: the move alone is said.
    expect(await screen.findByText("Moved Support earlier")).toBeInTheDocument();
    expect(screen.queryByText(/^Moved Support earlier\./)).toBeNull();
  });

  it("moves a Workflow by its grip from the keyboard: one PUT, the same toast", async () => {
    const { puts } = serve([]);
    renderApp("/projects/WEB/workflows");
    const grip = (await column("Features")).getByRole("button", { name: /^Drag to order Features/ });
    await waitFor(() => expect(grip).not.toHaveAttribute("aria-disabled"));
    grip.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(async () => expect(await names()).toEqual(["Triage", "Features", "Bugs", "Prototypes", "Support"]));
    expect(await screen.findByText("Moved Features earlier")).toBeInTheDocument();
  });

  it("sends one PUT for two moves in the same moment", async () => {
    const { puts } = serve([]);
    renderApp("/projects/WEB/workflows");
    const grip = (await column("Features")).getByRole("button", { name: /^Drag to order Features/ });
    await waitFor(() => expect(grip).not.toHaveAttribute("aria-disabled"));
    // Both in one moment: React draws nothing between them.
    act(() => {
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await waitFor(async () => expect(await names()).toEqual(["Triage", "Bugs", "Prototypes", "Features", "Support"]));
    expect(puts).toHaveLength(1);
  });

  it("asks before deleting, then writes once: its Tasks need a Step of another, the outcome into it is removed unless led on", async () => {
    const { puts } = serve([], workflowsFixture(undefined, { fix: { tasks: 1 } }));
    renderApp("/projects/WEB/workflows");
    await userEvent.click((await more("Bugs")).getByRole("menuitem", { name: "Delete" }));
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

  it("deletes from the Workflow's own page too: the same dialog and one write, then the list", async () => {
    const { puts } = serve([]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(await screen.findByRole("button", { name: "Delete Bugs" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Bugs" }));
    expect(puts).toEqual([]);
    await userEvent.click(dialog.getByRole("combobox", { name: "Step that receives the Tasks at Investigate" }));
    await userEvent.click(await screen.findByRole("option", { name: "Triage" }));
    await userEvent.click(dialog.getByRole("combobox", { name: "Step that receives the Tasks at Fix" }));
    await userEvent.click(await screen.findByRole("option", { name: "Triage" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete Bugs" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].workflows.map((w) => w.name)).toEqual(["Triage", "Features", "Prototypes", "Support"]);
    expect((await screen.findAllByText("Deleted Bugs")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("list", { name: "Workflows" })).toBeInTheDocument();
  });

  it("offers a Member who is not an admin no Delete on a Workflow's page", async () => {
    serve([], graph(), bob);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}`);
    expect(await screen.findByRole("button", { name: "Workflow: Bugs" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  it("says in a toast what /v1 refuses, in its words, and the list stays", async () => {
    const api = serve([]);
    api.routes["PUT /v1/projects/:project/workflow"] = refuse(400, "invalid", 'two Workflows are named "Bugs"; names are unique, ignoring case');
    renderApp("/projects/WEB/workflows");
    const menu = await more("Bugs");
    await waitFor(() => expect(menu.getByRole("menuitem", { name: "Move earlier" })).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(menu.getByRole("menuitem", { name: "Move earlier" }));
    expect(await screen.findByText('two Workflows are named "Bugs"; names are unique, ignoring case')).toBeInTheDocument();
    expect(await names()).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
  });

  it("opens a Workflow's editor from its column's Edit", async () => {
    serve([]);
    renderWithAddress("/projects/WEB/workflows");
    const edit = (await column("Bugs")).getByRole("link", { name: "Edit Bugs" });
    expect(edit).toHaveAttribute("href", `/projects/WEB/workflows/${wfId.bugs}/edit`);
    await userEvent.click(edit);
    expect(await screen.findByRole("textbox", { name: "Name of the Workflow" })).toHaveValue("Bugs");
    expect(address()).toBe(`/projects/WEB/workflows/${wfId.bugs}/edit`);
  });

  it("shows a Member who is not an admin the lines and no acts", async () => {
    serve([task(2, { step_id: wfStep.investigate, workflow_id: wfId.bugs, skill_id: undefined })], graph(), bob);
    renderApp("/projects/WEB/workflows");
    const bugs = await column("Bugs");
    await waitFor(() => expect(bugs.getByText("1 Task")).toBeInTheDocument());
    expect(stations(bugs)).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]);
    expect(bugs.getByRole("link", { name: "Bugs" })).toBeInTheDocument();
    expect(bugs.queryByRole("button", { name: /^Drag to order / })).toBeNull();
    expect(bugs.queryByRole("button", { name: /^More for / })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Edit / })).toBeNull();
    // Nothing for the bar's second row: no + Workflow.
    expect(screen.queryByRole("group", { name: "Page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Workflow" })).toBeNull();
  });
});

describe("the Workflows page of a Project of one", () => {
  it("draws its one Workflow, with + Workflow and the acts for an admin; the last stays", async () => {
    serve([], workflow());
    renderApp("/projects/WEB/workflows");
    expect(await names()).toEqual(["Work"]);
    const work = await column("Work");
    expect(work.getByRole("link", { name: "Work" })).toHaveAttribute("href", "/projects/WEB/workflows/wf-work");
    // The + Workflow primary.
    expect(screen.getByRole("group", { name: "Page" })).toHaveTextContent("Workflow");
    const menu = await more("Work");
    const del = menu.getByRole("menuitem", { name: /^Delete/ });
    expect(del).toHaveAttribute("aria-disabled", "true");
    expect(del).toHaveTextContent("The last Workflow stays");
    expect(menu.getByRole("menuitem", { name: "Move earlier" })).toHaveAttribute("aria-disabled", "true");
    expect(menu.getByRole("menuitem", { name: "Move later" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: /^Workflow: / })).toBeNull();
  });

  it("opens its one Workflow's page from its name, which names it as its last crumb, with no chip", async () => {
    serve([task(2)], workflow());
    renderApp("/projects/WEB/workflows");
    await userEvent.click((await column("Work")).getByRole("link", { name: "Work" }));
    expect(await within(await screen.findByRole("region", { name: "Workflow" })).findByRole("button", { name: "Build: 1 Task waiting" })).toBeInTheDocument();
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
