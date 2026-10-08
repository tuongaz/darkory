import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, refuse } from "@/test/api";
import { FakeEventSource } from "@/test/eventSource";
import { bob, builder, step, workflow } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { cart, copy, payment, projectTasks, receipt, routes } from "./testData";

const row = (name: RegExp) => screen.findByRole("link", { name });
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
    expect(within(held).getByText(/lapses in 1[45] min/)).toBeInTheDocument();
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
