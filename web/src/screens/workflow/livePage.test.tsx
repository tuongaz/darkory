import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Activity, ActivityKind, Task } from "@/api/client";
import { mockApi } from "@/test/api";
import { ada, bob, builder, signedIn, step, task, wfId, wfStep, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import { FakeEventSource } from "@/test/eventSource";
import { renderApp } from "@/test/render";

// The live Workflow page as the line draws it (Direction D): each open Task a token at its Step,
// the panels under it, the toggle Line | Blocking (N) | Text, the scope in the breadcrumb, a
// selected token's chain, a pickup tagged "now" and a move carried along its Connector.

const claim = (holder: string, started = new Date(Date.now() - 20 * 60_000).toISOString()) => ({ id: `c-${holder}`, task_id: "", holder_id: holder, session_id: "s", started_at: started });
const entry = (seq: number, kind: ActivityKind, subject: string, payload: Record<string, unknown>, actor?: string): Activity => ({
  seq,
  at: new Date().toISOString(),
  kind,
  subject_type: "task",
  subject_id: subject,
  ...(actor ? { actor_id: actor } : {}),
  payload,
});
const blockedBy = (...ns: number[]) => ({ blocked: true, open_blockers: ns.map((n) => ({ id: `k-${n}`, key: `WEB-${n}`, title: `Task ${n}` })) });

/** WEB with `tasks` open; the Tasks may be changed before an entry says so. */
function serve(tasks: Task[], who = ada) {
  const list = { tasks };
  const api = mockApi({
    ...signedIn(who),
    "GET /v1/tasks": ({ query }) => ({ items: list.tasks.filter((t) => (!query.get("step") || t.step_id === query.get("step")) && (!query.get("state") || t.state === query.get("state"))) }),
    "GET /v1/tasks/:task": ({ params }) => {
      const t = list.tasks.find((x) => x.id === params.task || x.key === params.task)!;
      return { task: t, subtasks: list.tasks.filter((x) => x.parent_id === t.id), connectors: [], labels: [], workspaces: [], claims: t.claim ? [t.claim] : [], notes: [], evidence: [], blockers: [], blocking: [], observations: [], proposals: [] };
    },
    "GET /v1/activity": { items: [], last_seq: 0 },
    "GET /v1/runner/sessions": { items: [], runner: false },
  });
  return { api, list };
}

const line = () => screen.getByRole("region", { name: "Workflow" });
const tokenOf = (key: string) => line().querySelector<HTMLElement>(`button[data-task="${key}"]`);
const deliver = (e: Activity) => act(() => FakeEventSource.latest().emit("activity", e, e.seq));
const reducedMotion = (on: boolean) => {
  const was = window.matchMedia;
  window.matchMedia = (q: string) => ({ ...was(q), matches: on && q.includes("reduced-motion") });
  return () => (window.matchMedia = was);
};

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("the Workflow page", () => {
  it("draws every open Task as a token at its Step, held first, and leaves a Parent off the line", async () => {
    serve([task(1, { claim: claim(builder.id), title: "Normalise names" }), task(2), task(5, { step_id: step.review }), task(6, { step_id: undefined, title: "A Parent", subtask_counts: { open: 0, working: 0, done: 1, dropped: 0 } })]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-1")).not.toBeNull());
    expect(tokenOf("WEB-1")).toHaveAccessibleName("WEB-1 Normalise names, held by builder (agent)");
    expect(tokenOf("WEB-1")).toHaveAttribute("data-state", "held");
    expect(tokenOf("WEB-2")).toHaveAccessibleName("WEB-2 Task 2, waiting");
    expect(tokenOf("WEB-5")).toBeInTheDocument();
    expect(tokenOf("WEB-6")).toBeNull();
    // Retro and Skill review run on the branch after a Parent.
    expect(within(line()).getByText("After a Parent")).toBeInTheDocument();
  });

  it("says where Tasks enter: the arrow into Build, Plan on Break down, Backlog parked with its Tasks", async () => {
    serve([task(2), task(3, { step_id: step.backlog, title: "Later" }), task(4, { step_id: step.plan, title: "Break down: Big thing", kind: "breakdown" })]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-3")).not.toBeNull());
    expect(within(line()).getByText("New Tasks start here")).toBeInTheDocument();
    expect(within(line()).getByText("Break down")).toBeInTheDocument();
    expect(within(line()).getByText("files Subtasks")).toBeInTheDocument();
    expect(within(line()).getByText("hold · moved on by hand")).toBeInTheDocument();
    expect(tokenOf("WEB-3")).toHaveAttribute("data-state", "hold");
    expect(tokenOf("WEB-4")).toBeInTheDocument();
    // Plan's done is words beside it, not a dashed arc over the line.
    expect(line().querySelector('[data-hint^="Plan\'s Breakdown Subtask ends Done"]')).toHaveTextContent("done → Done");
  });

  it("explains every line on hover, in words", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    const segment = line().querySelector<SVGPathElement>('path[data-hint^="Build → Review"]')!;
    await userEvent.hover(segment);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Build → Review: when the holder says pass");
    await userEvent.unhover(segment);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.hover(within(line()).getByText("Backlog"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Backlog: a hold. No one is offered these; a human moves a Task on by hand, to any Step");
    await userEvent.hover(within(line()).getByText("files Subtasks"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Whoever takes it files the Parent's other Subtasks, each at the Step its filer names, Build when they name none");
    // No line goes without words.
    const lines = [...line().querySelectorAll("svg path[stroke='transparent']")];
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(l.getAttribute("data-hint")).toBeTruthy();
  });

  it("the Text view says where new Tasks start, what Plan does, and that Backlog's Tasks move by hand", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflow?view=text");
    expect(await screen.findByText("New Tasks start at Build, unless the filer names another Step.")).toBeInTheDocument();
    expect(screen.getByText(/^Break down: a Task filed with Break down on gets its Breakdown Subtask here; whoever takes it files the other Subtasks, each at the Step its filer names, Build when they name none\.$/)).toBeInTheDocument();
    expect(screen.getByText(/^A hold: no one is offered its Tasks/)).toBeInTheDocument();
  });

  it("mounts Needs you and What's happening under the line, and Edit for an admin only", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    expect(await screen.findByRole("region", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What's happening" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit the Workflow" })).toBeInTheDocument();
  });

  it("offers no Edit to a Member who is not an admin", async () => {
    serve([task(2)], bob);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    expect(screen.queryByRole("link", { name: "Edit the Workflow" })).toBeNull();
  });

  it("marks a blocked token with what it waits on, and counts the Blockings on the toggle", async () => {
    serve([task(2), task(3, blockedBy(2)), task(4, blockedBy(2, 3))]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-3")).not.toBeNull());
    expect(tokenOf("WEB-3")).toHaveTextContent("by WEB-2");
    expect(tokenOf("WEB-4")).toHaveTextContent("by 2");
    expect(screen.getByRole("button", { name: /^Blocking/ })).toHaveTextContent("Blocking3");
  });

  it("leaves Blocking off the toggle when nothing blocks", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /^Blocking/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Text" })).toBeInTheDocument();
  });

  it("selecting a blocked token says its chain, when it unblocks, and what comes first", async () => {
    serve([task(2, { aimed_at_id: ada.id, step_id: undefined, title: "Which format?" }), task(3, blockedBy(2)), task(4, blockedBy(3))]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-4")).not.toBeNull());
    await userEvent.click(tokenOf("WEB-4")!);
    const callout = await screen.findByRole("dialog", { name: "WEB-4 Blocking" });
    expect(within(callout).getByLabelText("Blocked by")).toHaveTextContent(/WEB-2With you.*WEB-3.*WEB-4/);
    expect(callout).toHaveTextContent("Unblocks when WEB-2, then WEB-3 end");
    expect(callout).toHaveTextContent("First: answer WEB-2");
    expect(within(callout).getByRole("button", { name: "Answer WEB-2" })).toBeInTheDocument();
    // The question waits with ada at no Step: a "with you" ghost stands for it on the line.
    expect(within(line()).getByLabelText("WEB-2 Which format?, with you")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "WEB-4 Blocking" })).toBeNull();
  });

  it("a blocker selected says what it holds up", async () => {
    serve([task(2), task(3, blockedBy(2)), task(4, blockedBy(3))]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    await userEvent.click(tokenOf("WEB-2")!);
    const callout = await screen.findByRole("dialog", { name: "WEB-2 Blocking" });
    expect(within(callout).getByLabelText("Blocks")).toHaveTextContent(/Blocks 1.*2 in chain/);
    expect(callout).toHaveTextContent("WEB-3 unblocks when WEB-2 ends; WEB-4 unblocks when WEB-3 ends");
  });

  it("opens a selected Task's peek from its callout", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    await userEvent.click(tokenOf("WEB-2")!);
    await userEvent.click(await screen.findByRole("button", { name: /Open WEB-2/ }));
    expect(await screen.findByRole("dialog", { name: "Task WEB-2" })).toBeInTheDocument();
  });

  it("narrows to a Parent's Subtasks by ?scope=, leaving a faint +N for the rest and Open the Parent", async () => {
    serve([
      task(7, { step_id: undefined, title: "Emoji reactions", acceptance: true, subtask_counts: { open: 2, working: 0, done: 0, dropped: 0 } }),
      task(8, { parent_id: "k-7", rank: undefined }),
      task(9, { parent_id: "k-7", rank: undefined, step_id: step.review }),
      task(10),
      task(11),
    ]);
    renderApp("/projects/WEB/workflow?scope=k-7");
    await waitFor(() => expect(tokenOf("WEB-8")).not.toBeNull());
    expect(tokenOf("WEB-10")).toBeNull();
    expect(within(line()).getByLabelText("2 more Tasks outside this scope")).toBeInTheDocument();
    expect(screen.getByText("2 hidden")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open WEB-7" })).toHaveAttribute("href", "/tasks/WEB-7");
    expect(screen.getByRole("button", { name: "Scope: WEB-7 Emoji reactions" })).toBeInTheDocument();
    expect(within(line()).getByText("Next for WEB-7")).toBeInTheDocument();
    // × widens it again.
    await userEvent.click(screen.getByRole("button", { name: "All Tasks" }));
    await waitFor(() => expect(tokenOf("WEB-10")).not.toBeNull());
  });

  it("the Filter narrows the tokens like a scope: what it leaves out counts into its Step's +N", async () => {
    serve([task(2), task(3, blockedBy(2)), task(4, { step_id: step.review })]);
    renderApp(`/projects/WEB/workflow?filter.tasks=${encodeURIComponent("blocked:is:true")}`);
    await waitFor(() => expect(tokenOf("WEB-3")).not.toBeNull());
    expect(tokenOf("WEB-2")).toBeNull();
    expect(tokenOf("WEB-4")).toBeNull();
    expect(within(line()).getAllByLabelText("1 more Task outside this scope")).toHaveLength(2);
    expect(screen.getByText("2 hidden")).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: /Filter/ })).toBeInTheDocument();
  });

  it("the scope menu lists All Tasks, the Parents with open Subtasks and No Parent, and narrows on a pick", async () => {
    serve([task(7, { step_id: undefined, title: "Emoji reactions", subtask_counts: { open: 1, working: 0, done: 0, dropped: 0 } }), task(8, { parent_id: "k-7", rank: undefined }), task(10)]);
    renderApp("/projects/WEB/workflow");
    await userEvent.click(await screen.findByRole("button", { name: "Scope: All Tasks" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["All Tasks2", "WEB-7Emoji reactions1 open", "No Parent1"]);
    await userEvent.click(options[2]);
    await waitFor(() => expect(tokenOf("WEB-8")).toBeNull());
    expect(tokenOf("WEB-10")).not.toBeNull();
  });

  it("lists each Step's Tasks in the text view, held first, and the questions with a Member", async () => {
    serve([task(2), task(3, { claim: claim(builder.id) }), task(4, { aimed_at_id: ada.id, step_id: undefined, title: "Which format?" })]);
    renderApp("/projects/WEB/workflow?view=text");
    const list = await screen.findByRole("list", { name: "Tasks at Build" });
    expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["WEB-3 Task 3, held by builder", "WEB-2 Task 2, waiting"]);
    expect(screen.getByRole("region", { name: "With a Member" })).toHaveTextContent("WEB-4Which format?With you");
  });
});

describe("the line as it happens", () => {
  it("a Task filed shows its token at its Step, tagged with who filed it", async () => {
    const { list } = serve([]);
    renderApp("/projects/WEB/workflow");
    await screen.findByRole("region", { name: "Workflow" });
    list.tasks = [task(2)];
    deliver(entry(5, "task.filed", "k-2", { key: "WEB-2", project_id: "p-web", step_id: step.build }, ada.id));
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    await waitFor(() => expect(tokenOf("WEB-2")!.parentElement!.querySelector("[data-tag]")).toHaveTextContent("ada filed"));
    expect(screen.getAllByRole("status").some((s) => s.textContent === "ada filed WEB-2 at Build")).toBe(true);
  });

  it("a pickup reads 'now' on the token with its tag: who picked it up and how long it waited", async () => {
    const { list } = serve([task(2, { step_since: new Date(Date.now() - 43 * 60_000).toISOString() })]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    list.tasks = [task(2, { step_since: new Date(Date.now() - 43 * 60_000).toISOString(), claim: claim(builder.id, new Date().toISOString()) })];
    deliver(entry(6, "task.claimed", "k-2", { step_id: step.build }, builder.id));
    await waitFor(() => expect(tokenOf("WEB-2")).toHaveAttribute("data-now"));
    expect(tokenOf("WEB-2")).toHaveTextContent("now");
    expect(tokenOf("WEB-2")).toHaveAttribute("data-pulse", "agent");
    expect(tokenOf("WEB-2")!.parentElement!.querySelector("[data-tag]")).toHaveTextContent("nowbuilder picked up· waited 43m");
  });

  it("an advance carries a token along its Connector, its outcome lit, and the Task lands at its next Step", async () => {
    const { list } = serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    list.tasks = [task(2, { step_id: step.review })];
    deliver(entry(7, "task.advanced", "k-2", { from: step.build, to: step.review, outcome: "pass" }, builder.id));
    await waitFor(() => expect(document.querySelector("[data-travel]")).toHaveTextContent("WEB-2pass"));
    expect(tokenOf("WEB-2")).toBeNull();
    expect(line().querySelector('[data-lit="true"]')).toHaveTextContent("pass");
    await waitFor(() => expect(tokenOf("WEB-2")).toHaveAttribute("data-arrived"), { timeout: 3000 });
    expect(document.querySelector("[data-travel]")).toBeNull();
  });

  it("with reduced motion nothing travels: the token simply appears at its next Step", async () => {
    restore = reducedMotion(true);
    const { list } = serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    list.tasks = [task(2, { step_id: step.review })];
    deliver(entry(7, "task.advanced", "k-2", { from: step.build, to: step.review, outcome: "pass" }, builder.id));
    await waitFor(() => expect(tokenOf("WEB-2")).toHaveAttribute("data-arrived"));
    expect(document.querySelector("[data-travel]")).toBeNull();
  });
});

describe("the Workflow page of a Project of several Workflows (ADR 0019)", () => {
  afterEach(() => localStorage.clear());
  const at = (n: number, title: string, stepId: string, workflowId: string, extra: Partial<Task> = {}) => task(n, { title, step_id: stepId, workflow_id: workflowId, skill_id: undefined, ...extra });
  /** WEB as ADR 0019's five Workflows, with `tasks` open. */
  function several(tasks: Task[]) {
    const { api, list } = serve(tasks);
    api.routes["GET /v1/projects/:project/workflow"] = workflowsFixture();
    api.routes["GET /v1/skills"] = { items: workflowsSkills };
    return { api, list };
  }
  const heads = () => [...line().querySelectorAll("[data-head]")].map((e) => e.getAttribute("data-head"));
  const bug = workflowsFixture().connectors.find((c) => c.from_step_id === wfStep.triage && c.name === "bug")!;

  it("the chip lists the five; picking Bugs redraws the line with Investigate first and an entry from Triage", async () => {
    several([at(1, "Sort the inbox", wfStep.triage, wfId.triage), at(2, "Crash on save", wfStep.investigate, wfId.bugs)]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-1")).not.toBeNull());
    expect(heads()).toEqual(["Triage", "Done"]);
    // Triage's four outcomes leave the line as exits; WEB-2, at Investigate, is on Bugs' line.
    expect(within(line()).getByText("bug → Bugs › Investigate")).toHaveAttribute("data-chip", "exit");
    expect(tokenOf("WEB-2")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Triage" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
    await userEvent.click(screen.getByRole("option", { name: "Bugs" }));
    await waitFor(() => expect(heads()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]));
    expect(within(line()).getByText("from Triage · bug")).toBeInTheDocument();
    expect(tokenOf("WEB-2")).not.toBeNull();
    expect(tokenOf("WEB-1")).toBeNull();
    expect(screen.getByRole("button", { name: "Workflow: Bugs" })).toBeInTheDocument();
  });

  it("opens on the Workflow ?workflow= names, the one the board shows", async () => {
    several([at(2, "Crash on save", wfStep.investigate, wfId.bugs)]);
    renderApp(`/projects/WEB/workflow?workflow=${wfId.bugs}`);
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    expect(heads()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]);
    // At every width: a phone has no other way to another Workflow.
    expect(screen.getByRole("button", { name: "Workflow: Bugs" }).closest(".hidden")).toBeNull();
  });

  it("a Project of one Workflow has no chip", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /^Workflow: / })).toBeNull();
  });

  it("counts as hidden only the drawn Workflow's Tasks the scope leaves out", async () => {
    several([
      at(1, "Sort the inbox", wfStep.triage, wfId.triage, { parent_id: "k-9" }),
      at(3, "Another to sort", wfStep.triage, wfId.triage),
      at(2, "Crash on save", wfStep.investigate, wfId.bugs, { parent_id: "k-9" }),
    ]);
    renderApp("/projects/WEB/workflow?scope=none");
    await waitFor(() => expect(tokenOf("WEB-3")).not.toBeNull());
    // WEB-1 is left out here; WEB-2, also a Subtask, is on Bugs' line and not counted.
    expect(screen.getByText("1 hidden")).toBeInTheDocument();
  });

  it("the Text view lists the drawn Workflow's Steps, naming where an outcome crosses and where Tasks enter", async () => {
    several([at(2, "Crash on save", wfStep.investigate, wfId.bugs)]);
    renderApp(`/projects/WEB/workflow?workflow=${wfId.bugs}&view=text`);
    const steps = await screen.findByRole("list", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem").filter((li) => li.parentElement === steps).map((li) => li.querySelector(".font-semibold")?.textContent)).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]);
    expect(within(steps).getByRole("list", { name: "Into Investigate from other Workflows" })).toHaveTextContent("from Triage · bug");
    // New Tasks start at Triage, not on this list.
    expect(screen.queryByText(/New Tasks start at/)).toBeNull();
  });

  it("counts under Done only the Tasks done today in the Workflow drawn", async () => {
    const today = new Date().toISOString();
    several([
      at(1, "Sort the inbox", wfStep.triage, wfId.triage),
      at(3, "Sorted", wfStep.triage, wfId.triage, { state: "done", step_id: undefined, last_step_id: wfStep.triage, ended_at: today }),
      at(4, "Fixed", wfStep.verify, wfId.bugs, { state: "done", step_id: undefined, last_step_id: wfStep.verify, ended_at: today }),
      at(5, "Also fixed", wfStep.verify, wfId.bugs, { state: "done", step_id: undefined, last_step_id: wfStep.verify, ended_at: today }),
    ]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(within(line()).getByText("1 today")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Triage" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bugs" }));
    await waitFor(() => expect(within(line()).getByText("2 today")).toBeInTheDocument());
  });

  it("lists a Parent in the scope menu of the one page its board shows it on: where its least advanced Subtask is", async () => {
    const parent = task(9, { title: "Launch", step_id: undefined, step_since: undefined, skill_id: undefined, subtask_counts: { open: 2, working: 0, done: 0, dropped: 0 } });
    several([parent, at(1, "Sort the inbox", wfStep.triage, wfId.triage, { parent_id: parent.id }), at(2, "Crash on save", wfStep.investigate, wfId.bugs, { parent_id: parent.id })]);
    renderApp(`/projects/WEB/workflow?workflow=${wfId.bugs}`);
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    // WEB-2, a Subtask of WEB-9, is on Bugs' line; WEB-9 itself is on Triage's page, as on Triage's board.
    await userEvent.click(screen.getByRole("button", { name: "Scope: All Tasks" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["All Tasks1", "No Parent0"]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Bugs" }));
    await userEvent.click(await screen.findByRole("option", { name: "Triage" }));
    await waitFor(() => expect(tokenOf("WEB-1")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Scope: All Tasks" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["All Tasks1", "WEB-9Launch1 open", "No Parent0"]);
  });

  it("lists a question beside the Task it blocks, else with its Parent, else on every page", async () => {
    const q = (n: number, title: string, extra: Partial<Task> = {}) => task(n, { title, step_id: undefined, step_since: undefined, skill_id: undefined, aimed_at_id: ada.id, ...extra });
    const blocked = (by: Task) => ({ blocked: true, open_blockers: [{ id: by.id, key: by.key, title: by.title }] });
    const forBugs = q(20, "Which build crashed?");
    const loose = q(21, "Anyone seen this?");
    several([forBugs, loose, at(2, "Crash on save", wfStep.investigate, wfId.bugs, blocked(forBugs))]);
    renderApp(`/projects/WEB/workflow?view=text`);
    const withMember = await screen.findByRole("region", { name: "With a Member" });
    expect(within(withMember).queryByText("Which build crashed?")).toBeNull();
    expect(within(withMember).getByText("Anyone seen this?")).toBeInTheDocument();
  });

  it("drops the scope on a pick of a Workflow its Task is not on, and keeps it where it is", async () => {
    several([at(1, "Sort the inbox", wfStep.triage, wfId.triage), at(2, "Crash on save", wfStep.investigate, wfId.bugs)]);
    renderApp(`/projects/WEB/workflow?workflow=${wfId.bugs}&scope=k-2`);
    await waitFor(() => expect(screen.getByRole("button", { name: "Scope: WEB-2 Crash on save" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Bugs" }));
    await userEvent.click(await screen.findByRole("option", { name: "Triage" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Scope: All Tasks" })).toBeInTheDocument());
    // No Parent is a scope of every page.
    await userEvent.click(screen.getByRole("button", { name: "Scope: All Tasks" }));
    await userEvent.click(await screen.findByRole("option", { name: /No Parent/ }));
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Triage" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bugs" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Workflow: Bugs" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Scope: No Parent" })).toBeInTheDocument();
  });

  it("a Task advancing out along an exit travels the exit's route, and is gone from the line", async () => {
    const { list } = several([at(2, "Crash on save", wfStep.triage, wfId.triage)]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    list.tasks = [at(2, "Crash on save", wfStep.investigate, wfId.bugs)];
    deliver(entry(7, "task.advanced", "k-2", { from: wfStep.triage, to: wfStep.investigate, outcome: "bug" }, builder.id));
    const travel = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-travel]");
      expect(el).toHaveTextContent("WEB-2bug");
      return el!;
    });
    const station = line().querySelector(`[data-station="${wfStep.triage}"]`)!;
    expect(travel.style.offsetPath).toMatch(new RegExp(`^path\\("M${station.getAttribute("cx")} ${station.getAttribute("cy")} V[\\d.]+ H[\\d.]+"\\)$`));
    expect(line().querySelector(`[data-exit="${bug.id}"]`)).not.toBeNull();
    await waitFor(() => expect(document.querySelector("[data-travel]")).toBeNull(), { timeout: 3000 });
    expect(tokenOf("WEB-2")).toBeNull();
  });
});
