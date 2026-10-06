import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Activity, Member, Task } from "@/api/client";
import { mockApi, refuse, type Handler } from "@/test/api";
import { FakeEventSource } from "@/test/eventSource";
import { ada, bob, build, builder, feature, me, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { statuses } from "./testData";

const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const checkout = feature(1, 2, { title: "Checkout flow" });
const search = feature(9, 1, { title: "Search" });
const onboarding = feature(18, 3, { title: "Onboarding emails", state: "shipped" });

const cart = task(3, "f-1", {
  title: "Build the cart page",
  status_id: "st-progress",
  blocked: true,
  open_blockers: [{ id: "k-8", key: "WEB-8" }],
  claim: { id: "c-3", task_id: "k-3", holder_id: builder.id, session_id: "s-1", started_at: inFuture(-1), expires_at: inFuture(15), heartbeat_timeout_seconds: 900, model_label: "claude-opus-5-5" },
});
const discount = task(5, "f-1", { title: "Discount codes", status_id: "st-backlog" });
const question = task(8, "f-1", { title: "Stripe keys for staging?", skill_id: undefined, aimed_at_id: bob.id });
const breakdown = task(10, "f-9", { title: "Break down: Search", kind: "breakdown" });
const welcome = task(20, "f-18", { title: "Welcome email", state: "done", status_id: "st-done" });
const rate = task(15, "f-1", { title: "Rate-limit sign-in", state: "dropped", status_id: "st-dropped" });

const lapse: Activity = { seq: 4, at: "2026-10-06T22:18:00Z", kind: "task.lapsed", subject_type: "task", subject_id: "k-5", payload: {} };

function routes(extra: Record<string, Handler> = {}, member: Member = ada): Record<string, Handler> {
  return {
    ...signedIn(member),
    "GET /v1/me": { ...me(member), teams: member === bob ? [] : [web] },
    "GET /v1/statuses": { items: statuses },
    "GET /v1/tasks": { items: [cart, discount, question, breakdown, welcome, rate] },
    "GET /v1/tasks/takeable": { items: [] },
    "GET /v1/features": { items: [checkout, search, onboarding] },
    "GET /v1/activity": { items: [lapse], last_seq: 4 },
    ...extra,
  };
}

const row = (name: RegExp) => screen.findByRole("link", { name });
// The list's groups and the board's columns: the regions of the page, not the toasts' region.
const groupNames = () => within(document.getElementById("main")!).getAllByRole("region").map((g) => g.getAttribute("aria-label"));

beforeEach(() => localStorage.clear());

describe("Team › Tasks, list", () => {
  it("groups rows by Status in the Organisation's order, with their marks", async () => {
    mockApi(routes());
    renderApp("/teams/WEB/tasks?view=list");

    expect(await screen.findByRole("heading", { name: "Tasks, list" })).toBeInTheDocument();
    await row(/WEB-3 Build the cart page/);
    expect(groupNames()).toEqual(["Backlog", "Todo", "In progress", "Done"]);

    expect(within(await row(/WEB-5 Discount codes/)).getByText(/^Lapsed /)).toBeInTheDocument();
    const held = await row(/WEB-3 Build the cart page/);
    expect(within(held).getByText("Blocked by WEB-8")).toBeInTheDocument();
    expect(within(held).getByRole("img", { name: "builder (agent)" })).toBeInTheDocument();
    expect(within(await row(/WEB-8 Stripe keys/)).getByText("blocks WEB-3")).toBeInTheDocument();
    expect(within(await row(/WEB-10 Break down/)).getByText("Break down")).toBeInTheDocument();
    // A row opens the Task's peek over the list.
    expect(held).toHaveAttribute("href", "/teams/WEB/tasks?view=list&task=WEB-3");
    expect(screen.getByText("5 Tasks · Dropped hidden (1)")).toBeInTheDocument();
  });

  it("groups by Feature in Rank order from Display, and remembers it", async () => {
    mockApi(routes());
    const first = renderApp("/teams/WEB/tasks?view=list");
    await row(/WEB-3/);
    await userEvent.click(screen.getByRole("button", { name: "Display" }));
    await userEvent.click(await screen.findByRole("button", { name: "Feature" }));
    await waitFor(() => expect(groupNames()).toEqual(["WEB-9 Search", "WEB-1 Checkout flow", "WEB-18 Onboarding emails"]));
    first.unmount();

    renderApp("/teams/WEB/tasks?view=list");
    await row(/WEB-3/);
    expect(groupNames()[0]).toBe("WEB-9 Search");
  });

  it("filters by Skill from the address, with a chip that clears it", async () => {
    mockApi(routes());
    renderApp("/teams/WEB/tasks?view=list&skill=build&blocked=1");
    await row(/WEB-3/);
    expect(screen.queryByRole("link", { name: /WEB-10/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear Blocked" }));
    expect(await row(/WEB-10/)).toBeInTheDocument();
  });
});

describe("Team › Tasks, board", () => {
  it("draws a column per Status, Dropped as a strip that opens", async () => {
    mockApi(routes());
    renderApp("/teams/WEB/tasks?view=board");
    expect(await screen.findByRole("heading", { name: "Tasks, board" })).toBeInTheDocument();
    const progress = await screen.findByRole("region", { name: "In progress" });
    const card = await within(progress).findByRole("link", { name: /WEB-3/ });
    expect(within(card).getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(within(card).getByText(/1[45] min/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /WEB-15/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show Dropped, 1" }));
    expect(await within(screen.getByRole("region", { name: "Dropped" })).findByRole("link", { name: /WEB-15/ })).toBeInTheDocument();
  });

  it("lets a Member of the Team move open cards, and nobody move ended ones", async () => {
    mockApi(routes());
    renderApp("/teams/WEB/tasks?view=board");
    expect(await screen.findByRole("link", { name: /WEB-5 Discount codes/ })).toHaveAttribute("data-movable", "true");
    expect(screen.getByRole("link", { name: /WEB-20 Welcome email/ })).toHaveAttribute("data-movable", "false");
  });

  it("does not let a Member outside the Team move a card, unless they hold it or own its Feature", async () => {
    // bob reviews WEB-12 from outside Web: a holder moves the card they work.
    const review = task(12, "f-1", { title: "Review the cart", claim: { id: "c-12", task_id: "k-12", holder_id: bob.id, session_id: "s-b", started_at: inFuture(-1) } });
    mockApi(routes({ "GET /v1/tasks": { items: [cart, discount, review] } }, bob));
    renderApp("/teams/WEB/tasks?view=board");
    const card = await screen.findByRole("link", { name: /WEB-5 Discount codes/ });
    expect(card).toHaveAttribute("data-movable", "false");
    expect(card).not.toHaveAttribute("aria-roledescription");
    expect(screen.getByRole("link", { name: /WEB-12 Review the cart/ })).toHaveAttribute("data-movable", "true");
  });

  it("lets the Feature's owner move its cards from outside the Team", async () => {
    mockApi(routes({ "GET /v1/features": { items: [{ ...checkout, owner_id: bob.id }, search, onboarding] } }, bob));
    renderApp("/teams/WEB/tasks?view=board");
    expect(await screen.findByRole("link", { name: /WEB-5 Discount codes/ })).toHaveAttribute("data-movable", "true");
    expect(screen.getByRole("link", { name: /WEB-10/ })).toHaveAttribute("data-movable", "false");
  });

  it("shows a bot's Claim as it arrives, without reloading", async () => {
    const api = mockApi(routes());
    renderApp("/teams/WEB/tasks?view=board");
    const todo = await screen.findByRole("region", { name: "Todo" });
    await within(todo).findByRole("link", { name: /WEB-10/ });
    act(() => FakeEventSource.latest().open());

    const claimed: Task = {
      ...breakdown,
      status_id: "st-progress",
      claim: { id: "c-10", task_id: "k-10", holder_id: builder.id, session_id: "s-2", started_at: inFuture(0), expires_at: inFuture(10), heartbeat_timeout_seconds: 600 },
    };
    api.routes["GET /v1/tasks"] = { items: [cart, discount, question, claimed, welcome, rate] };
    act(() => FakeEventSource.latest().emit("activity", { seq: 9, kind: "task.claimed", subject_type: "task", subject_id: "k-10", at: inFuture(0), payload: {} }, 9));

    const progress = screen.getByRole("region", { name: "In progress" });
    const card = await within(progress).findByRole("link", { name: /WEB-10/ });
    expect(within(card).getByRole("img", { name: "builder (agent)" })).toBeInTheDocument();
  });

  it("renames a column when the Workflow changes, and marks a lapse as the stream reports it", async () => {
    const api = mockApi(routes());
    renderApp("/teams/WEB/tasks?view=board");
    await screen.findByRole("region", { name: "In review" });
    act(() => FakeEventSource.latest().open());

    api.routes["GET /v1/statuses"] = { items: statuses.map((s) => (s.id === "st-review" ? { ...s, name: "Review" } : s)) };
    act(() => FakeEventSource.latest().emit("activity", { seq: 10, kind: "statuses.changed", subject_type: "statuses", subject_id: "o-1", at: inFuture(0), payload: {} }, 10));
    expect(await screen.findByRole("region", { name: "Review" })).toBeInTheDocument();

    act(() => FakeEventSource.latest().emit("activity", { seq: 11, kind: "task.lapsed", subject_type: "task", subject_id: "k-10", at: inFuture(0), payload: {} }, 11));
    expect(await within(await screen.findByRole("link", { name: /WEB-10/ })).findByText(/^Lapsed /)).toBeInTheDocument();
  });

  it("a column's + opens File Task in that Status", async () => {
    const api = mockApi(routes({ "POST /v1/tasks": { task: { ...discount, id: "k-30", key: "WEB-30", title: "Gift cards" } } }));
    renderApp("/teams/WEB/tasks?view=board");
    await userEvent.click(await screen.findByRole("button", { name: "File a Task in Backlog" }));
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    expect(within(dialog).getByRole("combobox", { name: "Status" })).toHaveTextContent("Backlog");

    await userEvent.click(within(dialog).getByRole("combobox", { name: "Feature" }));
    await userEvent.click(await screen.findByRole("option", { name: /Checkout flow/ }));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Gift cards");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Who can take it" }));
    await userEvent.click(await screen.findByRole("option", { name: "build" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "File a Task" })).not.toBeInTheDocument());
    const filed = api.calls.find((c) => c.method === "POST" && c.path === "/v1/tasks");
    expect(filed?.body).toEqual({ feature: "WEB-1", title: "Gift cards", skill: build.id, status: "st-backlog" });
  });
});

describe("File Task", () => {
  it("refuses a blank Feature and Title in the dialog, before asking the server", async () => {
    const api = mockApi(routes());
    renderApp("/teams/WEB/tasks?view=list");
    await row(/WEB-3/);
    await userEvent.keyboard("c");
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    expect(within(dialog).getByRole("combobox", { name: "Status" })).toHaveTextContent("Todo");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    expect(within(dialog).getByText("Choose a Feature.")).toBeInTheDocument();
    expect(within(dialog).getByText("Name the Task.")).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("File Feature", () => {
  it("says in words that only the Team's Members file its Features", async () => {
    mockApi(routes({ "POST /v1/features": refuse(403, "forbidden", "only a Member of Team WEB may file a Feature in it") }, bob));
    renderApp("/teams/WEB/features");
    await userEvent.click(await screen.findByRole("button", { name: "File Feature" }));
    const dialog = await screen.findByRole("dialog", { name: "File a Feature" });
    expect(dialog).toHaveTextContent("Also files its Break down Task");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Gift cards");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Feature" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Only Members of Web file its Features; an admin can add you to Web.");
  });
});

describe("Team › Features", () => {
  it("lists open Features in Rank order; Display adds the ended ones with their pill", async () => {
    mockApi(routes());
    renderApp("/teams/WEB/features");
    const list = await screen.findByRole("list", { name: "Features in Rank order" });
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("data-feature"))).toEqual(["WEB-9", "WEB-1"]);
    expect(within(list).getAllByText("0 done · 1 open")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Display" }));
    await userEvent.click(await screen.findByRole("switch", { name: "Shipped and dropped" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(within(list).getByText("Shipped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Shipped and dropped: shown" })).toBeInTheDocument();
  });

  it("offers the grip to a Member of the Team only", async () => {
    mockApi(routes());
    const first = renderApp("/teams/WEB/features");
    expect(await screen.findByRole("button", { name: "Move WEB-1 in the Rank" })).toBeInTheDocument();
    first.unmount();

    mockApi(routes({}, bob));
    renderApp("/teams/WEB/features");
    await screen.findByRole("list", { name: "Features in Rank order" });
    expect(screen.queryByRole("button", { name: /Move WEB-1/ })).not.toBeInTheDocument();
  });
});
