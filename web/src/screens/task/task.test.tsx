import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Member, Task, TaskDetail } from "@/api/client";
import { mergeBase } from "./pullRequest";
import { mockApi, refuse, type Call, type Handler } from "@/test/api";
import { ada, bob, builder, bug, clientX, detail, step, wfId, wfStep, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { basket, cart, checkout, copy, liveClaimOf, payment, projectTasks, receipt, routes } from "../board/testData";

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
    await waitFor(() => expect(within(stepper).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Backlog10m", "moved", expect.stringMatching(/^Build50m/)]));
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
    // Of one Workflow, the Steps alone: no group names a Workflow.
    await screen.findAllByRole("option");
    expect(screen.queryAllByRole("group")).toEqual([]);
    await userEvent.click(await screen.findByRole("option", { name: /Review/ }));
    expect(within(dialog).getByRole("combobox", { name: "Step" })).toHaveTextContent(/^Review$/);
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

describe("a Task in a Project of several Workflows (ADR 0019)", () => {
  const five = { "GET /v1/projects/:project/workflow": workflowsFixture(), "GET /v1/skills": { items: workflowsSkills } };
  const outOf = (stepId: string) => workflowsFixture().connectors.filter((c) => c.from_step_id === stepId);
  // WEB-7, held by builder at Triage; WEB-8, at Investigate, came there from Triage along bug.
  const sorting: Task = { ...cart, id: "t-sort", key: "WEB-7", title: "Sort the report", blocked: false, open_blockers: [], step_id: wfStep.triage, workflow_id: wfId.triage, claim: liveClaimOf(builder, "t-sort") };
  const crashing: Task = { ...cart, id: "t-crash", key: "WEB-8", title: "Crash on save", blocked: false, open_blockers: [], step_id: wfStep.investigate, workflow_id: wfId.bugs, step_since: at(30), claim: undefined };
  const crossed: Activity[] = [
    { seq: 1, at: at(0), kind: "task.filed", subject_type: "task", subject_id: crashing.id, payload: { step_id: wfStep.triage } },
    { seq: 2, at: at(30), kind: "task.advanced", subject_type: "task", subject_id: crashing.id, actor_id: builder.id, payload: { from: wfStep.triage, to: wfStep.investigate, outcome: "bug", since: Date.parse(at(0)) } },
  ];
  beforeEach(() => {
    details["WEB-7"] = detail(sorting, { connectors: outOf(wfStep.triage), claims: [sorting.claim!] });
    details["WEB-8"] = detail(crashing, { connectors: outOf(wfStep.investigate) });
  });

  it("Advance names the Workflow a crossing outcome leads into, its caret likewise, and the dialog where the Task waits", async () => {
    mockApi(taskRoutes(five, builder));
    renderApp("/tasks/WEB-7");
    const primary = await (await bar()).findByRole("button", { name: "Advance · bug → Bugs › Investigate" });
    await userEvent.click((await bar()).getByRole("button", { name: "More ways to end the Claim" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Advance · feature → Features › Build",
      "Advance · prototype → Prototypes › Sketch",
      "Advance · question → Support › Support",
      "Release",
    ]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(primary);
    const dialog = await screen.findByRole("dialog", { name: "Advance WEB-7 · bug" });
    await waitFor(() => expect(dialog).toHaveTextContent("Waits at Bugs › Investigate for engineer; your Claim ends"));
  });

  it("an outcome within the Task's own Workflow names its Step alone", async () => {
    details["WEB-8"] = detail({ ...crashing, claim: liveClaimOf(builder, crashing.id) }, { connectors: outOf(wfStep.investigate), claims: [liveClaimOf(builder, crashing.id)] });
    mockApi(taskRoutes(five, builder));
    renderApp("/tasks/WEB-8");
    await userEvent.click(await (await bar()).findByRole("button", { name: "Advance · fix" }));
    const dialog = await screen.findByRole("dialog", { name: "Advance WEB-8 · fix" });
    await waitFor(() => expect(dialog).toHaveTextContent("Waits at Fix for engineer; your Claim ends"));
  });

  it("Move offers the Steps under their Workflows, the Task's own first", async () => {
    const api = mockApi(taskRoutes({ ...five, "POST /v1/tasks/:task/step": crashing }));
    renderApp("/tasks/WEB-8");
    await screen.findByRole("heading", { level: 1, name: "Crash on save" });
    await userEvent.click((await bar()).getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move to a Step" }));
    const dialog = await screen.findByRole("dialog", { name: "Move WEB-8" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Step" }));
    const groups = await screen.findAllByRole("group");
    expect(groups.map((g) => g.firstChild?.textContent)).toEqual(["Bugs", "Triage", "Features", "Prototypes", "Support"]);
    // Its own Step is not offered.
    expect(within(groups[0]).getAllByRole("option").map((o) => o.textContent)).toEqual(["Fixengineer", "Reviewreview", "Verifyqa"]);
    await userEvent.click(within(groups[3]).getByRole("option", { name: /Sketch/ }));
    // The choice reads with its Workflow, not its Skill: the list's groups are gone once it closes.
    expect(within(dialog).getByRole("combobox", { name: "Step" })).toHaveTextContent(/^Prototypes › Sketch$/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(posted(api, "/step")?.body).toEqual({ step: wfStep.sketch }));
  });

  it("its path names the Workflow it crossed into, before that Workflow's first Step", async () => {
    mockApi(taskRoutes({ ...five, "GET /v1/activity": ({ query }) => ({ items: query.getAll("kind").includes("task.filed") ? crossed : [], last_seq: 2 }) }));
    renderApp("/tasks/WEB-8");
    const head = (await screen.findByRole("heading", { level: 1, name: "Crash on save" })).closest("header")!;
    const stepper = await within(head).findByRole("list", { name: "Path through the Steps" });
    // The crossing reads with the Step it reaches, in its item: no item of the path is not a Step or an outcome.
    await waitFor(() => expect(within(stepper).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringMatching(/^Triage/), "bug", expect.stringMatching(/^Bugs ›Investigate/)]));
  });

  it("its line draws the Workflow it is in, lighting the entry it came in by", async () => {
    mockApi(taskRoutes({ ...five, "GET /v1/activity": ({ query }) => ({ items: query.getAll("kind").includes("task.filed") ? crossed : [], last_seq: 2 }) }));
    renderApp("/tasks/WEB-8");
    const line = await screen.findByRole("region", { name: "WEB-8's way through the Workflow" });
    await waitFor(() => expect([...line.querySelectorAll("[data-head]")].map((e) => e.getAttribute("data-head"))).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]));
    const came = await waitFor(() => {
      const el = line.querySelector('[data-lit="true"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(came).toHaveTextContent("from Triage · bug");
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

  it("heads an open Parent with Open, its Subtasks' progress said once, in their section", async () => {
    mockApi(taskRoutes());
    renderApp("/tasks/WEB-3");
    const head = (await screen.findByRole("heading", { level: 1, name: checkout.title })).parentElement!;
    expect(within(head).getByText("Open")).toBeInTheDocument();
    expect(head).not.toHaveTextContent("Its Subtasks");
    expect(await screen.findByRole("region", { name: "Subtasks" })).toHaveTextContent("1/3 done");
  });

  it("renders its description and its Notes as Markdown, links to the web only", async () => {
    const note = { id: "n-1", task_id: copy.id, author_id: builder.id, body: "Ran `make check`.\n- [the PR](https://github.com/o/r/pull/7)\n- [x](javascript:alert(1))", created_at: at(20) };
    mockApi(taskRoutes({ "GET /v1/tasks/:task": () => detail({ ...copy, description: "## Goal\nShip **the copy**" }, { notes: [note] }) }));
    renderApp("/tasks/WEB-1");
    const head = (await screen.findByRole("heading", { level: 1, name: "Draft the launch copy" })).closest("header")!;
    expect(within(head).getByText("the copy").tagName).toBe("STRONG");
    expect(within(head).getByText("Goal").tagName).toBe("P");
    const body = await screen.findByRole("article", { name: "Note by builder" });
    expect(within(body).getByText("make check").tagName).toBe("CODE");
    expect(within(body).getByRole("link", { name: "the PR" })).toHaveAttribute("target", "_blank");
    expect(within(body).getAllByRole("link")).toHaveLength(1);
    expect(within(body).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["the PR", "x"]);
  });

  it("says why nobody holds a Parent or an ended Task, so its Properties are never empty", async () => {
    mockApi(taskRoutes());
    const parent = renderApp("/tasks/WEB-3");
    expect(await screen.findByRole("complementary", { name: "Properties" })).toHaveTextContent("Held byNobody: a Parent is never claimed");
    parent.unmount();

    details["WEB-1"] = detail({ ...copy, state: "dropped", step_id: undefined, claim: undefined });
    try {
      renderApp("/tasks/WEB-1");
      expect(await screen.findByRole("complementary", { name: "Properties" })).toHaveTextContent("Held byNobody: it ended Dropped");
    } finally {
      details["WEB-1"] = detail(copy);
    }
  });

  it("draws a worked Task's way through the Workflow on the line, with Workflow → to the Project's line at it", async () => {
    mockApi(taskRoutes());
    renderApp("/tasks/WEB-2");
    const line = await screen.findByRole("region", { name: "WEB-2's way through the Workflow" });
    await waitFor(() => expect(line.querySelector('button[data-task="WEB-2"]')).not.toBeNull());
    expect(screen.getByRole("link", { name: "Workflow, at WEB-2" })).toHaveAttribute("href", expect.stringMatching(/^\/projects\/WEB\/workflows\?scope=/));
  });

  it("draws its Subtasks on the Workflow line first, lists them, and remembers the choice", async () => {
    mockApi(taskRoutes());
    const first = renderApp("/tasks/WEB-3");
    const section = await screen.findByRole("region", { name: "Subtasks" });
    expect(section).toHaveTextContent("1/3 done");
    const line = await within(section).findByRole("region", { name: "Subtask line" });
    // builder works WEB-4 and WEB-5 at their Steps; WEB-6 ended Done and stands green at Done.
    await waitFor(() => expect(line.querySelector('button[data-task="WEB-4"]')).toHaveAccessibleName(/^WEB-4 Payment form, held by builder/));
    expect(line.querySelector('button[data-task="WEB-6"]')).toHaveAttribute("data-state", "done");
    await userEvent.click(line.querySelector<HTMLElement>('button[data-task="WEB-4"]')!);
    await userEvent.click(await screen.findByRole("button", { name: /Open WEB-4/ }));
    expect(await screen.findByRole("dialog", { name: "Task WEB-4" })).toBeInTheDocument();
    first.unmount();

    const second = renderApp("/tasks/WEB-3");
    const again = await screen.findByRole("region", { name: "Subtasks" });
    await userEvent.click(within(again).getByRole("button", { name: "List" }));
    expect(within(again).getAllByRole("link").map((l) => l.getAttribute("data-task"))).toEqual(["WEB-4", "WEB-5", "WEB-6"]);
    second.unmount();
    renderApp("/tasks/WEB-3");
    const third = await screen.findByRole("region", { name: "Subtasks" });
    expect(within(third).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  });

  it("of a Project of several Workflows, draws the Workflow of its first open Subtask and says where the others are", async () => {
    // In ADR 0019's five Workflows Review is Bugs' and Build is Features': WEB-5 waits at Review,
    // WEB-4 is worked at Build. Bugs comes first, so the line draws Bugs.
    mockApi(taskRoutes({ "GET /v1/projects/:project/workflow": workflowsFixture(), "GET /v1/skills": { items: workflowsSkills } }));
    renderApp("/tasks/WEB-3?view=line");
    const section = await screen.findByRole("region", { name: "Subtasks" });
    const line = await within(section).findByRole("region", { name: "Subtask line" });
    await waitFor(() => expect(line.querySelector('button[data-task="WEB-5"]')).not.toBeNull());
    expect([...line.querySelectorAll("[data-head]")].map((e) => e.getAttribute("data-head"))).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]);
    expect(line.querySelector('button[data-task="WEB-4"]')).toBeNull();
    // WEB-4 does not vanish: the header says it is on Features' line.
    expect(section.querySelector("[data-elsewhere]")).toHaveTextContent("· 1 in Features");
    await userEvent.click(within(section).getByRole("button", { name: "List" }));
    expect(section.querySelector("[data-elsewhere]")).toBeNull();
  });

  it("opens the Blocking among its Subtasks from the old graph's address", async () => {
    mockApi(taskRoutes());
    renderApp("/tasks/WEB-3?view=graph");
    const section = await screen.findByRole("region", { name: "Subtasks" });
    expect(within(section).getByRole("button", { name: "Blocking" })).toHaveAttribute("aria-pressed", "true");
  });

  it("lists a Subtask Darkory filed without its kind's pill when its title already says it", async () => {
    const retro: Task = { ...basket, id: "t-retro", key: "WEB-9", kind: "retrospective", title: "Retrospective: Checkout", state: "open", step_id: step.retro };
    const accept: Task = { ...basket, id: "t-acc", key: "WEB-10", kind: "acceptance", title: "Check it all", state: "open", step_id: step.review };
    details["WEB-3"] = detail(checkout, { subtasks: [payment, retro, accept] });
    try {
      mockApi(taskRoutes());
      renderApp("/tasks/WEB-3?view=list");
      const section = await screen.findByRole("region", { name: "Subtasks" });
      const row = (key: string) => within(section).getByRole("link", { name: new RegExp(`^${key} `) });
      expect(within(await waitFor(() => row("WEB-9"))).queryByText("Retrospective", { exact: true })).toBeNull();
      expect(within(row("WEB-10")).getByText("Acceptance", { exact: true })).toBeInTheDocument();
    } finally {
      details["WEB-3"] = detail(checkout, { subtasks: [payment, receipt, basket] });
    }
  });

  it("offers Add Subtask to a Member of its Project", async () => {
    mockApi(taskRoutes());
    renderApp("/tasks/WEB-3");
    const section = await screen.findByRole("region", { name: "Subtasks" });
    await userEvent.click(within(section).getByRole("button", { name: "Add Subtask" }));
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Parent" })).toHaveTextContent("WEB-3"));
    expect(within(dialog).getByRole("combobox", { name: "Project" })).toHaveTextContent("Web");
  });
});

describe("a Task's pull request", () => {
  const url = "https://github.com/o/r/pull/7";
  const repo = { id: "w-1", name: "darkory", kind: "git" as const, path: "/src/darkory", mode: "pull_request" as const, default_branch: "trunk", created_at: at(0) };
  const landed = (state: "open" | "merged", extra: Partial<Task> = {}) => {
    const t: Task = { ...copy, state: "done", ended_at: at(30), step_id: undefined, workspace_ids: [repo.id], pull_request: { number: 7, url, state }, ...extra };
    return detail(t, { workspaces: [repo] });
  };
  const runner = (on: boolean) => ({ "GET /v1/runner/sessions": { items: [], runner: on } });

  it("says it on the facts line after the branch and in the rail's Workspace group, a link to GitHub", async () => {
    mockApi(taskRoutes({ "GET /v1/tasks/:task": landed("open"), ...runner(false) }));
    renderApp("/tasks/WEB-1");
    const head = (await screen.findByRole("heading", { level: 1 })).closest("header")!;
    const chip = within(head).getByRole("link", { name: "#7 open" });
    expect(chip).toHaveAttribute("href", url);
    expect(chip).toHaveAttribute("target", "_blank");
    expect(chip).toHaveAttribute("rel", "noreferrer noopener");
    const workspace = screen.getByRole("region", { name: "Workspace" });
    expect(workspace).toHaveTextContent("Pull request");
    expect(within(workspace).getByRole("link", { name: "#7 open" })).toHaveAttribute("href", url);
    // No Runner beside the server: no Merge; the chip is the way to GitHub.
    expect((await bar()).queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
  });

  it("gives its Owner Merge while it is open and a Runner is attached; the dialog says the pull request lands on its base", async () => {
    const api = mockApi(
      taskRoutes({
        // Renamed since its branch was made: the dialog names no branch from the title.
        "GET /v1/tasks/:task": landed("open", { title: "Renamed since" }),
        ...runner(true),
        "POST /v1/tasks/:task/pull-request/merge": refuse(409, "conflict", "Pull request #7 is not mergeable: checks failing"),
      }),
    );
    renderApp("/tasks/WEB-1");
    await userEvent.click(await (await bar()).findByRole("button", { name: "Merge" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge #7 into trunk" });
    expect(dialog).toHaveTextContent("#7 lands on trunk");
    expect(dialog).not.toHaveTextContent("web-1-renamed-since");
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(posted(api, "/pull-request/merge")).toBeDefined());
    expect(posted(api, "/pull-request/merge")?.path).toBe(`/v1/tasks/${copy.id}/pull-request/merge`);
    // GitHub's refusal stays in the dialog, in its words.
    expect(await within(dialog).findByText(/checks failing/)).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Merge #7 into trunk" })).toBeInTheDocument();
  });

  it("gives Merge to no one else, and none once merged", async () => {
    mockApi(taskRoutes({ "GET /v1/tasks/:task": landed("open"), ...runner(true) }, bob));
    const page = renderApp("/tasks/WEB-1");
    await screen.findByRole("heading", { level: 1 });
    expect((await bar()).queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    page.unmount();

    mockApi(taskRoutes({ "GET /v1/tasks/:task": landed("merged"), ...runner(true) }));
    renderApp("/tasks/WEB-1");
    const head = (await screen.findByRole("heading", { level: 1 })).closest("header")!;
    expect(within(head).getByRole("link", { name: "#7 merged" })).toHaveAttribute("href", url);
    expect((await bar()).queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
  });

  it("names the Workspace's default branch, main when the Task names none, or its Parent's branch for a Subtask", () => {
    expect(mergeBase(landed("open"), [])).toBe("trunk");
    const plain = { ...landed("open"), workspaces: [] };
    expect(mergeBase(plain, [])).toBe("main");
    expect(mergeBase(plain, [repo], repo.id)).toBe("trunk");
    // A Subtask lands on its Parent's branch, the Parent's key alone, as the Runner names it.
    expect(mergeBase({ ...landed("open"), parent: { id: "k-9", key: "WEB-9", title: "Checkout" } }, [])).toBe("web-9");
  });

  it("names a Subtask's Merges into and a Parent's own branch by the Parent's key alone", async () => {
    const sub = landed("open", { parent_id: "k-9" });
    mockApi(taskRoutes({ "GET /v1/tasks/:task": { ...sub, parent: { id: "k-9", key: "WEB-9", title: "Checkout" } }, ...runner(false) }));
    renderApp("/tasks/WEB-1");
    const rail = await screen.findByRole("complementary", { name: "Properties" });
    const merges = await within(rail).findByText("Merges into");
    expect(merges.closest("div")!.parentElement).toHaveTextContent("web-9");
    expect(rail).not.toHaveTextContent("web-9-checkout");
  });

  it("names a Parent's own branch by its key alone", async () => {
    const parent = { ...copy, state: "open" as const, ended_at: undefined, step_id: undefined, workspace_ids: [repo.id], subtask_counts: { open: 1, working: 0, done: 0, dropped: 0 } };
    mockApi(taskRoutes({ "GET /v1/tasks/:task": detail(parent, { workspaces: [repo] }), ...runner(false) }));
    renderApp("/tasks/WEB-1");
    const rail = await screen.findByRole("complementary", { name: "Properties" });
    const branch = await within(rail).findByText("Branch");
    expect(branch.closest("div")!.parentElement).toHaveTextContent(/web-1(?!-)/);
  });
});

describe("a Task waiting behind a busy taker", () => {
  it("says at its Step whom it waits for when every taker holds as many Tasks as it runs Shifts", async () => {
    // builder, Build's one taker, holds WEB-2; WEB-7 waits at Build.
    const waiting = { ...copy, id: "k-7", key: "WEB-7", title: "Fix the totals", step_id: step.build, step_since: at(50), claim: undefined };
    const filed: Activity = { seq: 1, at: at(50), kind: "task.filed", subject_type: "task", subject_id: waiting.id, payload: { step_id: step.build } };
    mockApi(taskRoutes({ "GET /v1/tasks": { items: [...projectTasks, waiting] }, "GET /v1/tasks/:task": detail(waiting), "GET /v1/activity": { items: [filed], last_seq: 1 } }));
    renderApp("/tasks/WEB-7");
    await screen.findByRole("heading", { level: 1, name: "Fix the totals" });
    // The strip says it for a screen reader; the line draws it under the token at Build.
    const stepper = await screen.findByRole("list", { name: "Path through the Steps" });
    await waitFor(() => expect(stepper).toHaveTextContent("waits for builder"));
    await waitFor(() => expect(screen.getAllByText("waits for builder")).toHaveLength(2));
  });

  it("says nothing while a taker is free", async () => {
    const waiting = { ...copy, id: "k-7", key: "WEB-7", title: "Fix the totals", step_id: step.build, step_since: at(50), claim: undefined };
    mockApi(taskRoutes({ "GET /v1/tasks/:task": detail(waiting), "GET /v1/tasks": { items: [copy, waiting] } }));
    renderApp("/tasks/WEB-7");
    await screen.findByRole("list", { name: "Path through the Steps" });
    expect(screen.queryByText("waits for builder")).not.toBeInTheDocument();
  });
});

describe("a held Task's rail", () => {
  it("shows no Heartbeat and no Session for a human's own Claim with no expiry, on the page and in the peek", async () => {
    const held = { ...copy, claim: { id: "c-ada", task_id: copy.id, holder_id: ada.id, session_id: "s-ada", started_at: at(58) } };
    mockApi(taskRoutes({ "GET /v1/tasks/:task": detail(held, { claims: [held.claim] }) }));
    renderApp("/tasks/WEB-1?task=WEB-1");
    await screen.findAllByText("Held by");
    // The page's rail and the peek's properties: each a list of terms.
    const terms = () => screen.getAllByRole("term").map((t) => t.textContent);
    await waitFor(() => expect(terms().filter((t) => t === "Held by")).toHaveLength(2));
    expect(terms()).not.toContain("Heartbeat");
    expect(terms()).not.toContain("Session");
    // The record's claimed row says no Session either.
    const record = screen.getAllByRole("list", { name: "Record" })[0];
    const claimed = within(record).getByText(/claimed/).closest("li")!;
    expect(claimed).toHaveTextContent("ada claimed");
    expect(claimed).not.toHaveTextContent("Session");
  });

  it("keeps an agent's Heartbeat, as the bar with working and the hold's age, and its Session", async () => {
    const held = { ...copy, claim: liveClaimOf(builder, copy.id, { session_id: "s-builder" }) };
    mockApi(taskRoutes({ "GET /v1/tasks/:task": detail(held, { claims: [held.claim] }) }));
    renderApp("/tasks/WEB-1?task=WEB-1");
    await waitFor(() => expect(screen.getAllByRole("term").filter((t) => t.textContent === "Heartbeat")).toHaveLength(2));
    expect(screen.getAllByRole("term").filter((t) => t.textContent === "Session")).toHaveLength(2);
    expect(screen.getAllByRole("meter").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^working \d+m$/).length).toBeGreaterThan(0);
    const record = screen.getAllByRole("list", { name: "Record" })[0];
    expect(within(record).getByText(/claimed/).closest("li")).toHaveTextContent("Session");
  });
});

describe("a Task's record", () => {
  it("hangs a Shift's log on the row that ended its Claim, never as the Task's Evidence", async () => {
    const t = { ...copy, state: "done" as const, ended_at: at(30), step_id: undefined };
    const claim = { id: "c-1", task_id: copy.id, holder_id: builder.id, session_id: "s-1", started_at: at(10), ended_at: at(20), how_ended: "released" as const };
    const evidence = (id: string, kind: "evidence" | "log", filename: string, min: number) => ({
      id,
      task_id: copy.id,
      kind,
      filename,
      content_type: "text/plain",
      size: 58_163,
      sha256: "x",
      attached_by: builder.id,
      created_at: at(min),
    });
    const d = detail(t, { claims: [claim], evidence: [evidence("e-pw", "evidence", "pw-all.log", 15), evidence("e-log", "log", "shift-WEB-1-builder-101000.log", 22)] });
    mockApi(taskRoutes({ "GET /v1/tasks/:task": d }));
    renderApp("/tasks/WEB-1");
    const record = await screen.findByRole("list", { name: "Record" });
    const ended = within(record).getByText(/released it/).closest("li")!;
    const log = within(ended).getByRole("link", { name: /Shift log/ });
    expect(log).toHaveTextContent("Shift log · 58.2 kB");
    expect(log).toHaveAttribute("href", "/v1/evidence/e-log/content");
    expect(within(record).getByRole("link", { name: /pw-all\.log/ })).toBeInTheDocument();
    expect(within(record).queryByText("shift-WEB-1-builder-101000.log")).not.toBeInTheDocument();
    expect(within(record).getAllByText(/attached/)).toHaveLength(1);
  });
});

describe("Evidence in a Task's record", () => {
  const evidence = (id: string, filename: string, content_type: string, size: number, min: number) => ({
    id,
    task_id: copy.id,
    kind: "evidence" as const,
    filename,
    content_type,
    size,
    sha256: "x",
    attached_by: builder.id,
    created_at: at(min),
  });
  const claim = { id: "c-1", task_id: copy.id, holder_id: builder.id, session_id: "s-1", started_at: at(10), ended_at: at(20), how_ended: "released" as const };

  it("folds a holder's Evidence into one row that shows each: a thumbnail, the first lines of a text file, a plain row for the rest", async () => {
    const d = detail(copy, {
      claims: [claim],
      evidence: [
        evidence("e-log", "triage-log.md", "text/markdown; charset=utf-8", 3_700, 12),
        evidence("e-png", "03-workflow-page.png", "image/png", 39_800, 12),
        evidence("e-zip", "trace.zip", "application/zip", 900_000, 12),
      ],
    });
    mockApi(
      taskRoutes({
        "GET /v1/tasks/:task": d,
        "GET /v1/evidence/:id/content": () => new Response("# Triage log, WEB-1\n\n| Where | Width |", { headers: { "Content-Type": "text/markdown" } }),
      }),
    );
    renderApp("/tasks/WEB-1");
    const record = await screen.findByRole("list", { name: "Record" });
    const row = within(record).getByText(/attached 3 Evidence/).closest("li")!;
    expect(row).toHaveTextContent("builder attached 3 Evidence");

    // An image: a lazy thumbnail, cover from the top, its name and size under it, the whole a link to the file.
    const img = within(row).getByRole("img", { name: "03-workflow-page.png" });
    expect(img).toHaveAttribute("src", "/v1/evidence/e-png/content");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveClass("object-cover", "object-top", "h-[92px]", "w-[148px]");
    const thumb = img.closest("a")!;
    expect(thumb).toHaveAttribute("href", "/v1/evidence/e-png/content");
    expect(thumb).toHaveTextContent("03-workflow-page.png39.8 kB");

    // A small text file: its first lines in a box, open at the right.
    const box = within(row).getByRole("figure", { name: "triage-log.md" });
    expect(await within(box).findByText(/# Triage log, WEB-1/)).toBeInTheDocument();
    expect(box).toHaveTextContent("3.7 kB");
    expect(within(box).getByRole("link", { name: "open ↗" })).toHaveAttribute("href", "/v1/evidence/e-log/content");

    // Anything else: name · size · open, as one Evidence reads today.
    const zip = within(row).getByRole("link", { name: /trace\.zip/ });
    expect(zip).toHaveAttribute("href", "/v1/evidence/e-zip/content");
    expect(row.contains(zip)).toBe(true);
    const plain = zip.closest("li")!;
    expect(within(plain).getByRole("link", { name: "open ↗" })).toHaveAttribute("href", "/v1/evidence/e-zip/content");
    expect(within(row).queryByRole("img", { name: "trace.zip" })).toBeNull();
  });

  it("shows a text file it cannot read as a plain row, and asks once", async () => {
    const d = detail(copy, { claims: [claim], evidence: [evidence("e-log", "triage-log.md", "text/markdown", 3_700, 12), evidence("e-zip", "trace.zip", "application/zip", 9_000, 12)] });
    const api = mockApi(taskRoutes({ "GET /v1/tasks/:task": d, "GET /v1/evidence/:id/content": () => refuse(404, "not_found", "No Evidence") }));
    renderApp("/tasks/WEB-1");
    const record = await screen.findByRole("list", { name: "Record" });
    const row = within(record).getByText(/attached/).closest("li")!;
    await waitFor(() => expect(within(row).queryByRole("figure")).toBeNull());
    expect(within(row).getByRole("link", { name: /triage-log\.md/ })).toHaveAttribute("href", "/v1/evidence/e-log/content");
    expect(api.calls.filter((c) => c.path === "/v1/evidence/e-log/content")).toHaveLength(1);
  });

  it("fades a text box out only when its lines run past the box", async () => {
    for (const [height, faded] of [
      [300, true],
      [40, false],
    ] as const) {
      const spy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(height);
      const d = detail(copy, { claims: [claim], evidence: [evidence("e-log", "triage-log.md", "text/markdown", 3_700, 12)] });
      mockApi(taskRoutes({ "GET /v1/tasks/:task": d, "GET /v1/evidence/:id/content": () => new Response("# Triage log") }));
      const { unmount } = renderApp("/tasks/WEB-1");
      const box = await screen.findByRole("figure", { name: "triage-log.md" });
      await within(box).findByText("# Triage log");
      await waitFor(() => expect(!!box.querySelector("[data-fade]")).toBe(faded));
      unmount();
      spy.mockRestore();
    }
  });

  it("keeps a text box empty and short while its file loads", async () => {
    const d = detail(copy, { claims: [claim], evidence: [evidence("e-log", "triage-log.md", "text/markdown", 3_700, 12)] });
    mockApi(taskRoutes({ "GET /v1/tasks/:task": d, "GET /v1/evidence/:id/content": () => new Promise<Response>(() => {}) }));
    renderApp("/tasks/WEB-1");
    const box = await screen.findByRole("figure", { name: "triage-log.md" });
    const body = box.querySelector("[aria-busy]")!;
    expect(body).toHaveAttribute("aria-busy", "true");
    expect(body).toHaveTextContent("");
    expect(body).toHaveClass("h-7");
  });

  it("keeps one Evidence's row with its name, and fetches no text file of 20 kB or more", async () => {
    const d = detail(copy, { claims: [claim], evidence: [evidence("e-big", "pw-all.log", "text/plain", 58_163, 12)] });
    const api = mockApi(taskRoutes({ "GET /v1/tasks/:task": d }));
    renderApp("/tasks/WEB-1");
    const record = await screen.findByRole("list", { name: "Record" });
    const row = within(record).getByRole("link", { name: /pw-all\.log/ }).closest("li")!;
    expect(row).toHaveTextContent("builder attachedpw-all.log58.2 kB");
    expect(within(row).queryByRole("figure")).toBeNull();
    expect(api.calls.some((c) => c.path.startsWith("/v1/evidence/"))).toBe(false);
  });
});

describe("a Subtask's peek", () => {
  it("links its Parent and reports its Project", async () => {
    mockApi(taskRoutes());
    renderApp("/inbox?task=WEB-4");
    const peek = await screen.findByRole("dialog", { name: "Task WEB-4" });
    expect(await within(peek).findByRole("link", { name: /Parent\s*WEB-3\s*Checkout/ })).toHaveAttribute("href", "/inbox?task=WEB-3");
    // The sidebar unfolds the current Project onto its places.
    await waitFor(() => expect(screen.getByRole("list", { name: "Web" })).toBeInTheDocument());
  });
});
