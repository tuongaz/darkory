import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, refuse } from "@/test/api";
import { FakeEventSource } from "@/test/eventSource";
import { bob, builder, parentTask, step, subtask, task, wfId, wfStep, workflow, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { toShort } from "@/lib/shortid";
import { cart, copy, payment, projectTasks, receipt, routes } from "./testData";

const row = (name: RegExp) => screen.findByRole("link", { name });
// A label shown once the bar's second row has 42rem, the icon alone on a narrower row (jsdom lays
// nothing out: the classes are what tell).
const narrowHidden = (el: Element) => el.classList.contains("hidden") && el.classList.contains("@2xl/page:inline");
const main = () => document.getElementById("main")!;
// The list's groups and the board's columns: the regions of the page, not the toasts' region.
const regions = () => within(main()).getAllByRole("region").map((g) => g.getAttribute("aria-label"));

beforeEach(() => localStorage.clear());

describe("Tasks, list", () => {
  it("groups by Step in the Workflow's order, then With <Member>, then Done; Dropped hidden", async () => {
    mockApi(routes());
    renderApp("/projects/WEB/tasks?view=list");
    expect(await screen.findByRole("heading", { name: "Tasks, list" })).toBeInTheDocument();
    await row(/WEB-2 Build the cart page/);
    expect(regions()).toEqual(["Backlog", "Build", "With bob", "Done"]);
    // The Parent stands at Build, where its least advanced Subtask is.
    const build = within(main()).getByRole("region", { name: "Build" });
    expect(within(build).getAllByRole("link").map((l) => l.getAttribute("data-task"))).toEqual(["WEB-2", "WEB-3"]);
    expect(screen.getByText("5 Tasks · 3 Subtasks under their Parents · Dropped hidden (1)")).toBeInTheDocument();
  });

  it("draws each row's glyph, Labels, Owner and holder, Blocked by, Lapsed, Heartbeat, Evidence and a Parent's progress", async () => {
    mockApi(routes());
    renderApp("/projects/WEB/tasks");
    const held = await row(/WEB-2 Build the cart page/);
    expect(within(held).getByText("Blocked by WEB-8")).toBeInTheDocument();
    expect(within(held).getByRole("img", { name: "Working" })).toBeInTheDocument();
    expect(within(held).getByRole("img", { name: "builder (agent)" })).toBeInTheDocument();
    expect(within(held).getByText("working 5m")).toBeInTheDocument();
    expect(within(held).getByLabelText("Labels: client-x")).toBeInTheDocument();
    expect(within(await row(/WEB-1 Draft the launch copy/)).getByText(/^Lapsed /)).toBeInTheDocument();
    expect(within(await row(/WEB-1 Draft/)).getByRole("img", { name: "At a hold" })).toBeInTheDocument();
    const parent = await row(/WEB-3 Checkout/);
    expect(within(parent).getByText("1/3")).toBeInTheDocument();
    // Its Owner is bob, whom nobody else stands in front of.
    expect(within(parent).getByRole("img", { name: "bob" })).toBeInTheDocument();
    expect(within(await row(/WEB-8 Stripe keys/)).getByText("blocks WEB-2")).toBeInTheDocument();
    // A row opens the Task's peek over the list.
    expect(held).toHaveAttribute("href", "/projects/WEB/tasks?task=WEB-2");
  });

  it("opens a Parent's row to its Subtasks, with their Evidence, and remembers it", async () => {
    mockApi(routes());
    const first = renderApp("/projects/WEB/tasks");
    await row(/WEB-3 Checkout/);
    expect(screen.queryByRole("link", { name: /WEB-5 Receipt email/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open the Subtasks of WEB-3" }));
    const subs = screen.getByRole("group", { name: "Subtasks of WEB-3" });
    expect(within(subs).getAllByRole("link").map((l) => l.getAttribute("data-task"))).toEqual([payment.key, receipt.key, "WEB-6"]);
    expect(within(subs).getByRole("link", { name: /WEB-5/ })).toHaveTextContent("Review");
    expect(within(subs).getByLabelText("2 Evidence")).toBeInTheDocument();
    first.unmount();

    renderApp("/projects/WEB/tasks");
    expect(await row(/WEB-5 Receipt email/)).toBeInTheDocument();
    // Display › Subtasks off: Parents' rows stay closed.
    await userEvent.click(screen.getByRole("button", { name: "Display" }));
    await userEvent.click(await screen.findByRole("switch", { name: "Subtasks" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: /WEB-5 Receipt email/ })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Subtasks of WEB-3/ })).not.toBeInTheDocument();
  });

  it("groups by Parent, Owner and Label from Display, and remembers the choice", async () => {
    mockApi(routes());
    const first = renderApp("/projects/WEB/tasks");
    await row(/WEB-2/);
    await userEvent.click(screen.getByRole("button", { name: "Display" }));
    await userEvent.click(await screen.findByRole("button", { name: "Parent" }));
    await waitFor(() => expect(regions()).toEqual(["WEB-3 Checkout", "No Parent"]));
    expect(within(within(main()).getByRole("region", { name: "WEB-3 Checkout" })).getAllByRole("link").map((l) => l.getAttribute("data-task"))).toEqual([
      "WEB-4",
      "WEB-5",
      "WEB-6",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Label" }));
    await waitFor(() => expect(regions()).toEqual(["bug", "client-x", "No Label"]));
    first.unmount();
    renderApp("/projects/WEB/tasks");
    await row(/WEB-2/);
    expect(regions()).toEqual(["bug", "client-x", "No Label"]);
  });

  it("folds a group and remembers it; Dropped shows from Display", async () => {
    mockApi(routes());
    renderApp("/projects/WEB/tasks");
    await row(/WEB-9 Landing page/);
    await userEvent.click(screen.getByRole("button", { name: "Fold Done" }));
    expect(screen.queryByRole("link", { name: /WEB-9/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Display" }));
    await userEvent.click(await screen.findByRole("switch", { name: "Dropped" }));
    // Dropped starts folded.
    expect(await screen.findByRole("button", { name: "Show Dropped" })).toBeInTheDocument();
  });

  it("walks the rows with J and K, and Enter opens the peek", async () => {
    mockApi(routes({ "GET /v1/tasks/:task": refuse(404, "not_found", "No such Task") }));
    renderApp("/projects/WEB/tasks");
    await row(/WEB-1/);
    await userEvent.keyboard("j");
    await waitFor(() => expect(screen.getByRole("link", { name: /WEB-1 Draft/ })).toHaveAttribute("data-selected", "true"));
    await userEvent.keyboard("j");
    expect(screen.getByRole("link", { name: /WEB-2 Build/ })).toHaveAttribute("data-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Task WEB-2" })).toBeInTheDocument();
  });

  it("a group's + and C open File a Task in this Project, the + at its Step", async () => {
    mockApi(routes());
    renderApp("/projects/WEB/tasks");
    await row(/WEB-1/);
    await userEvent.click(screen.getByRole("button", { name: "File a Task at Backlog" }));
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    expect(within(dialog).getByRole("combobox", { name: "Step" })).toHaveTextContent("Backlog");
  });

  it("updates a row as the stream reports a Claim", async () => {
    const api = mockApi(routes());
    renderApp("/projects/WEB/tasks");
    await row(/WEB-1/);
    api.routes["GET /v1/tasks"] = { items: [{ ...copy, claim: { ...cart.claim!, task_id: copy.id, holder_id: bob.id } }] };
    act(() => FakeEventSource.latest().open());
    act(() => FakeEventSource.latest().emit("activity", { seq: 9, kind: "task.claimed", subject_type: "task", subject_id: copy.id, at: new Date().toISOString(), payload: {} }, 9));
    const held = await row(/WEB-1 Draft/);
    await waitFor(() => expect(within(held).getByRole("img", { name: "bob" })).toBeInTheDocument());
    expect(within(held).queryByText(/^Lapsed /)).not.toBeInTheDocument();
  });
});

describe("Tasks, Filter and Views", () => {
  it("narrows the list by a Step pill, keeping a Parent whose Subtask passes, opened to that Subtask", async () => {
    mockApi(routes());
    renderApp(`/projects/WEB/tasks?filter.tasks=${encodeURIComponent(`step:is:${step.review}`)}`);
    await row(/WEB-3 Checkout/);
    expect(screen.queryByRole("link", { name: /WEB-2 Build/ })).not.toBeInTheDocument();
    const subs = screen.getByRole("group", { name: "Subtasks of WEB-3" });
    expect(within(subs).getAllByRole("link").map((l) => l.getAttribute("data-task"))).toEqual(["WEB-5"]);
    expect(screen.getByText(/^1 Task match the Filter/)).toBeInTheDocument();
    // The chip row says it, and Reset clears it.
    await userEvent.click(within(screen.getByRole("toolbar", { name: "Filters" })).getByRole("button", { name: "Reset" }));
    expect(await row(/WEB-2 Build/)).toBeInTheDocument();
  });

  it("F opens the Filters menu", async () => {
    mockApi(routes());
    renderApp("/projects/WEB/tasks");
    await row(/WEB-2/);
    await userEvent.keyboard("f");
    expect(await screen.findByPlaceholderText(/Search/)).toBeInTheDocument();
  });

  it("narrows the board's cards by the pills", async () => {
    mockApi(routes());
    renderApp(`/projects/WEB/tasks?view=board&filter.tasks=${encodeURIComponent(`holder:is:${builder.id}`)}`);
    await row(/WEB-2/);
    expect(within(main()).getAllByRole("link").map((l) => l.getAttribute("data-task")).filter(Boolean)).toEqual(["WEB-2", "WEB-4"]);
  });

  it("applies a View: its pills, its layout and its Display", async () => {
    mockApi(
      routes({
        "GET /v1/views": {
          items: [
            {
              id: "v-1",
              entity: "tasks",
              project_id: "p-web",
              name: "Agents at work",
              filters: [`holder:is:${builder.id}`],
              sort: "filed",
              display: { group: "owner", order: "filed", showDone: false, layout: "list" },
              created_at: "2026-10-01T09:00:00Z",
            },
          ],
        },
      }),
    );
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-2/);
    await userEvent.click(screen.getByRole("button", { name: "Views" }));
    await userEvent.click(await screen.findByRole("option", { name: /Agents at work/ }));
    expect(await screen.findByRole("heading", { name: "Tasks, list" })).toBeInTheDocument();
    // builder holds WEB-2 (ada's) and WEB-4, under bob's Parent WEB-3.
    await waitFor(() => expect(regions()).toEqual(["ada", "bob"]));
    expect(within(screen.getByRole("toolbar", { name: "Filters" })).getByLabelText("View Agents at work")).toBeInTheDocument();
  });
});

/**
 * jsdom lays nothing out; dnd-kit measures. Each column is 232px wide, 250px apart, in document
 * order; a card sits at the top of its column.
 */
function layOut() {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const columns = [...document.querySelectorAll("#main section[data-column]")];
    const col = this.closest("section[data-column]");
    const i = col ? columns.indexOf(col) : -1;
    // The card being carried (its overlay is outside the columns) is where the focused card is.
    const carried = document.activeElement?.closest("section[data-column]");
    if (i < 0) return carried && this.closest(".card-overlay") ? (rect(columns.indexOf(carried) * 250, 40, 232, 60) as DOMRect) : (rect(0, 0, 0, 0) as DOMRect);
    if (this === col) return rect(i * 250, 0, 232, 800) as DOMRect;
    return rect(i * 250, 40, 232, 60) as DOMRect;
  });
}

/** Carries a card with the keyboard: Space picks it up, → moves it `steps` columns, Space drops it. */
async function carry(key: string, steps: number) {
  const card = screen.getByRole("link", { name: new RegExp(`^${key} `) });
  card.focus();
  await userEvent.keyboard(" ");
  for (let i = 0; i < steps; i++) await userEvent.keyboard("{ArrowRight}");
  await userEvent.keyboard(" ");
}

describe("Tasks, board", () => {
  afterEach(() => vi.restoreAllMocks());

  it("draws a column per Step, holds dashed, a column per Member aimed at, Done, and Dropped folded", async () => {
    mockApi(routes());
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-2/);
    expect(regions()).toEqual(["Backlog", "Plan", "Build", "Review", "Retro", "Skill review", "With bob", "Done", "Dropped"]);
    expect(within(main()).getByRole("region", { name: "Backlog" })).toHaveAttribute("data-hold", "true");
    expect(screen.getByRole("button", { name: "Show Dropped, 1" })).toBeInTheDocument();
    // Subtasks are cards at their Steps, saying their Parent; the Parent is not, unless shown.
    const review = within(main()).getByRole("region", { name: "Review" });
    expect(within(review).getByRole("link", { name: /WEB-5/ })).toHaveTextContent("WEB-3Checkout");
    expect(screen.queryByRole("link", { name: /WEB-3 Checkout/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Display" }));
    await userEvent.click(await screen.findByRole("switch", { name: "Parents" }));
    const parent = await row(/WEB-3 Checkout/);
    expect(parent).toHaveAttribute("data-movable", "false");
    expect(within(main()).getByRole("region", { name: "Build" })).toContainElement(parent);
  });

  it("moves a card to the Step it is dropped on", async () => {
    const api = mockApi(
      routes({
        "POST /v1/tasks/:task/step": ({ body }) => {
          const moved = { ...copy, step_id: (body as { step: string }).step };
          api.routes["GET /v1/tasks"] = { items: projectTasks.map((t) => (t.id === moved.id ? moved : t)) };
          return moved;
        },
      }),
    );
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-1/);
    layOut();
    await carry("WEB-1", 1);
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === `/v1/tasks/${copy.id}/step`)).toBe(true));
    expect(api.calls.find((c) => c.path.endsWith("/step"))?.body).toEqual({ step: step.plan });
    await waitFor(() => expect(within(within(main()).getByRole("region", { name: "Plan" })).getByRole("link", { name: /WEB-1/ })).toBeInTheDocument());
  });

  it("refuses a held card dragged by someone who may not take it back, before asking /v1", async () => {
    const api = mockApi(routes({}, builder));
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-2/);
    layOut();
    await carry("WEB-2", 1);
    expect(await screen.findByText("builder holds WEB-2: only the Owner, ada, or someone above builder moves it.")).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("lets the holder's manager move a held card, and says the Claim ended", async () => {
    mockApi(routes({ "POST /v1/tasks/:task/step": ({ body }) => ({ ...cart, claim: undefined, step_id: (body as { step: string }).step }) }));
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-2/);
    layOut();
    await carry("WEB-2", 1);
    expect(await screen.findByText("WEB-2 moved to Review")).toBeInTheDocument();
    expect(screen.getByText("builder's Claim on it ended.")).toBeInTheDocument();
  });

  it("snaps a card back with the rule when /v1 refuses the move", async () => {
    mockApi(routes({ "POST /v1/tasks/:task/step": refuse(409, "conflict", "a Parent") }));
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-1/);
    layOut();
    await carry("WEB-1", 1);
    expect(await screen.findByText("WEB-1 became a Parent: its Subtasks stand at Steps, it does not.")).toBeInTheDocument();
    await waitFor(() => expect(within(within(main()).getByRole("region", { name: "Backlog" })).getByRole("link", { name: /WEB-1/ })).toBeInTheDocument());
  });

  it("says a drop on Done is reached by advancing, and sends nothing", async () => {
    const api = mockApi(routes());
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-1/);
    layOut();
    // Backlog → … → Skill review (5), With bob (6), Done (7).
    await carry("WEB-1", 7);
    expect(await screen.findByText(/Done is reached by its holder advancing WEB-1/)).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("renames a column when the Workflow changes", async () => {
    const api = mockApi(routes());
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-1/);
    const renamed = workflow();
    renamed.steps[3] = { ...renamed.steps[3], name: "Code review" };
    api.routes["GET /v1/projects/:project/workflow"] = renamed;
    act(() => FakeEventSource.latest().open());
    act(() => FakeEventSource.latest().emit("activity", { seq: 10, kind: "workflow.changed", subject_type: "workflow", subject_id: "p-web", at: new Date().toISOString(), payload: {} }, 10));
    expect(await within(main()).findByRole("region", { name: "Code review" })).toBeInTheDocument();
  });
});

describe("Tasks of a Project of several Workflows", () => {
  afterEach(() => vi.restoreAllMocks());
  const at = (n: number, title: string, stepId: string, workflowId: string) => task(n, { title, step_id: stepId, workflow_id: workflowId });
  const done = (n: number, title: string, workflowId: string | undefined) =>
    task(n, { title, state: "done", step_id: undefined, step_since: undefined, workflow_id: workflowId, ended_at: "2026-10-03T09:00:00Z" });
  const parent = parentTask(5, { open: 0, working: 0, done: 1, dropped: 0 }, { title: "Billing revamp", state: "done", ended_at: "2026-10-04T09:00:00Z", workflow_id: wfId.bugs });
  const tasks = [
    at(1, "Sort the inbox", wfStep.triage, wfId.triage),
    at(2, "Crash on save", wfStep.investigate, wfId.bugs),
    done(3, "Fixed login", wfId.bugs),
    at(4, "Refund request", wfStep.support, wfId.support),
    parent,
    subtask(6, parent, { title: "Charge twice", state: "done", step_id: undefined, step_since: undefined, workflow_id: wfId.bugs, ended_at: "2026-10-04T08:00:00Z" }),
  ];
  const several = () => routes({ "GET /v1/projects/:project/workflow": workflowsFixture(), "GET /v1/skills": { items: workflowsSkills }, "GET /v1/tasks": { items: tasks } });

  it("shows the first Workflow's board by default: Triage's one Step, Done and Dropped", async () => {
    mockApi(several());
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-1 Sort the inbox/);
    expect(regions()).toEqual(["Triage", "Done", "Dropped"]);
    expect(screen.queryByRole("link", { name: /WEB-3 Fixed login/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /WEB-2 Crash on save/ })).not.toBeInTheDocument();
  });

  it("shows the Workflow ?workflow= names, with the Tasks that ended in it in its Done", async () => {
    localStorage.setItem("darkory.tasks.display", JSON.stringify({ showParents: true }));
    mockApi(several());
    renderApp(`/projects/WEB/tasks?view=board&workflow=${wfId.bugs}`);
    await row(/WEB-2 Crash on save/);
    expect(regions()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done", "Dropped"]);
    const doneCol = within(main()).getByRole("region", { name: "Done" });
    expect(within(doneCol).getAllByRole("link").map((l) => l.getAttribute("data-task"))).toEqual(["WEB-3", "WEB-5", "WEB-6"]);
    // At every width: a phone has no other way to another Workflow.
    expect(screen.getByRole("button", { name: "Workflow: Bugs" }).closest(".hidden")).toBeNull();
  });

  it("reads an old link's long id in ?workflow= as the short id the API gives", async () => {
    const long = "0b9a3c1e-5f2d-4c7a-9e1b-2d3f4a5b6c7d";
    const short = toShort(long);
    const record = workflowsFixture();
    const renamed = {
      ...record,
      workflows: record.workflows.map((w) => (w.id === wfId.bugs ? { ...w, id: short } : w)),
      steps: record.steps.map((st) => (st.workflow_id === wfId.bugs ? { ...st, workflow_id: short } : st)),
    };
    mockApi(routes({ "GET /v1/projects/:project/workflow": renamed, "GET /v1/skills": { items: workflowsSkills }, "GET /v1/tasks": { items: tasks } }));
    renderApp(`/projects/WEB/tasks?view=board&workflow=${long}`);
    await row(/WEB-2 Crash on save/);
    expect(regions()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done", "Dropped"]);
  });

  it("the chip lists the five Workflows; picking Support shows its board, writes ?workflow= and is remembered", async () => {
    mockApi(several());
    const first = renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-1/);
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Triage" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
    expect(screen.getByRole("option", { name: "Triage" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("option", { name: "Support" }));
    await waitFor(() => expect(regions()).toEqual(["Support", "Awaiting customer", "Ops", "Approve", "Done", "Dropped"]));
    expect(screen.getByRole("button", { name: "Workflow: Support" })).toBeInTheDocument();
    // The address says the Workflow: a card's link keeps it.
    expect(await row(/WEB-4 Refund request/)).toHaveAttribute("href", expect.stringContaining(`workflow=${wfId.support}`));
    first.unmount();

    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-4 Refund request/);
    expect(regions()).toEqual(["Support", "Awaiting customer", "Ops", "Approve", "Done", "Dropped"]);
  });

  it("picks a Workflow with no storage to remember it in", async () => {
    const refused = () => {
      throw new DOMException("refused", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(refused);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(refused);
    mockApi(several());
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-1/);
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Triage" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bugs" }));
    await waitFor(() => expect(regions()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done", "Dropped"]));
  });

  it("shows the Workflow ?workflow= names over the one this browser remembers", async () => {
    localStorage.setItem(`darkory.workflow.WEB`, wfId.support);
    mockApi(several());
    renderApp(`/projects/WEB/tasks?view=board&workflow=${wfId.bugs}`);
    await row(/WEB-2 Crash on save/);
    expect(regions()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done", "Dropped"]);
  });

  it("passes over a ?workflow= that is no Workflow of the Project: the first is shown", async () => {
    mockApi(several());
    renderApp("/projects/WEB/tasks?view=board&workflow=wf-gone");
    await row(/WEB-1 Sort the inbox/);
    expect(regions()).toEqual(["Triage", "Done", "Dropped"]);
    expect(screen.getByRole("button", { name: "Workflow: Triage" })).toBeInTheDocument();
  });

  it("picking the Workflow shown remembers it", async () => {
    mockApi(several());
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-1/);
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Triage" }));
    await userEvent.click(await screen.findByRole("option", { name: "Triage" }));
    expect(localStorage.getItem("darkory.workflow.WEB")).toBe(wfId.triage);
  });

  it("keeps ?workflow= across the List and Board switch", async () => {
    mockApi(several());
    renderApp(`/projects/WEB/tasks?view=board&workflow=${wfId.bugs}`);
    await row(/WEB-2 Crash on save/);
    const view = () => screen.getByRole("navigation", { name: "View" });
    expect(within(view()).getByRole("link", { name: "List" })).toHaveAttribute("href", expect.stringContaining(`workflow=${wfId.bugs}`));
    await userEvent.click(within(view()).getByRole("link", { name: "List" }));
    await waitFor(() => expect(regions()).toContain("Bugs › Investigate"));
    await userEvent.click(within(view()).getByRole("link", { name: "Board" }));
    await waitFor(() => expect(regions()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done", "Dropped"]));
  });

  it("shows a question aimed at a Member in With <Member> on the board of the Task it blocks", async () => {
    // Where the server lists it: the Workflow of the Task it blocks.
    const asked = task(7, { title: "Which browser?", step_id: undefined, step_since: undefined, aimed_at_id: bob.id, workflow_id: wfId.bugs });
    const held = task(8, { title: "Blank page", step_id: wfStep.fix, workflow_id: wfId.bugs, blocked: true, open_blockers: [{ id: asked.id, key: asked.key, title: asked.title }] });
    mockApi(routes({ "GET /v1/projects/:project/workflow": workflowsFixture(), "GET /v1/skills": { items: workflowsSkills }, "GET /v1/tasks": { items: [...tasks, asked, held] } }));
    const bugs = renderApp(`/projects/WEB/tasks?view=board&workflow=${wfId.bugs}`);
    await row(/WEB-8 Blank page/);
    expect(regions()).toEqual(["Investigate", "Fix", "Review", "Verify", "With bob", "Done", "Dropped"]);
    expect(within(within(main()).getByRole("region", { name: "With bob" })).getByRole("link", { name: /WEB-7 Which browser\?/ })).toBeInTheDocument();
    bugs.unmount();

    renderApp(`/projects/WEB/tasks?view=board&workflow=${wfId.triage}`);
    await row(/WEB-1 Sort the inbox/);
    expect(regions()).toEqual(["Triage", "Done", "Dropped"]);
  });

  it("has no chip on a Project of one Workflow", async () => {
    mockApi(routes());
    renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-2/);
    expect(screen.queryByRole("button", { name: /^Workflow:/ })).not.toBeInTheDocument();
  });

  it("keeps the List | Board switch as two icons on a phone, beside the chip or not, on the bar's second row", async () => {
    // The board of several Workflows, with the chip in the crumbs; one Workflow's board; the list.
    mockApi(several());
    const chipped = renderApp(`/projects/WEB/tasks?view=board&workflow=${wfId.bugs}`);
    await row(/WEB-2 Crash on save/);
    expect(screen.getByRole("button", { name: /^Workflow:/ })).toBeInTheDocument();
    const switchIn = () => within(screen.getByRole("group", { name: "Page" })).getByRole("navigation", { name: "View" });
    expect(screen.queryByRole("button", { name: /^View: / })).not.toBeInTheDocument();
    expect(switchIn()).not.toHaveClass("hidden");
    const links = within(switchIn()).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual(["List", "Board"]);
    for (const l of links) expect(narrowHidden(within(l).getByText(l.getAttribute("aria-label")!))).toBe(true);
    chipped.unmount();
    mockApi(routes());
    const one = renderApp("/projects/WEB/tasks?view=board");
    await row(/WEB-2/);
    expect(screen.queryByRole("button", { name: /^View: / })).not.toBeInTheDocument();
    expect(within(switchIn()).getAllByRole("link").map((l) => l.getAttribute("aria-label"))).toEqual(["List", "Board"]);
    one.unmount();
    mockApi(several());
    renderApp("/projects/WEB/tasks?view=list");
    await row(/WEB-2 Crash on save/);
    expect(screen.queryByRole("button", { name: /^View: / })).not.toBeInTheDocument();
    expect(switchIn()).not.toHaveClass("hidden");
  });

  it("keeps Views, Filter, Display and File Task on the bar's second row beside the chip, each its icon alone on a narrow bar", async () => {
    mockApi(several());
    renderApp(`/projects/WEB/tasks?view=board&workflow=${wfId.bugs}`);
    await row(/WEB-2 Crash on save/);
    const group = screen.getByRole("group", { name: "Page" });
    expect(screen.queryByRole("button", { name: /^More/ })).not.toBeInTheDocument();
    for (const name of ["Views", "Filter", "Display", "File Task"]) {
      const button = within(group).getByRole("button", { name });
      expect(button).not.toHaveClass("max-sm:hidden");
      expect(narrowHidden(within(button).getByText(name))).toBe(true);
    }
    for (const [name, opens] of [
      ["Views", "Views"],
      ["Filter", "Filters"],
      ["Display", "Display"],
    ]) {
      await userEvent.click(within(group).getByRole("button", { name }));
      expect(await screen.findByRole("dialog", { name: opens })).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: opens })).not.toBeInTheDocument());
    }
    // F opens the Filters as it does from the button.
    await userEvent.keyboard("f");
    expect(await screen.findByRole("dialog", { name: "Filters" })).toBeInTheDocument();
  });

  it("names the count of Filters set on the Filter button, its label hidden on a narrow bar", async () => {
    mockApi(several());
    renderApp(`/projects/WEB/tasks?view=board&workflow=${wfId.bugs}&filter.tasks=kind:is:task&filter.tasks=blocked:is:false`);
    const filter = await screen.findByRole("button", { name: "Filter, 2 set" });
    expect(screen.getByRole("group", { name: "Page" })).toContainElement(filter);
    expect(narrowHidden(within(filter).getByText("Filter"))).toBe(true);
    expect(within(filter).getByText("2")).toBeInTheDocument();
  });

  it("grouped by other than Step, a row's Step reads with its Workflow", async () => {
    localStorage.setItem("darkory.tasks.display", JSON.stringify({ group: "owner" }));
    mockApi(several());
    renderApp("/projects/WEB/tasks?view=list");
    expect(await row(/WEB-2 Crash on save/)).toHaveTextContent("Bugs › Investigate");
  });

  it("the list keeps the whole Project, each Step group headed by its Workflow", async () => {
    mockApi(several());
    renderApp("/projects/WEB/tasks?view=list");
    await row(/WEB-1/);
    expect(regions()).toEqual(["Triage › Triage", "Bugs › Investigate", "Support › Support", "Done"]);
    expect(screen.getByRole("heading", { name: "Bugs › Investigate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Workflow:/ })).not.toBeInTheDocument();
  });
});
