import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Activity, ActivityKind, Task } from "@/api/client";
import { mockApi } from "@/test/api";
import { ada, bob, builder, signedIn, step, task, wfId, wfStep, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import { FakeEventSource } from "@/test/eventSource";
import { renderApp } from "@/test/render";

// The live Workflow page as the line draws it (Direction D): each held Task a chip at its Step and
// the waiting counted, the count opening the Step's list,
// the panels under it, the toggle Line | Blocking (N) | Text, the scope after it on the bar's second row, a
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
const tokenOf = (key: string) => line().querySelector<HTMLElement>(`button[data-task="${key}"]:not([data-step-list] *)`);
/** A Step's count on the line, "Build: 2 Tasks waiting", once the line is drawn. */
const countAt = (step: string) => waitFor(() => within(line()).getByRole("button", { name: new RegExp(`^${step}: `) }));
/** A Step's list, opened from its count. */
async function listAt(step: string) {
  const pill = await countAt(step);
  if (pill.getAttribute("aria-expanded") !== "true") await userEvent.click(pill);
  return within(line()).getByRole("group", { name: new RegExp(`^${step} · `) });
}
const keys = (list: HTMLElement) => within(list).getAllByRole("button").map((b) => b.getAttribute("data-task"));
const deliver = (e: Activity) => act(() => FakeEventSource.latest().emit("activity", e, e.seq));
const reducedMotion = (on: boolean) => {
  const was = window.matchMedia;
  window.matchMedia = (q: string) => ({ ...was(q), matches: on && q.includes("reduced-motion") });
  return () => (window.matchMedia = was);
};

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("the Workflow page", () => {
  it("draws a held Task as a chip at its Step, counts the waiting, and leaves a Parent off the line", async () => {
    serve([task(1, { claim: claim(builder.id), title: "Normalise names" }), task(2), task(5, { step_id: step.review }), task(6, { step_id: undefined, title: "A Parent", subtask_counts: { open: 0, working: 0, done: 1, dropped: 0 } })]);
    renderApp("/projects/WEB/workflows/wf-work");
    await waitFor(() => expect(tokenOf("WEB-1")).not.toBeNull());
    expect(tokenOf("WEB-1")).toHaveAccessibleName("WEB-1 Normalise names, held by builder (agent)");
    expect(tokenOf("WEB-1")).toHaveAttribute("data-state", "held");
    expect(await countAt("Build")).toHaveAccessibleName("Build: 1 Task waiting");
    expect(within(await listAt("Build")).getByRole("button")).toHaveAccessibleName("WEB-2 Task 2, waiting");
    expect(await countAt("Review")).toHaveAccessibleName("Review: 1 Task waiting");
    expect(line().querySelector('[data-task="WEB-6"]')).toBeNull();
    // Retro and Skill review run on the quiet line when a Parent ends.
    expect(within(line()).getByRole("region", { name: "When a Parent ends" })).toBeInTheDocument();
  });

  it("says where Tasks enter: Start into Build, Plan and Backlog beside it with their Tasks", async () => {
    serve([task(2), task(3, { step_id: step.backlog, title: "Later" }), task(4, { step_id: step.plan, title: "Break down: Big thing", kind: "breakdown" })]);
    renderApp("/projects/WEB/workflows/wf-work");
    await countAt("Backlog");
    expect(line().querySelector("[data-start-label]")).toHaveTextContent("Start");
    expect(line().querySelector("[data-start-label]")).toHaveAttribute("data-hint", "New Tasks start at Build, unless the filer names another Step");
    const also = within(line()).getByRole("region", { name: "Also starts here" });
    expect(also.querySelector(`[data-side="${step.plan}"] [data-mark="files"]`)).toHaveTextContent("↳ Build");
    expect(also.querySelector(`[data-side="${step.backlog}"]`)).toHaveTextContent(/Backlog\s*hold/);
    expect((await countAt("Backlog")).querySelector("[data-state]")).toHaveAttribute("data-state", "hold");
    expect(keys(await listAt("Backlog"))).toEqual(["WEB-3"]);
    expect(keys(await listAt("Plan"))).toEqual(["WEB-4"]);
    // Plan's done is a mark beside it, not a line.
    expect(line().querySelector('[data-hint^="Plan\'s Breakdown Subtask ends Done"]')).toHaveTextContent("● done → Done");
  });

  it("explains every line on hover, in words", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflows/wf-work");
    await countAt("Build");
    const segment = line().querySelector<SVGPathElement>('path[data-hint^="Build → Review"]')!;
    await userEvent.hover(segment);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Build → Review: when the holder says pass");
    await userEvent.unhover(segment);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.hover(within(line()).getByText("Backlog"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Backlog: a hold. No one is offered these; a human moves a Task on by hand, to any Step");
    await userEvent.hover(line().querySelector<HTMLElement>('[data-mark="files"]')!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Whoever takes it files the Parent's other Subtasks, each at the Step its filer names, Build when they name none");
    // No line goes without words.
    const lines = [...line().querySelectorAll("svg path[stroke='transparent']")];
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(l.getAttribute("data-hint")).toBeTruthy();
  });

  it("the Text view says where new Tasks start, what Plan does, and that Backlog's Tasks move by hand", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflows/wf-work?view=text");
    expect(await screen.findByText("New Tasks start at Build, unless the filer names another Step.")).toBeInTheDocument();
    expect(screen.getByText(/^Break down: a Task filed with Break down on gets its Breakdown Subtask here; whoever takes it files the other Subtasks, each at the Step its filer names, Build when they name none\.$/)).toBeInTheDocument();
    expect(screen.getByText(/^A hold: no one is offered its Tasks/)).toBeInTheDocument();
  });

  it("mounts Needs you and What's happening under the line, and Edit for an admin only", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflows/wf-work");
    expect(await screen.findByRole("region", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "What's happening" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit Work" })).toHaveAttribute("href", "/projects/WEB/workflows/wf-work/edit");
  });

  it("on a phone reads the line first, then Needs you, then What's happening: the page's order, no phone reordering", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflows/wf-work");
    const needs = await screen.findByRole("region", { name: "Needs you" });
    const stories = screen.getByRole("region", { name: "What's happening" });
    const line = screen.getByRole("region", { name: /^Workflow$/ });
    expect(line.compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(needs.compareDocumentPosition(stories) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Below lg nothing reorders them (lg's own order only folds a quiet What's happening over Needs you).
    for (let el: HTMLElement | null = needs; el; el = el.parentElement) expect(el.className).not.toMatch(/(^|\s)order-/);
    for (let el: HTMLElement | null = stories; el; el = el.parentElement) expect(el.className).not.toMatch(/(^|\s)order-/);
    for (let el: HTMLElement | null = line; el; el = el.parentElement) expect(el.className).not.toMatch(/(^|\s)order-/);
  });

  it("offers no Edit to a Member who is not an admin", async () => {
    serve([task(2)], bob);
    renderApp("/projects/WEB/workflows/wf-work");
    await countAt("Build");
    expect(screen.queryByRole("link", { name: /^Edit / })).toBeNull();
  });

  it("lists a blocked Task in red with what it waits on, and counts the Blockings on the toggle", async () => {
    serve([task(2), task(3, blockedBy(2)), task(4, blockedBy(2, 3))]);
    renderApp("/projects/WEB/workflows/wf-work");
    const list = await listAt("Build");
    expect(within(list).getByRole("button", { name: /^WEB-3 / })).toHaveAccessibleName("WEB-3 Task 3, blocked by WEB-2");
    expect(within(list).getByRole("button", { name: /^WEB-4 / })).toHaveAccessibleName("WEB-4 Task 4, blocked by WEB-2 and WEB-3");
    expect(within(list).getByRole("button", { name: /^WEB-4 / }).querySelector("[data-state]")).toHaveAttribute("data-state", "blocked");
    expect(screen.getByRole("button", { name: /^Blocking/ })).toHaveTextContent("Blocking3");
  });

  it("leaves Blocking off the toggle when nothing blocks", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflows/wf-work");
    await countAt("Build");
    expect(screen.queryByRole("button", { name: /^Blocking/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Text" })).toBeInTheDocument();
  });

  it("selecting a blocked token puts its way above the line: when it unblocks, what comes first and its button; its chain ringed", async () => {
    serve([task(2, { aimed_at_id: ada.id, step_id: undefined, title: "Which format?" }), task(3, blockedBy(2)), task(4, blockedBy(3))]);
    renderApp("/projects/WEB/workflows/wf-work");
    await userEvent.click(within(await listAt("Build")).getByRole("button", { name: /^WEB-4 / }));
    // Selected, it stands as a chip at its Step.
    await waitFor(() => expect(tokenOf("WEB-4")).toHaveAttribute("data-selected"));
    const strip = within(line()).getByRole("region", { name: "WEB-4's way" });
    expect(strip).toHaveTextContent(/^WEB-4's way/);
    expect(strip).toHaveTextContent("next: pass → Review");
    expect(strip).toHaveTextContent("Unblocks when WEB-2, then WEB-3 end");
    expect(strip).toHaveTextContent("First: answer WEB-2");
    expect(within(strip).getByRole("button", { name: "Answer WEB-2" })).toBeInTheDocument();
    // The question waits with ada at no Step: a "with you" pill stands for it in the strip.
    expect(within(strip).getByLabelText("WEB-2 Which format?, with you")).toBeInTheDocument();
    // WEB-3, in the chain, waits in Build's count: ringed.
    expect(await countAt("Build")).toHaveAttribute("data-ringed");
    expect(strip).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard("{Escape}");
    expect(within(line()).queryByRole("region", { name: "WEB-4's way" })).toBeNull();
    // WEB-4 waits again: the focus goes back to the count it folded into.
    expect(await countAt("Build")).toHaveFocus();
  });

  it("a blocker selected says what it holds up", async () => {
    serve([task(2), task(3, blockedBy(2)), task(4, blockedBy(3))]);
    renderApp("/projects/WEB/workflows/wf-work");
    await userEvent.click(within(await listAt("Build")).getByRole("button", { name: /^WEB-2 / }));
    const strip = within(line()).getByRole("region", { name: "WEB-2's way" });
    expect(strip).toHaveTextContent("Blocks 1 · 2 in chain");
    // Which ones, and when each unblocks, behind an ⓘ.
    expect(strip).not.toHaveTextContent("unblocks when");
    expect(within(strip).getByRole("button", { name: "About Blocks 1 · 2 in chain: WEB-3 unblocks when WEB-2 ends; WEB-4 unblocks when WEB-3 ends" })).toBeInTheDocument();
    expect(strip).not.toHaveTextContent("First:");
  });

  it("opens a selected Task's peek from its strip, and × clears it", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflows/wf-work");
    await userEvent.click(within(await listAt("Build")).getByRole("button", { name: /^WEB-2 / }));
    const strip = within(line()).getByRole("region", { name: "WEB-2's way" });
    await userEvent.click(within(strip).getByRole("button", { name: "Clear" }));
    expect(within(line()).queryByRole("region", { name: "WEB-2's way" })).toBeNull();
    await userEvent.click(within(await listAt("Build")).getByRole("button", { name: /^WEB-2 / }));
    await userEvent.click(within(within(line()).getByRole("region", { name: "WEB-2's way" })).getByRole("button", { name: "Open WEB-2" }));
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
    renderApp("/projects/WEB/workflows/wf-work?scope=k-7");
    expect(keys(await listAt("Build"))).toEqual(["WEB-8"]);
    expect(within(line()).getByLabelText("2 more Tasks outside this scope")).toBeInTheDocument();
    // The list's link would carry the scope; WEB-8 is the only one, so there is none.
    expect(screen.getByText("2 hidden")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open WEB-7" })).toHaveAttribute("href", "/tasks/WEB-7");
    expect(screen.getByRole("button", { name: "Scope: WEB-7 Emoji reactions" })).toBeInTheDocument();
    expect(within(line()).getByText("Next for WEB-7")).toBeInTheDocument();
    // × widens it again.
    await userEvent.click(screen.getByRole("button", { name: "All Tasks" }));
    await waitFor(() => expect(within(line()).getByRole("button", { name: /^Build: / })).toHaveAccessibleName("Build: 3 Tasks waiting"));
  });

  it("the Filter narrows the tokens like a scope: what it leaves out counts into its Step's +N", async () => {
    serve([task(2), task(3, blockedBy(2)), task(4, { step_id: step.review })]);
    renderApp(`/projects/WEB/workflows/wf-work?filter.tasks=${encodeURIComponent("blocked:is:true")}`);
    expect(keys(await listAt("Build"))).toEqual(["WEB-3"]);
    expect(within(line()).queryByRole("button", { name: /^Review: / })).toBeNull();
    expect(within(line()).getAllByLabelText("1 more Task outside this scope")).toHaveLength(2);
    expect(screen.getByText("2 hidden")).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: /Filter/ })).toBeInTheDocument();
  });

  it("links a Step's list to the Tasks list at the Step under the scope and the Filter in force, one pill per field", async () => {
    const subs = [8, 9, 10, 11, 12, 13].map((n) => task(n, { parent_id: "k-7", rank: undefined, ...blockedBy(14) }));
    serve([task(7, { step_id: undefined, title: "Emoji reactions", subtask_counts: { open: 6, working: 0, done: 0, dropped: 0 } }), ...subs, task(14)]);
    // The Filter's own Parent pill gives way to the scope's; a pill the list cannot read is left out.
    const filters = ["blocked:is:true", "parent:in:k-7,k-99", "nonsense:is:x"].map((f) => `filter.tasks=${encodeURIComponent(f)}`).join("&");
    renderApp(`/projects/WEB/workflows/wf-work?scope=k-7&${filters}`);
    const list = await listAt("Build");
    expect(keys(list)).toHaveLength(5);
    const href = within(list).getByRole("link", { name: "1 more Task" }).getAttribute("href")!;
    expect(href.startsWith("/projects/WEB/tasks?")).toBe(true);
    expect(new URLSearchParams(href.split("?")[1]).getAll("filter.tasks")).toEqual([`step:is:${step.build}`, "parent:is:k-7", "blocked:is:true"]);
  });

  it("the scope menu lists All Tasks, the Parents with open Subtasks and No Parent, and narrows on a pick", async () => {
    serve([task(7, { step_id: undefined, title: "Emoji reactions", subtask_counts: { open: 1, working: 0, done: 0, dropped: 0 } }), task(8, { parent_id: "k-7", rank: undefined }), task(10)]);
    renderApp("/projects/WEB/workflows/wf-work");
    await userEvent.click(await screen.findByRole("button", { name: "Scope: All Tasks" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["All Tasks2", "WEB-7Emoji reactions1 open", "No Parent1"]);
    await userEvent.click(options[2]);
    await waitFor(() => expect(within(line()).getByRole("button", { name: /^Build: / })).toHaveAccessibleName("Build: 1 Task waiting"));
    expect(keys(await listAt("Build"))).toEqual(["WEB-10"]);
  });

  it("lists each Step's Tasks in the text view, held first, and the questions with a Member", async () => {
    serve([task(2), task(3, { claim: claim(builder.id) }), task(4, { aimed_at_id: ada.id, step_id: undefined, title: "Which format?" })]);
    renderApp("/projects/WEB/workflows/wf-work?view=text");
    const list = await screen.findByRole("list", { name: "Tasks at Build" });
    expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["WEB-3 Task 3, held by builder", "WEB-2 Task 2, waiting"]);
    expect(screen.getByRole("region", { name: "With a Member" })).toHaveTextContent("WEB-4Which format?With you");
  });
});

describe("the line as it happens", () => {
  it("a Task filed shows its token at its Step, tagged with who filed it", async () => {
    const { list } = serve([]);
    renderApp("/projects/WEB/workflows/wf-work");
    await screen.findByRole("region", { name: "Workflow" });
    list.tasks = [task(2)];
    deliver(entry(5, "task.filed", "k-2", { key: "WEB-2", project_id: "p-web", step_id: step.build }, ada.id));
    await waitFor(() => expect(tokenOf("WEB-2")).not.toBeNull());
    await waitFor(() => expect(tokenOf("WEB-2")!.parentElement!.querySelector("[data-tag]")).toHaveTextContent("ada filed"));
    expect(screen.getAllByRole("status").some((s) => s.textContent === "ada filed WEB-2 at Build")).toBe(true);
  });

  it("a pickup reads 'now' on the token with its tag: who picked it up and how long it waited", async () => {
    const { list } = serve([task(2, { step_since: new Date(Date.now() - 43 * 60_000).toISOString() })]);
    renderApp("/projects/WEB/workflows/wf-work");
    await countAt("Build");
    list.tasks = [task(2, { step_since: new Date(Date.now() - 43 * 60_000).toISOString(), claim: claim(builder.id, new Date().toISOString()) })];
    deliver(entry(6, "task.claimed", "k-2", { step_id: step.build }, builder.id));
    await waitFor(() => expect(tokenOf("WEB-2")).toHaveAttribute("data-now"));
    expect(tokenOf("WEB-2")).toHaveTextContent("now");
    expect(tokenOf("WEB-2")).toHaveAttribute("data-pulse", "agent");
    expect(tokenOf("WEB-2")!.parentElement!.querySelector("[data-tag]")).toHaveTextContent("nowbuilder picked up· waited 43m");
    // In the row's flow after its token, never laid over the count or a mark beside it.
    const tag = tokenOf("WEB-2")!.parentElement!.querySelector("[data-tag]")!;
    expect(tag).not.toHaveClass("absolute");
    expect(tokenOf("WEB-2")!.nextElementSibling).toBe(tag);
  });

  it("an advance carries a token along its Connector, its outcome lit, and the Task lands at its next Step", async () => {
    const { list } = serve([task(2)]);
    renderApp("/projects/WEB/workflows/wf-work");
    await countAt("Build");
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
    renderApp("/projects/WEB/workflows/wf-work");
    await countAt("Build");
    list.tasks = [task(2, { step_id: step.review })];
    deliver(entry(7, "task.advanced", "k-2", { from: step.build, to: step.review, outcome: "pass" }, builder.id));
    await waitFor(() => expect(tokenOf("WEB-2")).toHaveAttribute("data-arrived"));
    expect(document.querySelector("[data-travel]")).toBeNull();
  });
});

describe("the scope menu of a Project of one Workflow", () => {
  it("lists an ended Parent with an open Retrospective on the line by its key and title", async () => {
    const parent = task(9, { title: "Launch", state: "done", step_id: undefined, step_since: undefined, skill_id: undefined, ended_at: new Date().toISOString(), subtask_counts: { open: 1, working: 0, done: 1, dropped: 0 } });
    serve([parent, task(10, { title: "Retrospective: Launch", parent_id: parent.id, kind: "retrospective", step_id: step.retro }), task(2)]);
    renderApp("/projects/WEB/workflows/wf-work");
    await countAt("Retro");
    // The open Tasks leave the ended Parent out; the page reads it, so the menu names it.
    await userEvent.click(screen.getByRole("button", { name: /^Scope: / }));
    await waitFor(async () => expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["All Tasks2", "WEB-9Launch1 open", "No Parent1"]));
    await userEvent.click(screen.getByRole("option", { name: /WEB-9/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Scope: WEB-9 Launch" })).toBeInTheDocument());
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
    renderApp(`/projects/WEB/workflows/${wfId.triage}`);
    await countAt("Triage");
    expect(heads()).toEqual(["Triage", "Done"]);
    // Triage's four outcomes leave the line as exits; WEB-2, at Investigate, is on Bugs' line.
    expect(within(line()).getByText("bug → Bugs › Investigate").closest("[data-chip]")).toHaveAttribute("data-chip", "exit");
    expect(keys(await listAt("Triage"))).toEqual(["WEB-1"]);
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Triage" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
    await userEvent.click(screen.getByRole("option", { name: "Bugs" }));
    await waitFor(() => expect(heads()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]));
    expect(line().querySelector('[data-start-row] [data-chip="entry"]')).toHaveTextContent("Triage · bug");
    expect(keys(await listAt("Investigate"))).toEqual(["WEB-2"]);
    expect(screen.getByRole("button", { name: "Workflow: Bugs" })).toBeInTheDocument();
  });

  it("opens on the Workflow ?workflow= names, the one the board shows", async () => {
    several([at(2, "Crash on save", wfStep.investigate, wfId.bugs)]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}`);
    await countAt("Investigate");
    expect(heads()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]);
    // At every width: a phone has no other way to another Workflow.
    expect(screen.getByRole("button", { name: "Workflow: Bugs" }).closest(".hidden")).toBeNull();
  });

  it("a Project of one Workflow has no chip", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflows/wf-work");
    await countAt("Build");
    expect(screen.queryByRole("button", { name: /^Workflow: / })).toBeNull();
  });

  it("counts as hidden only the drawn Workflow's Tasks the scope leaves out", async () => {
    several([
      at(1, "Sort the inbox", wfStep.triage, wfId.triage, { parent_id: "k-9" }),
      at(3, "Another to sort", wfStep.triage, wfId.triage),
      at(2, "Crash on save", wfStep.investigate, wfId.bugs, { parent_id: "k-9" }),
    ]);
    renderApp(`/projects/WEB/workflows/${wfId.triage}?scope=none`);
    expect(keys(await listAt("Triage"))).toEqual(["WEB-3"]);
    // WEB-1 is left out here; WEB-2, also a Subtask, is on Bugs' line and not counted.
    expect(screen.getByText("1 hidden")).toBeInTheDocument();
  });

  it("the Text view lists the drawn Workflow's Steps, naming where an outcome crosses and where Tasks enter", async () => {
    several([at(2, "Crash on save", wfStep.investigate, wfId.bugs)]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}?view=text`);
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
    renderApp(`/projects/WEB/workflows/${wfId.triage}`);
    await waitFor(() => expect(within(line()).getByText("1 today")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Triage" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bugs" }));
    await waitFor(() => expect(within(line()).getByText("2 today")).toBeInTheDocument());
  });

  it("counts an ended Parent under Done where its board's Done column has it: where its Subtasks ended", async () => {
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    // The server lists it where its one Subtask ended: Bugs.
    const parent = task(9, { title: "Launch", state: "done", step_id: undefined, step_since: undefined, skill_id: undefined, workflow_id: wfId.bugs, ended_at: today, subtask_counts: { open: 0, working: 0, done: 0, dropped: 1 } });
    several([
      at(3, "Sorted", wfStep.triage, wfId.triage, { state: "done", step_id: undefined, last_step_id: wfStep.triage, ended_at: today }),
      parent,
      // Its one Subtask, dropped at Fix yesterday: not done today itself, but where the Parent's Done card sits.
      at(10, "Ship it", wfStep.fix, wfId.bugs, { parent_id: parent.id, state: "dropped", step_id: undefined, last_step_id: wfStep.fix, ended_at: yesterday }),
    ]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}`);
    await waitFor(() => expect(within(line()).getByText("1 today")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Workflow: Bugs" }));
    await userEvent.click(await screen.findByRole("option", { name: "Triage" }));
    // Triage counts Sorted only: the Parent is not on its board's Done for want of a Step of its own.
    await waitFor(() => expect(screen.getByRole("button", { name: "Workflow: Triage" })).toBeInTheDocument());
    await waitFor(() => expect(within(line()).getByText("1 today")).toBeInTheDocument());
  });

  const scopeMenu = async () => {
    await userEvent.click(screen.getByRole("button", { name: /^Scope: / }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    await userEvent.keyboard("{Escape}");
    return options;
  };
  const pickWorkflow = async (from: string, to: string) => {
    await userEvent.click(screen.getByRole("button", { name: `Workflow: ${from}` }));
    await userEvent.click(await screen.findByRole("option", { name: to }));
    await waitFor(() => expect(screen.getByRole("button", { name: `Workflow: ${to}` })).toBeInTheDocument());
  };

  it("lists a Parent in the scope menu of each line one of its open Subtasks is on", async () => {
    const parent = task(9, { title: "Launch", step_id: undefined, step_since: undefined, skill_id: undefined, workflow_id: wfId.triage, subtask_counts: { open: 2, working: 0, done: 0, dropped: 0 } });
    several([parent, at(1, "Sort the inbox", wfStep.triage, wfId.triage, { parent_id: parent.id }), at(2, "Crash on save", wfStep.investigate, wfId.bugs, { parent_id: parent.id })]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}`);
    await countAt("Investigate");
    // WEB-2, a Subtask of WEB-9, is on Bugs' line: WEB-9 scopes it here, though its board is Triage's.
    expect(await scopeMenu()).toEqual(["All Tasks1", "WEB-9Launch1 open", "No Parent0"]);
    await pickWorkflow("Bugs", "Triage");
    await countAt("Triage");
    expect(await scopeMenu()).toEqual(["All Tasks1", "WEB-9Launch1 open", "No Parent0"]);
    await pickWorkflow("Triage", "Features");
    expect(await scopeMenu()).toEqual(["All Tasks0", "No Parent0"]);
  });

  it("lists an ended Parent on the line its Retrospective is open on, and counts it under Done where its work ended", async () => {
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    // The server lists it where its work ended, Bugs, not where its Retrospective is.
    const parent = task(9, { title: "Launch", state: "done", step_id: undefined, step_since: undefined, skill_id: undefined, workflow_id: wfId.bugs, ended_at: today, subtask_counts: { open: 1, working: 0, done: 0, dropped: 1 } });
    several([
      parent,
      // Dropped at Fix yesterday: where the Parent's work ended (and not itself done today).
      at(10, "Ship it", wfStep.fix, wfId.bugs, { parent_id: parent.id, state: "dropped", step_id: undefined, last_step_id: wfStep.fix, ended_at: yesterday }),
      // Filed as the Parent ended, open at a Step of another Workflow.
      at(11, "Retrospective: Launch", wfStep.support, wfId.support, { parent_id: parent.id, kind: "retrospective" }),
    ]);
    renderApp(`/projects/WEB/workflows/${wfId.support}`);
    await countAt("Support");
    expect(await scopeMenu()).toEqual(["All Tasks1", "WEB-9Launch1 open", "No Parent0"]);
    expect(within(line()).queryByText("1 today")).toBeNull();
    await pickWorkflow("Support", "Bugs");
    await waitFor(() => expect(within(line()).getByText("1 today")).toBeInTheDocument());
    expect(await scopeMenu()).toEqual(["All Tasks0", "No Parent0"]);
  });

  it("lists a Parent waiting with its Owner on the one page where its Subtasks ended, as its board does", async () => {
    // The server lists it where its Subtask ended: Bugs.
    const parent = task(9, { title: "Launch", step_id: undefined, step_since: undefined, skill_id: undefined, workflow_id: wfId.bugs, subtask_counts: { open: 0, working: 0, done: 1, dropped: 0 } });
    several([parent, at(10, "Ship it", wfStep.fix, wfId.bugs, { parent_id: parent.id, state: "done", step_id: undefined, last_step_id: wfStep.fix, ended_at: new Date().toISOString() })]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}`);
    const needs = await screen.findByRole("region", { name: "Needs you" });
    await waitFor(() => expect(within(needs).getByText("Launch")).toBeInTheDocument());
    for (const [from, to] of [["Bugs", "Triage"], ["Triage", "Support"]]) {
      await pickWorkflow(from, to);
      await waitFor(() => expect(within(screen.getByRole("region", { name: "Needs you" })).queryByText("Launch")).toBeNull());
    }
  });

  it("lists a question under a Parent on the page of the Parent's board", async () => {
    // Blocking nothing, the question is listed with its Parent, which is listed at Investigate's Workflow.
    const parent = task(9, { title: "Launch", step_id: undefined, step_since: undefined, skill_id: undefined, workflow_id: wfId.bugs, subtask_counts: { open: 2, working: 0, done: 0, dropped: 0 } });
    const asked = task(12, { title: "Which build crashed?", parent_id: parent.id, step_id: undefined, step_since: undefined, skill_id: undefined, aimed_at_id: ada.id, workflow_id: wfId.bugs });
    several([parent, asked, at(2, "Crash on save", wfStep.investigate, wfId.bugs, { parent_id: parent.id })]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}?view=text`);
    const withMember = await screen.findByRole("region", { name: "With a Member" });
    await waitFor(() => expect(within(withMember).getByText("Which build crashed?")).toBeInTheDocument());
    await pickWorkflow("Bugs", "Triage");
    await waitFor(() => expect(screen.queryByText("Which build crashed?")).toBeNull());
  });

  it("keeps a Parent's scope across a pick of a Workflow one of its open Subtasks is on, and drops it on another", async () => {
    const parent = task(9, { title: "Launch", step_id: undefined, step_since: undefined, skill_id: undefined, workflow_id: wfId.triage, subtask_counts: { open: 2, working: 0, done: 0, dropped: 0 } });
    several([parent, at(1, "Sort the inbox", wfStep.triage, wfId.triage, { parent_id: parent.id }), at(2, "Crash on save", wfStep.investigate, wfId.bugs, { parent_id: parent.id })]);
    renderApp(`/projects/WEB/workflows/${wfId.triage}?scope=k-9`);
    await waitFor(() => expect(screen.getByRole("button", { name: "Scope: WEB-9 Launch" })).toBeInTheDocument());
    await pickWorkflow("Triage", "Bugs");
    expect(screen.getByRole("button", { name: "Scope: WEB-9 Launch" })).toBeInTheDocument();
    await countAt("Investigate");
    await pickWorkflow("Bugs", "Features");
    await waitFor(() => expect(screen.getByRole("button", { name: "Scope: All Tasks" })).toBeInTheDocument());
  });

  it("lists a question where the server lists it, beside the Task it blocks, and one listed nowhere on every page", async () => {
    const q = (n: number, title: string, extra: Partial<Task> = {}) => task(n, { title, step_id: undefined, step_since: undefined, skill_id: undefined, aimed_at_id: ada.id, ...extra });
    const blocked = (by: Task) => ({ blocked: true, open_blockers: [{ id: by.id, key: by.key, title: by.title }] });
    // The server lists it beside the Task it blocks; the other it lists nowhere.
    const forBugs = q(20, "Which build crashed?", { workflow_id: wfId.bugs });
    const loose = q(21, "Anyone seen this?");
    several([forBugs, loose, at(2, "Crash on save", wfStep.investigate, wfId.bugs, blocked(forBugs))]);
    renderApp(`/projects/WEB/workflows/${wfId.triage}?view=text`);
    const withMember = await screen.findByRole("region", { name: "With a Member" });
    expect(within(withMember).queryByText("Which build crashed?")).toBeNull();
    expect(within(withMember).getByText("Anyone seen this?")).toBeInTheDocument();
  });

  it("drops the scope on a pick of a Workflow its Task is not on, and keeps it where it is", async () => {
    several([at(1, "Sort the inbox", wfStep.triage, wfId.triage), at(2, "Crash on save", wfStep.investigate, wfId.bugs)]);
    renderApp(`/projects/WEB/workflows/${wfId.bugs}?scope=k-2`);
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
    renderApp(`/projects/WEB/workflows/${wfId.triage}`);
    await countAt("Triage");
    list.tasks = [at(2, "Crash on save", wfStep.investigate, wfId.bugs)];
    deliver(entry(7, "task.advanced", "k-2", { from: wfStep.triage, to: wfStep.investigate, outcome: "bug" }, builder.id));
    const travel = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-travel]");
      expect(el).toHaveTextContent("WEB-2bug");
      return el!;
    });
    const station = line().querySelector(`[data-dot="${wfStep.triage}"]`)!;
    // Off the line to the right, from Triage's station.
    expect(travel.style.offsetPath).toMatch(new RegExp(`^path\\("M${station.getAttribute("cx")} ${station.getAttribute("cy")} H[\\d.]+"\\)$`));
    expect(line().querySelector(`[data-exit="${bug.id}"]`)).not.toBeNull();
    await waitFor(() => expect(document.querySelector("[data-travel]")).toBeNull(), { timeout: 3000 });
    expect(tokenOf("WEB-2")).toBeNull();
  });
});
