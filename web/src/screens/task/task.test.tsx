import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Activity, Member, Task, TaskDetail } from "@/api/client";
import { mockApi, refuse, type Call, type Handler } from "@/test/api";
import { ada, bob, builder, bug, clientX, detail, step } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { basket, cart, checkout, copy, liveClaimOf, payment, receipt, routes } from "../board/testData";

beforeEach(() => localStorage.clear());

const at = (min: number) => new Date(Date.now() - (60 - min) * 60_000).toISOString();
const atReview = { ...receipt, claim: liveClaimOf(builder, receipt.id) };

const details: Record<string, TaskDetail> = {
  "WEB-1": detail(copy),
  "WEB-2": detail({ ...cart, step_since: at(10) }, { claims: [cart.claim!], labels: [clientX] }),
  "WEB-3": detail(checkout, { subtasks: [payment, receipt, basket] }),
  "WEB-4": detail(payment, { parent: { id: checkout.id, key: checkout.key, title: checkout.title }, claims: [payment.claim!] }),
  "WEB-5": detail(atReview, { parent: { id: checkout.id, key: checkout.key, title: checkout.title }, claims: [atReview.claim!] }),
};

const path: Activity[] = [
  { seq: 1, at: at(0), kind: "task.filed", subject_type: "task", subject_id: cart.id, payload: { step_id: step.backlog } },
  { seq: 2, at: at(10), kind: "task.moved", subject_type: "task", subject_id: cart.id, actor_id: ada.id, payload: { from: step.backlog, to: step.build, since: Date.parse(at(0)) } },
];

function taskRoutes(extra: Record<string, Handler> = {}, member: Member = ada) {
  return routes(
    {
      "GET /v1/tasks/:task": ({ params }) => details[params.task] ?? refuse(404, "not_found", "No such Task"),
      "GET /v1/activity": ({ query }) => ({ items: query.getAll("kind").includes("task.filed") ? path : [], last_seq: 2 }),
      ...extra,
    },
    member,
  );
}

const posted = (api: { calls: Call[] }, suffix: string) => api.calls.find((c) => c.method !== "GET" && c.path.endsWith(suffix));
/** The top bar: the crumbs, the ⋯ menu and the primary. */
const bar = async () => within((await screen.findByRole("navigation", { name: "Breadcrumb" })).closest("header")!);

describe("a Task's page", () => {
  it("heads with its key, title, Step and Skill, Owner, Rank, Labels and its path through the Steps", async () => {
    const api = mockApi(taskRoutes());
    renderApp("/tasks/WEB-2");
    expect(await screen.findByRole("heading", { level: 1, name: "Build the cart page" })).toBeInTheDocument();
    const head = screen.getByRole("heading", { level: 1 }).closest("header")!;
    expect(head).toHaveTextContent("Build");
    expect(within(head).getByText("engineer")).toBeInTheDocument();
    expect(head).toHaveTextContent(/Owner\s*A?ada· you/);
    expect(head).toHaveTextContent("Rank #2");
    expect(within(head).getByRole("button", { name: "Labels: client-x" })).toBeInTheDocument();
    const stepper = await within(head).findByRole("list", { name: "Path through the Steps" });
    await waitFor(() => expect(within(stepper).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Backlog10 min", "moved", expect.stringMatching(/^Build50 min/)]));
    expect(within(stepper).getByText("Build").closest("li")).toHaveAttribute("aria-current", "step");
    // The path is one read of the Task's own Activity.
    const reads = api.calls.filter((c) => c.path === "/v1/activity");
    expect(reads).toHaveLength(1);
    expect(reads[0].query.get("task")).toBe(cart.id);
    expect(reads[0].query.get("project")).toBeNull();
    // The record says who moved it, from where.
    expect(await screen.findByText(/moved it from Backlog to/)).toBeInTheDocument();
    // Its crumbs lead to its Project, which the sidebar follows.
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Web/Tasks/WEB-2");
  });

  it("gives the holder Advance along the first outcome, the rest and Release in its caret", async () => {
    const api = mockApi(taskRoutes({ "POST /v1/tasks/:task/advance": cart }, builder));
    renderApp("/tasks/WEB-5");
    const primary = await (await bar()).findByRole("button", { name: "Complete · pass" });
    await userEvent.click((await bar()).getByRole("button", { name: "More ways to end the Claim" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Advance · needs changes", "Release"]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(primary);
    const dialog = await screen.findByRole("dialog", { name: "Complete WEB-5 · pass" });
    expect(dialog).toHaveTextContent("WEB-5 ends Done");
    await userEvent.type(within(dialog).getByLabelText(/^Note/), "Sent");
    await userEvent.click(within(dialog).getByRole("button", { name: "Complete" }));
    await waitFor(() => expect(posted(api, "/advance")).toBeDefined());
    expect(posted(api, "/advance")!.body).toEqual({ outcome: "pass", note: "Sent" });
  });

  it("names where an advance into a Step leaves the Task, and says a refusal's outcomes in words", async () => {
    mockApi(taskRoutes({ "POST /v1/tasks/:task/advance": () => new Response(JSON.stringify({ code: "no_connector", message: "no", details: { outcomes: ["pass", "fail"] } }), { status: 409, headers: { "Content-Type": "application/json" } }) }, builder));
    renderApp("/tasks/WEB-2");
    await userEvent.click(await (await bar()).findByRole("button", { name: "Advance · pass" }));
    const dialog = await screen.findByRole("dialog", { name: "Advance WEB-2 · pass" });
    await waitFor(() => expect(dialog).toHaveTextContent("Waits at Review for review; your Claim ends"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Advance" }));
    expect(await within(dialog).findByText("WEB-2 leaves its Step along one of: pass, fail.")).toBeInTheDocument();
  });

  it("lets the holder file a Subtask, which ends their Claim", async () => {
    mockApi(taskRoutes({}, builder));
    renderApp("/tasks/WEB-2");
    await (await bar()).findByRole("button", { name: "Advance · pass" });
    await userEvent.click((await bar()).getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "File Subtask" }));
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    expect(await within(dialog).findByText("This ends your Claim on WEB-2")).toBeInTheDocument();
  });

  it("gives the holder's manager Take back and Move, and the Owner Drop", async () => {
    mockApi(taskRoutes());
    renderApp("/tasks/WEB-2");
    await screen.findByRole("heading", { level: 1, name: "Build the cart page" });
    expect((await bar()).queryByRole("button", { name: /Advance/ })).not.toBeInTheDocument();
    await userEvent.click((await bar()).getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Take back", "Move to a Step", "Rank", "Pass ownership", "Drop Task"]);
    // Only the holder writes a Note on a held Task.
    expect(screen.getByText("Only builder can add a Note")).toBeInTheDocument();
  });

  it("moves a held Task by hand, saying whose Claim ends", async () => {
    const api = mockApi(taskRoutes({ "POST /v1/tasks/:task/step": cart }));
    renderApp("/tasks/WEB-2");
    await screen.findByRole("heading", { level: 1, name: "Build the cart page" });
    await userEvent.click((await bar()).getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move to a Step" }));
    const dialog = await screen.findByRole("dialog", { name: "Move WEB-2" });
    expect(dialog).toHaveTextContent("Ends builder's Claim");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Step" }));
    await userEvent.click(await screen.findByRole("option", { name: /Review/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(posted(api, "/step")?.body).toEqual({ step: step.review }));
  });

  it("dims Drop for anyone but the Owner", async () => {
    mockApi(taskRoutes({}, bob));
    renderApp("/tasks/WEB-1");
    await screen.findByRole("heading", { level: 1, name: "Draft the launch copy" });
    await userEvent.click((await bar()).getByRole("button", { name: "More" }));
    const drop = await screen.findByRole("menuitem", { name: /Drop Task/ });
    expect(drop).toHaveAttribute("aria-disabled", "true");
    expect(drop).toHaveTextContent("Owner only");
  });

  it("claims a Task the Member can take", async () => {
    const api = mockApi(taskRoutes({ "GET /v1/tasks/takeable": { items: [copy] }, "POST /v1/tasks/:task/claim": copy }));
    renderApp("/tasks/WEB-1");
    await userEvent.click(await (await bar()).findByRole("button", { name: "Claim" }));
    await waitFor(() => expect(posted(api, "/claim")?.body).toEqual({ heartbeat_timeout_seconds: 0 }));
  });

  it("sets its Labels from the head, the whole set in one write", async () => {
    const api = mockApi(taskRoutes({ "PUT /v1/tasks/:task/labels": cart }));
    renderApp("/tasks/WEB-2");
    await userEvent.click(await screen.findByRole("button", { name: "Labels: client-x" }));
    await userEvent.click(await screen.findByRole("option", { name: /bug/ }));
    await waitFor(() => expect(posted(api, "/labels")?.body).toEqual({ labels: [clientX.id, bug.id] }));
  });
});

describe("a Parent's page", () => {
  it("lets its Owner Complete only once every Subtask has ended", async () => {
    const api = mockApi(taskRoutes({ "POST /v1/tasks/:task/complete": checkout }, bob));
    const first = renderApp("/tasks/WEB-3");
    const complete = await (await bar()).findByRole("button", { name: "Complete" });
    expect(complete).toBeDisabled();
    first.unmount();

    const ended: Task = { ...checkout, subtask_counts: { open: 0, working: 0, done: 3, dropped: 0 } };
    details["WEB-3"] = detail(ended, { subtasks: [] });
    try {
      renderApp("/tasks/WEB-3");
      await userEvent.click(await (await bar()).findByRole("button", { name: "Complete" }));
      const dialog = await screen.findByRole("dialog", { name: "Complete WEB-3" });
      expect(dialog).toHaveTextContent("WEB-3 ends Done; its Retrospective is filed at Retro");
      await userEvent.click(within(dialog).getByRole("button", { name: "Complete" }));
      await waitFor(() => expect(posted(api, "/complete")).toBeDefined());
    } finally {
      details["WEB-3"] = detail(checkout, { subtasks: [payment, receipt, basket] });
    }
  });

  it("lists its Subtasks, and draws them over the Workflow as a graph, remembered", async () => {
    mockApi(taskRoutes());
    const first = renderApp("/tasks/WEB-3");
    const section = await screen.findByRole("region", { name: "Subtasks" });
    expect(section).toHaveTextContent("1/3 done");
    expect(within(section).getAllByRole("link").map((l) => l.getAttribute("data-task"))).toEqual(["WEB-4", "WEB-5", "WEB-6"]);
    await userEvent.click(within(section).getByRole("button", { name: "Graph" }));
    const graph = await within(section).findByRole("region", { name: "Subtasks, graph" });
    // builder works WEB-4 and WEB-5; WEB-6 is done; none is takeable now.
    expect(within(graph).getByRole("button", { name: /^WEB-4 Payment form, .*held by builder/ })).toBeInTheDocument();
    expect(within(graph).getByRole("button", { name: /^WEB-6 Basket icon, Done/ })).toBeInTheDocument();
    await userEvent.click(within(graph).getByRole("button", { name: /^WEB-4 / }));
    expect(await screen.findByRole("dialog", { name: "Task WEB-4" })).toBeInTheDocument();
    first.unmount();

    renderApp("/tasks/WEB-3");
    expect(await screen.findByRole("region", { name: "Subtasks, graph" })).toBeInTheDocument();
  });

  it("offers Add Subtask to a Member of its Project", async () => {
    mockApi(taskRoutes());
    renderApp("/tasks/WEB-3");
    const section = await screen.findByRole("region", { name: "Subtasks" });
    await userEvent.click(within(section).getByRole("button", { name: "Add Subtask" }));
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    await waitFor(() => expect(dialog).toHaveTextContent("In WEB, under WEB-3."));
  });
});

describe("a Subtask's peek", () => {
  it("links its Parent and reports its Project", async () => {
    mockApi(taskRoutes());
    renderApp("/inbox?task=WEB-4");
    const peek = await screen.findByRole("dialog", { name: "Task WEB-4" });
    expect(await within(peek).findByRole("link", { name: /Parent\s*WEB-3\s*Checkout/ })).toHaveAttribute("href", "/inbox?task=WEB-3");
    await waitFor(() => expect(screen.getByRole("button", { name: "Project: Web" })).toBeInTheDocument());
  });
});
