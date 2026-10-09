import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Schemas, Workflows } from "@/api/client";
import { mockApi, refuse, type Call } from "@/test/api";
import { ada, bob, builder, engineer, memberDetail, ops, review, skillReview, skills, step, web, wfId, wfStep, workflow, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import { signedIn } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { toBody } from "./bind";
import { addOutcome, deleteStep, fromRecord, insertStep, makeMain, moveStepTo, renameOutcome, renameStep, reorderStep, setSkill, setTarget, removeOutcome, groupsOf } from "./edit/draft";

type Body = Schemas["SetWorkflowBody"];

/**
 * The items of a body list numbered as /v1 numbers them: by the position given, one left out or 0
 * reading as its place in the list, then 1, 2, 3… in that order.
 */
function numbered<T extends { position?: number }>(items: readonly T[]): (T & { position: number })[] {
  return items
    .map((x, i) => ({ x, at: x.position || i + 1, i }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(({ x }, i) => ({ ...x, position: i + 1 }));
}

/** `numbered` within each bucket `keyOf` names, keeping the list's order across buckets. */
function numberedPer<T extends { position?: number }>(items: readonly T[], keyOf: (x: T) => string): (T & { position: number })[] {
  const keys = [...new Set(items.map(keyOf))];
  return keys.flatMap((k) => numbered(items.filter((x) => keyOf(x) === k)));
}

/**
 * The record a PUT body makes of `wf`, as /v1 answers: a Workflow without an id keeps that of the
 * one named alike, ignoring case, unless another Workflow of the body already carries that id;
 * else it is new. New Steps and Connectors get ids; the facts stay. Workflows are numbered 1..n,
 * Steps 1..n within their Workflow, Connectors 1..n among those out of their Step.
 */
function answer(wf: Workflows, body: Body): Workflows | Response {
  let n = 0;
  const carried = new Set(body.workflows.flatMap((w) => (w.id ? [w.id] : [])));
  const workflows = numbered(body.workflows).map((w) => ({
    id: w.id ?? wf.workflows.find((x) => x.name.toLowerCase() === w.name.toLowerCase() && !carried.has(x.id))?.id ?? `wf-made-${++n}`,
    name: w.name,
    position: w.position,
  }));
  const workflowOf = (ref: string) => (workflows.find((w) => w.id === ref) ?? workflows.find((w) => w.name.toLowerCase() === ref.toLowerCase()))?.id;
  // As /v1: a Step naming no Workflow of the body is refused, nothing made.
  const stray = body.steps.find((s) => !workflowOf(s.workflow));
  if (stray) return refuse(400, "invalid", `a Step names "${stray.workflow}", which is not a Workflow of the body`);
  const steps = numberedPer(body.steps, (s) => workflowOf(s.workflow)!).map((s) => {
    const was = wf.steps.find((x) => x.id === s.id);
    return {
      id: s.id ?? `st-made-${++n}`,
      workflow_id: workflowOf(s.workflow)!,
      name: s.name,
      skill_id: s.skill,
      position: s.position,
      x: s.x ?? was?.x ?? 0,
      y: s.y ?? was?.y ?? 0,
      tasks: was?.tasks ?? 0,
      working: was?.working ?? 0,
      takers: s.skill === was?.skill_id ? (was?.takers ?? []) : [],
    };
  });
  const ref = (r?: string) => (r === undefined ? undefined : (steps.find((s) => s.id === r || s.name.toLowerCase() === r.toLowerCase())?.id ?? r));
  return {
    project_id: wf.project_id,
    workflows,
    steps,
    connectors: numberedPer(body.connectors, (c) => ref(c.from)!).map((c) => ({
      id: c.id ?? `c-made-${++n}`,
      from_step_id: ref(c.from)!,
      to_step_id: ref(c.to),
      name: c.name,
      position: c.position,
    })),
  };
}

/** Signed in as `who`, WEB's Workflow served from `record` and replaced by each PUT, which is recorded. */
function serve(record: Workflows = workflow(), who = ada, extra: Record<string, unknown> = {}) {
  let current = record;
  const puts: Body[] = [];
  const api = mockApi({
    ...signedIn(who),
    "GET /v1/projects/:project/workflow": ({ params }: Call & { params: Record<string, string> }) => (params.project === "WEB" || params.project === web.id ? current : workflow(ops)),
    "PUT /v1/projects/:project/workflow": ({ body }: Call) => {
      puts.push(body as Body);
      const made = answer(current, body as Body);
      if (made instanceof Response) return made;
      current = made;
      return current;
    },
    ...extra,
  });
  return { api, puts, current: () => current };
}


const skillMap = new Map(skills.map((s) => [s.id, s]));
const groups = groupsOf(workflow(), skillMap);

/** Settings › Workflow open on the list with Build in the panel (the address names it), once WEB's Workflow is drawn. */
async function openList(path = `/settings/projects/WEB/workflows?step=${step.build}`) {
  renderApp(path);
  await screen.findByRole("list", { name: "Steps" });
  return within(screen.getByRole("list", { name: "Steps" }));
}
const save = () => userEvent.click(screen.getByRole("button", { name: "Save" }));
/** Opens a Step in the panel by its row: "3. Build". */
const pick = (row: string) => userEvent.click(within(screen.getByRole("list", { name: "Steps" })).getByRole("button", { name: row }));
const panel = (name: RegExp | string) => within(screen.getByRole("region", { name }));
const header = () => screen.getByRole("status", { name: "Editing" });

describe("Settings › Workflow", () => {
  it("shows a Member who is not an admin the list and the panel read-only, saying only an admin changes it", async () => {
    serve(workflow(), bob);
    const list = await openList();
    expect(screen.getByText(/Only an admin changes Web's Workflow/)).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Add a Step/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(list.getByRole("listitem", { name: "3. Build" })).toHaveTextContent(/Build.*engineer.*→ Review/);
    expect(panel("Step 3: Build").getByRole("heading", { name: "Build" })).toBeInTheDocument();
  });

  it("lists the Steps as text in order, the Steps after a Parent in their own group, the line above, and none open", async () => {
    serve();
    const list = await openList("/settings/projects/WEB/workflows");
    expect(list.getAllByRole("listitem").map((r) => r.getAttribute("aria-label"))).toEqual(["1. Backlog", "2. Plan", "3. Build", "4. Review", "5. Retro", "6. Skill review"]);
    expect(list.getByText("After a Parent")).toBeInTheDocument();
    expect(list.queryByText(/Darkory files Acceptance under a Parent/)).toBeNull();
    expect(list.getByRole("listitem", { name: "1. Backlog" })).toHaveTextContent(/Backlog.*Hold.*by hand/);
    expect(list.getByRole("listitem", { name: "2. Plan" })).toHaveTextContent(/Break down$/);
    expect(within(list.getByRole("listitem", { name: "2. Plan" })).getByLabelText("Break down: Subtasks start at Build by default")).toBeInTheDocument();
    expect(list.getByRole("listitem", { name: "3. Build" })).toHaveTextContent("New Tasks start here");
    expect(list.getByRole("listitem", { name: "6. Skill review" })).toHaveTextContent("Organisation-wide");
    expect(list.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByRole("img", { name: /^The line: Build → Review → Done\. New Tasks start at Build\. Break down: Plan, whose Subtasks start at Build by default\. Hold: Backlog, moved on by hand\.$/ })).toBeInTheDocument();
    // No Step is open until one is picked.
    expect(list.getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "true")).toEqual([]);
    expect(screen.queryByRole("textbox", { name: /^Name of Step/ })).toBeNull();
    expect(screen.getByRole("note", { name: "No Step picked" })).toHaveTextContent(/^Pick a Step$/);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await pick("3. Build");
    expect(screen.getByRole("textbox", { name: "Name of Step 3" })).toHaveValue("Build");
    expect(screen.queryByRole("note", { name: "No Step picked" })).toBeNull();
  });

  it("picks a Step from its row, with ↑ and ↓, and from the address", async () => {
    serve();
    const list = await openList("/settings/projects/WEB/workflows?step=st-review");
    expect(screen.getByRole("textbox", { name: "Name of Step 4" })).toHaveValue("Review");
    await pick("2. Plan");
    expect(screen.getByRole("textbox", { name: "Name of Step 2" })).toHaveValue("Plan");
    fireEvent.keyDown(list.getByRole("button", { name: "2. Plan" }), { key: "ArrowDown" });
    expect(screen.getByRole("textbox", { name: "Name of Step 3" })).toHaveValue("Build");
    expect(list.getByRole("button", { name: "3. Build" })).toHaveFocus();
  });

  it("renames a Step: nothing sent until Save, then one PUT of the whole Workflow", async () => {
    const { api, puts } = serve();
    await openList();
    const name = screen.getByRole("textbox", { name: "Name of Step 3" });
    await userEvent.clear(name);
    await userEvent.type(name, "Make");
    expect(header()).toHaveTextContent("Editing · 1 change");
    expect(within(screen.getByRole("list", { name: "Steps" })).getByRole("listitem", { name: "3. Make" })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(renameStep(fromRecord(workflow()), step.build, "Make").wf));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
  });

  it("changes a Step's Skill, and makes a hold of another", async () => {
    const { puts } = serve();
    await openList();
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Build" }));
    await userEvent.click(await screen.findByRole("option", { name: /^review/ }));
    await pick("2. Plan");
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Plan" }));
    await userEvent.click(await screen.findByRole("option", { name: "None: a hold" }));
    expect(screen.getByRole("combobox", { name: "Skill of Plan" })).toHaveTextContent(/^Hold$/);
    expect(panel("Step 2: Plan").getByText("By hand")).toBeInTheDocument();
    expect(header()).toHaveTextContent("2 changes");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    let d = setSkill(fromRecord(workflow()), step.build, { id: review.id });
    d = setSkill(d, step.plan, undefined);
    expect(puts[0]).toEqual(toBody(d.wf));
    expect(puts[0].steps.find((s) => s.name === "Plan")!.skill).toBeUndefined();
  });

  it("creates a new generic Skill on Save, in the Workflow's one PUT, and the Step carries it by name", async () => {
    const { api, puts } = serve();
    await openList();
    await pick("4. Review");
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Review" }));
    await userEvent.type(await screen.findByPlaceholderText("Find or name a Skill"), "security");
    await userEvent.click(await screen.findByRole("option", { name: /New Skill “security”/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "New Skill “security”" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Text" }), "Look for holes.");
    await userEvent.click(dialog.getByRole("button", { name: "Use this Skill" }));
    expect(screen.getByRole("combobox", { name: "Skill of Review" })).toHaveTextContent("security");
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /v1/projects/WEB/workflow"]);
    expect(puts[0].skills).toEqual([{ name: "security", body: "Look for holes." }]);
    expect(puts[0].steps.find((s) => s.name === "Review")!.skill).toBe("security");
  });

  it("sends the new Skill again with the Workflow after a refusal: nothing was made", async () => {
    let refusing = true;
    const { api, puts } = serve();
    const put = api.routes["PUT /v1/projects/:project/workflow"] as (call: Call) => Workflows;
    api.routes["PUT /v1/projects/:project/workflow"] = (call: Call) => (refusing ? ((refusing = false), refuse(409, "conflict", "Try again.")) : put(call));
    await openList();
    await pick("4. Review");
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Review" }));
    await userEvent.type(await screen.findByPlaceholderText("Find or name a Skill"), "security");
    await userEvent.click(await screen.findByRole("option", { name: /New Skill “security”/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "New Skill “security”" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Text" }), "Look for holes.");
    await userEvent.click(dialog.getByRole("button", { name: "Use this Skill" }));
    await save();
    expect(await screen.findByText(/Try again/)).toBeInTheDocument();
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].skills).toEqual([{ name: "security", body: "Look for holes." }]);
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("adds a Step between two: a hold with no outcome, open with its name in focus; nothing is re-pointed", async () => {
    const { puts } = serve();
    const list = await openList();
    await userEvent.click(list.getByRole("button", { name: "Add a Step after Build" }));
    const name = screen.getByRole("textbox", { name: "Name of Step 4" });
    expect(name).toHaveFocus();
    expect(list.getByRole("button", { name: "4. New Step" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("combobox", { name: "Skill of the new Step" })).toHaveTextContent(/^Hold$/);
    const p = panel("Step 4: New Step");
    expect(p.getByText("New · no Tasks")).toBeInTheDocument();
    expect(p.getByText("By hand")).toBeInTheDocument();
    expect(p.queryByRole("textbox", { name: /^Outcome out of/ })).toBeNull();
    await userEvent.type(name, "Security review");
    expect(header()).toHaveTextContent("1 change");
    expect(list.getByRole("listitem", { name: "3. Build" })).toHaveTextContent("→ Review");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const r = insertStep(fromRecord(workflow()), step.build, "main");
    expect(puts[0]).toEqual(toBody(renameStep(r.draft, r.id, "Security review").wf));
    expect(puts[0].connectors.filter((c) => c.from === "Security review")).toEqual([]);
  });

  it("adds a Step at the end of each group, listed in it, and from the panel's menu", async () => {
    serve();
    const list = await openList();
    await userEvent.click(list.getByRole("button", { name: "Add a Step after a Parent" }));
    expect(list.getAllByRole("listitem").map((r) => r.getAttribute("aria-label")).at(-1)).toBe("7. New Step");
    await userEvent.click(list.getByRole("button", { name: "Add a Step at the end of the line" }));
    expect(list.getAllByRole("listitem")[4]).toHaveAttribute("aria-label", "5. New Step");
    await pick("2. Plan");
    await userEvent.click(screen.getByRole("button", { name: "More for Plan" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add Step after Plan" }));
    expect(list.getAllByRole("listitem")[2]).toHaveAttribute("aria-label", "3. New Step");
    expect(header()).toHaveTextContent("3 changes");
  });

  it("re-points an outcome, and puts it back with its undo", async () => {
    serve();
    await openList();
    await userEvent.click(screen.getByRole("combobox", { name: "Where pass out of Build leads" }));
    await userEvent.click(await screen.findByRole("option", { name: "Plan" }));
    expect(header()).toHaveTextContent("1 change");
    await userEvent.click(screen.getByRole("button", { name: "Undo: lead pass back to Review" }));
    expect(screen.getByRole("combobox", { name: "Where pass out of Build leads" })).toHaveTextContent("Review");
    expect(header()).toHaveTextContent(/^Editing$/);
  });

  it("adds an outcome, names it and picks its Step; removes another", async () => {
    const { puts } = serve();
    await openList();
    await userEvent.click(screen.getByRole("button", { name: "Add an outcome out of Build" }));
    const outcome = screen.getAllByRole("textbox", { name: "Outcome out of Build" }).at(-1)!;
    expect(outcome).toHaveFocus();
    await userEvent.type(outcome, "fail");
    await userEvent.click(screen.getByRole("combobox", { name: "Where fail out of Build leads" }));
    await userEvent.click(await screen.findByRole("option", { name: "Plan" }));
    await pick("4. Review");
    await userEvent.click(screen.getByRole("button", { name: "Remove needs changes out of Review" }));
    expect(header()).toHaveTextContent("2 changes");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const a = addOutcome(fromRecord(workflow()), step.build);
    let d = setTarget(renameOutcome(a.draft, a.id, "fail"), a.id, step.plan);
    d = removeOutcome(d, `${step.review}-c4`);
    expect(puts[0]).toEqual(toBody(d.wf));
  });

  it("makes another outcome the main way on with its radio: it goes first, the line follows it", async () => {
    const { puts } = serve();
    await openList();
    await pick("4. Review");
    const main = within(screen.getByRole("radiogroup", { name: "Main outcome out of Review" }));
    expect(main.getByRole("radio", { name: "pass: the main way on" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(main.getByRole("radio", { name: "needs changes: the main way on" }));
    expect(main.getByRole("radio", { name: "needs changes: the main way on" })).toHaveAttribute("aria-checked", "true");
    expect(header()).toHaveTextContent("1 change");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(makeMain(fromRecord(workflow()), `${step.review}-c4`).wf));
  });

  it("reorders Steps within their group with Alt+↑ and Alt+↓, and from the panel's menu", async () => {
    const { puts } = serve();
    const list = await openList();
    const plan = list.getByRole("button", { name: "2. Plan" });
    act(() => plan.focus());
    fireEvent.keyDown(plan, { key: "ArrowDown", altKey: true });
    expect(list.getAllByRole("listitem").map((r) => r.getAttribute("aria-label")).slice(0, 4)).toEqual(["1. Backlog", "2. Build", "3. Plan", "4. Review"]);
    expect(list.getByRole("button", { name: "3. Plan" })).toHaveFocus();
    // Review is last of the main Steps: it does not cross into the Steps after a Parent.
    fireEvent.keyDown(list.getByRole("button", { name: "4. Review" }), { key: "ArrowDown", altKey: true });
    expect(list.getAllByRole("listitem")[3]).toHaveAttribute("aria-label", "4. Review");
    expect(header()).toHaveTextContent("1 change");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(reorderStep(fromRecord(workflow()), step.plan, 1, groups).wf));
    expect(toBody(moveStepTo(fromRecord(workflow()), step.plan, step.build).wf)).toEqual(puts[0]);
  });

  it("moves a Step from its panel's menu, Move up off at the top of its group", async () => {
    serve();
    const list = await openList();
    await pick("4. Review");
    await userEvent.click(screen.getByRole("button", { name: "More for Review" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move up" }));
    expect(list.getAllByRole("listitem")[2]).toHaveAttribute("aria-label", "3. Review");
    await pick("1. Backlog");
    await userEvent.click(screen.getByRole("button", { name: "More for Backlog" }));
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
  });

  it("asks before deleting a Step with Tasks and an outcome into it: where they go, the outcome removed or led on, and the start moving", async () => {
    const record = workflow(web, { review: { tasks: 2 } });
    const { puts } = serve(record);
    const list = await openList();
    await pick("4. Review");
    await userEvent.click(screen.getByRole("button", { name: "Delete Review" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Review" }));
    expect(dialog.getByText("Review holds Tasks and other Steps lead into it.")).toBeInTheDocument();
    expect(dialog.getByRole("heading", { name: "2 Tasks at Review" })).toBeInTheDocument();
    expect(dialog.getByRole("heading", { name: "1 outcome leads into Review" })).toBeInTheDocument();
    expect(dialog.getByRole("combobox", { name: "Where pass out of Build leads instead" })).toHaveTextContent("Remove this outcome");
    expect(dialog.getByRole("note")).toHaveTextContent("Without Review, Build has no way out.");
    expect(dialog.getByText("Review's own outcomes go: pass → Done, needs changes → Build.")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Delete Review" })).toBeDisabled();
    await userEvent.click(dialog.getByRole("combobox", { name: "Step that receives the Tasks at Review" }));
    await userEvent.click(await screen.findByRole("option", { name: "Build" }));
    // Build's pass leads into Done instead: Build keeps a way out.
    await userEvent.click(dialog.getByRole("combobox", { name: "Where pass out of Build leads instead" }));
    await userEvent.click(await screen.findByRole("option", { name: "Done" }));
    expect(dialog.queryByRole("note")).toBeNull();
    await userEvent.click(dialog.getByRole("button", { name: "Delete Review" }));
    expect(list.queryByRole("listitem", { name: /Review$/ })).toBeNull();
    expect(header()).toHaveTextContent("2 changes");
    // Review was the last Step on the line: the panel moves to the one above it, Build, never to
    // Retro after a Parent.
    expect(list.getByRole("button", { name: "3. Build" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("textbox", { name: "Name of Step 3" })).toHaveValue("Build");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const d = deleteStep(fromRecord(record), step.review, step.build, { [`${step.build}-c2`]: { to: undefined } });
    expect(puts[0]).toEqual(toBody(d.wf, d.moves));
    expect(puts[0].moves).toEqual({ [step.review]: step.build });
  });

  it("removes the outcomes into a deleted Step when left to, and lists every change", async () => {
    serve();
    await openList();
    await userEvent.click(screen.getByRole("button", { name: "Delete Build" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Build" }));
    expect(dialog.getByText("New Tasks start at Review, and so do Plan's Subtasks filed naming no Step.")).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Delete Build" }));
    expect(header()).toHaveTextContent("2 changes");
    // The panel moves to the Step that was below Build.
    expect(screen.getByRole("textbox", { name: "Name of Step 3" })).toHaveValue("Review");
    await userEvent.click(screen.getByRole("button", { name: "Editing · 2 changes: list them" }));
    const changes = within(await screen.findByRole("list", { name: "Changes" }));
    expect(changes.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["DeletedBuild", "RemovedReview · needs changes → Build"]);
    expect(screen.getByText(/New Tasks start at Review\. Undo: ⌘Z/)).toBeInTheDocument();
  });

  it("deletes a Step at once when it holds no Task, nothing leads into it and it strands nothing", async () => {
    serve();
    const list = await openList();
    await pick("2. Plan");
    await userEvent.click(screen.getByRole("button", { name: "Delete Plan" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(list.queryByRole("listitem", { name: "2. Plan" })).toBeNull();
    expect(header()).toHaveTextContent("1 change");
  });

  it("says in words what /v1 would refuse, marks the field, and sends nothing", async () => {
    const { api } = serve();
    const list = await openList();
    await userEvent.click(list.getByRole("button", { name: "Add a Step after Build" }));
    await save();
    expect(await screen.findByRole("alert")).toHaveTextContent("A Step needs a name.");
    expect(screen.getByRole("textbox", { name: "Name of Step 4" })).toHaveAttribute("aria-invalid", "true");
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await userEvent.type(screen.getByRole("textbox", { name: "Name of Step 4" }), "review");
    expect(screen.getByRole("alert")).toHaveTextContent("Two Steps are called review");
  });

  it("keeps the draft when /v1 refuses, and says why", async () => {
    serve(workflow(), ada, { "PUT /v1/projects/:project/workflow": refuse(409, "step_in_use", "Build still has Tasks.") });
    await openList();
    await userEvent.type(screen.getByRole("textbox", { name: "Name of Step 3" }), "!");
    await save();
    expect(await screen.findByText(/Build still has Tasks/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name of Step 3" })).toHaveValue("Build!");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("undoes the last change with ⌘Z outside a field, a run of typing as one", async () => {
    serve();
    await openList();
    const name = screen.getByRole("textbox", { name: "Name of Step 3" });
    await userEvent.type(name, "er");
    act(() => name.blur());
    expect(header()).toHaveTextContent("1 change");
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    expect(name).toHaveValue("Build");
    expect(header()).toHaveTextContent(/^Editing$/);
  });

  it("asks before Cancel throws changes away", async () => {
    serve();
    await openList();
    await userEvent.type(screen.getByRole("textbox", { name: "Name of Step 3" }), "!");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Discard 1 change?" }));
    await userEvent.click(dialog.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /^Name of Step/ })).toBeNull());
  });

  describe("who takes a Step's Tasks", () => {
    // builder holds engineer and is in WEB and OPS; ada holds review and skill-review and is in WEB; bob is in neither.
    const inProject: Record<string, typeof ada[]> = { WEB: [ada, builder], OPS: [builder] };
    const people = {
      "GET /v1/projects/:project": ({ params }: Call & { params: Record<string, string> }) => {
        const p = params.project === "OPS" || params.project === ops.id ? ops : web;
        return { project: p, members: inProject[p.key] };
      },
      "GET /v1/members/:member": ({ params }: Call & { params: Record<string, string> }) => {
        const m = [ada, bob, builder].find((x) => x.id === params.member || x.name === params.member)!;
        return memberDetail(m, { projects: m === builder ? [web, ops] : m === ada ? [web] : [], skills: m === builder ? [engineer] : m === ada ? [review, skillReview] : [] });
      },
    };

    it("lists who takes each Step by name, says the Owner takes it when nobody does, and the panel lists them", async () => {
      serve(workflow(), ada, people);
      const list = await openList();
      await waitFor(() => expect(list.getByRole("listitem", { name: "3. Build" })).toHaveTextContent("builder"));
      expect(list.getByRole("listitem", { name: "4. Review" })).toHaveTextContent("ada");
      expect(list.getByRole("listitem", { name: "2. Plan" })).toHaveTextContent("Owner takes it");
      expect(list.getByRole("listitem", { name: "1. Backlog" })).not.toHaveTextContent("Owner takes it");
      const takers = within(screen.getByRole("list", { name: "Members with engineer" }));
      expect(takers.getByRole("link", { name: "builder" })).toHaveAttribute("href", "/settings/organisation/agents/builder");
      expect(takers.getByRole("button", { name: "Remove builder" })).toBeInTheDocument();
      expect(screen.queryByText(/happen at once/)).toBeNull();
      await pick("2. Plan");
      expect(panel("Step 2: Plan").getByText("Nobody")).toBeInTheDocument();
      expect(panel("Step 2: Plan").getByRole("button", { name: "Add a Member" })).toBeInTheDocument();
    });

    it("removes a Member into the draft: asked first when it reaches past this Step, listed, undone, and sent on Save", async () => {
      const { api, puts } = serve(workflow(), ada, people);
      const list = await openList();
      await userEvent.click(await screen.findByRole("button", { name: "Remove builder" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Remove builder from engineer?" }));
      expect(dialog.getByText("builder also takes engineer in Ops.")).toBeInTheDocument();
      await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
      expect(header()).toHaveTextContent(/^Editing$/);
      await userEvent.click(screen.getByRole("button", { name: "Remove builder" }));
      await userEvent.click(within(await screen.findByRole("dialog", { name: "Remove builder from engineer?" })).getByRole("button", { name: "Remove" }));
      expect(panel("Step 3: Build").getByText("Nobody")).toBeInTheDocument();
      expect(list.getByRole("listitem", { name: "3. Build" })).toHaveTextContent("Owner takes it");
      expect(header()).toHaveTextContent("1 change");
      expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
      await userEvent.click(screen.getByRole("button", { name: "Editing · 1 change: list them" }));
      const changes = within(await screen.findByRole("list", { name: "Changes" }));
      expect(changes.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Removedbuilder from engineer"]);
      await userEvent.keyboard("{Escape}");
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
      expect(await within(screen.getByRole("list", { name: "Members with engineer" })).findByText("builder")).toBeInTheDocument();
      expect(header()).toHaveTextContent(/^Editing$/);
      await userEvent.click(screen.getByRole("button", { name: "Remove builder" }));
      await userEvent.click(within(await screen.findByRole("dialog", { name: "Remove builder from engineer?" })).getByRole("button", { name: "Remove" }));
      await save();
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(puts[0].revokes).toEqual([{ member: "m-builder", skill: engineer.id }]);
      expect(puts[0].grants).toBeUndefined();
      expect(api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /v1/projects/WEB/workflow"]);
    });

    it("removes at once, unasked, when it reaches only this Step", async () => {
      const { puts } = serve(workflow(), ada, people);
      await openList();
      await pick("4. Review");
      await userEvent.click(await screen.findByRole("button", { name: "Remove ada" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(panel("Step 4: Review").getByText("Nobody")).toBeInTheDocument();
      await save();
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(puts[0].revokes).toEqual([{ member: "m-ada", skill: review.id }]);
    });

    it("asks before taking skill-review, which is taken across the Organisation", async () => {
      serve(workflow(), ada, people);
      await openList();
      await pick("6. Skill review");
      await userEvent.click(await screen.findByRole("button", { name: "Remove ada" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Remove ada from skill-review?" }));
      expect(dialog.getByText("ada also takes skill-review in Ops.")).toBeInTheDocument();
    });

    it("adds a Member into the draft from a list grouped in and out of the Project; one from outside joins it on Save", async () => {
      const { api, puts } = serve(workflow(), ada, people);
      const list = await openList();
      await userEvent.click(await screen.findByRole("button", { name: "Add a Member" }));
      expect(await screen.findByRole("option", { name: /^ada/ })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /^builder/ })).toBeNull();
      expect(screen.getByText("In Web")).toBeInTheDocument();
      expect(screen.getByText("Not in Web")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("option", { name: /^bob/ }));
      expect(within(screen.getByRole("list", { name: "Members with engineer" })).getByText("bob")).toBeInTheDocument();
      expect(list.getByRole("listitem", { name: "3. Build" })).toHaveTextContent("+1");
      expect(header()).toHaveTextContent("1 change");
      await userEvent.click(screen.getByRole("button", { name: "Editing · 1 change: list them" }));
      const changes = within(await screen.findByRole("list", { name: "Changes" }));
      expect(changes.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Addedbob to engineer, joins Web"]);
      await userEvent.keyboard("{Escape}");
      // Removing one added in the draft takes back the add, unasked.
      await userEvent.click(screen.getByRole("button", { name: "Remove bob" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(header()).toHaveTextContent(/^Editing$/);
      await userEvent.click(screen.getByRole("button", { name: "Add a Member" }));
      await userEvent.click(await screen.findByRole("option", { name: /^bob/ }));
      expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
      await save();
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(puts[0].joins).toEqual(["m-bob"]);
      expect(puts[0].grants).toEqual([{ member: "m-bob", skill: engineer.id }]);
    });

    it("creates an agent for the Step at once and shows its token once, with how it runs", async () => {
      const made = { ...builder, id: "m-new", name: "builder-2" };
      const { api, puts } = serve(workflow(), ada, {
        ...people,
        "POST /v1/members": made,
        "PUT /v1/projects/:project/members/:member": undefined,
        "PUT /v1/members/:member/skills/:skill": undefined,
        "PATCH /v1/members/:member/agent": made,
        "POST /v1/members/:member/tokens": { token: { id: "t1", member_id: "m-new", name: "default", created_at: "" }, secret: "dk_secret" },
      });
      await openList();
      await userEvent.click(screen.getByRole("button", { name: "New agent" }));
      const dialog = within(await screen.findByRole("dialog", { name: "New agent" }));
      expect(dialog.getByText("An agent Member of Web with engineer.")).toBeInTheDocument();
      await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "builder-2");
      await userEvent.click(dialog.getByRole("button", { name: "Create agent" }));
      expect(await screen.findByRole("textbox", { name: "Secret of builder-2's token" })).toHaveValue("dk_secret");
      expect(screen.getByText("The Runner starts its Shifts on this Install, on claude-sonnet-5-5.")).toBeInTheDocument();
      const writes = api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
      expect(writes).toEqual([
        "POST /v1/members",
        "PUT /v1/projects/WEB/members/m-new",
        `PUT /v1/members/m-new/skills/${engineer.id}`,
        "POST /v1/members/m-new/tokens",
        "PATCH /v1/members/m-new/agent",
      ]);
      expect(puts).toHaveLength(0);
    });

    it("gives Members a Skill created on Save, in the same PUT, and none to a hold", async () => {
      const { puts } = serve(workflow(), ada, people);
      await openList();
      await pick("1. Backlog");
      expect(screen.queryByRole("button", { name: "Add a Member" })).toBeNull();
      await pick("4. Review");
      await userEvent.click(screen.getByRole("combobox", { name: "Skill of Review" }));
      await userEvent.type(await screen.findByPlaceholderText("Find or name a Skill"), "security");
      await userEvent.click(await screen.findByRole("option", { name: /New Skill “security”/ }));
      const dialog = within(await screen.findByRole("dialog", { name: "New Skill “security”" }));
      await userEvent.type(dialog.getByRole("textbox", { name: "Text" }), "x");
      await userEvent.click(dialog.getByRole("button", { name: "Use this Skill" }));
      expect(panel("Step 4: Review").getByText("Nobody")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New agent" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Add a Member" }));
      await userEvent.click(await screen.findByRole("option", { name: /^ada/ }));
      await save();
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(puts[0].skills).toEqual([{ name: "security", body: "x" }]);
      expect(puts[0].grants).toEqual([{ member: "m-ada", skill: "security" }]);
    });
  });
});

describe("Settings › Workflow, its Workflows", () => {
  const five = (extra: Parameters<typeof workflowsFixture>[1] = {}) => workflowsFixture(web, extra);
  const withSkills = { "GET /v1/skills": { items: workflowsSkills } };
  const rail = () => within(screen.getByRole("list", { name: "Workflows" }));
  const segments = () => rail().getAllByRole("listitem").map((li) => li.getAttribute("aria-label"));
  const rows = () =>
    within(screen.getByRole("list", { name: "Steps" }))
      .queryAllByRole("listitem")
      .map((li) => li.getAttribute("aria-label"));
  const changeList = async () => {
    await userEvent.click(screen.getByRole("button", { name: /^Editing · \d+ changes?: list them$/ }));
    return within(await screen.findByRole("list", { name: "Changes" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  };

  it("adds a Workflow from the rail, named in place, and saves it whole with its Step naming it", async () => {
    const { puts, current } = serve();
    await openList("/settings/projects/WEB/workflows");
    expect(segments()).toEqual(["Work"]);
    expect(rail().getByRole("button", { name: "Work" })).toHaveAttribute("aria-current", "true");
    await userEvent.click(screen.getByRole("button", { name: "Add a Workflow" }));
    const name = screen.getByRole("textbox", { name: "Name of the Workflow" });
    expect(name).toHaveValue("Workflow 2");
    expect(name).toHaveFocus();
    await userEvent.clear(name);
    await userEvent.type(name, "Support{Enter}");
    expect(segments()).toEqual(["Work", "Support"]);
    expect(rail().getByRole("button", { name: "Support" })).toHaveAttribute("aria-current", "true");
    expect(rows()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Add a Step at the end of the line" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name of Step 1" }), "Help");
    expect(header()).toHaveTextContent("2 changes");
    expect(await changeList()).toEqual(["Workflow addedSupport", "AddedHelp"]);
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].workflows).toEqual([
      { id: "wf-work", name: "Work", position: 1 },
      { name: "Support", position: 2 },
    ]);
    expect(puts[0].steps.at(-1)).toEqual({ workflow: "Support", name: "Help", position: 1 });
    // The record /v1 makes of it: the new Workflow has an id, and its Step is in it.
    const made = current().workflows.find((w) => w.name === "Support")!;
    expect(made).toMatchObject({ position: 2 });
    expect(current().steps.find((st) => st.name === "Help")).toMatchObject({ workflow_id: made.id, position: 1 });
    // The live page opens on the Workflow just saved.
    expect(localStorage.getItem("darkory.workflow.WEB")).toBe(made.id);
  });

  it("edits one Workflow at a time: the rail picks it, the list holds its Steps, an outcome's target groups the others", async () => {
    serve(five(), ada, withSkills);
    await openList(`/settings/projects/WEB/workflows/${wfId.bugs}`);
    expect(segments()).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
    expect(rows()).toEqual(["1. Investigate", "2. Fix", "3. Review", "4. Verify"]);
    await userEvent.click(rail().getByRole("button", { name: "Triage" }));
    expect(rows()).toEqual(["1. Triage"]);
    await pick("1. Triage");
    const target = screen.getByRole("combobox", { name: "Where bug out of Triage leads" });
    expect(target).toHaveTextContent("Investigate");
    await userEvent.click(target);
    const groups = within(await screen.findByRole("listbox")).getAllByRole("group");
    expect(groups.map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["Bugs", "Features", "Prototypes", "Support"]);
    expect(screen.getByRole("option", { name: "Done" })).toBeInTheDocument();
  });

  it("offers an outcome's targets with the Step's own Workflow first, then the others in order", async () => {
    serve(five(), ada, withSkills);
    await openList(`/settings/projects/WEB/workflows/${wfId.bugs}?step=${wfStep.fix}`);
    await userEvent.click(screen.getByRole("combobox", { name: "Where ready out of Fix leads" }));
    const groups = within(await screen.findByRole("listbox")).getAllByRole("group");
    expect(groups.map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["Bugs", "Triage", "Features", "Prototypes", "Support"]);
  });

  it("shows no rail to a Member who is not an admin while the Project has one Workflow", async () => {
    serve(workflow(), bob);
    await openList("/settings/projects/WEB/workflows");
    expect(screen.queryByRole("list", { name: "Workflows" })).toBeNull();
  });

  it("is answered as /v1 answers: a Step naming no Workflow of the body is refused, outcomes named in any case", () => {
    const body = toBody(workflow());
    expect(answer(workflow(), { ...body, steps: body.steps.map((st, i) => (i === 0 ? { ...st, workflow: "Nowhere" } : st)) })).toBeInstanceOf(Response);
    const made = answer(workflow(), { ...body, connectors: [...body.connectors, { from: "BUILD", name: "later", position: 9 }] }) as Workflows;
    expect(made.connectors.find((c) => c.name === "later")?.from_step_id).toBe(step.build);
  });

  it("reorders the Workflows with ← and →, and with the arrow keys: one change, and where New Tasks start", async () => {
    serve(five(), ada, withSkills);
    await openList(`/settings/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(screen.getByRole("button", { name: "Move Bugs left" }));
    expect(segments()).toEqual(["Bugs", "Triage", "Features", "Prototypes", "Support"]);
    expect(header()).toHaveTextContent("1 change");
    expect(screen.getByRole("button", { name: "Move Bugs left" })).toBeDisabled();
    expect(await changeList()).toEqual(["Workflows reorderedBugs, Triage, Features, Prototypes, Support"]);
    expect(screen.getByText(/New Tasks start at Investigate\. Undo: ⌘Z/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    fireEvent.keyDown(rail().getByRole("button", { name: "Bugs" }), { key: "ArrowRight" });
    expect(segments()).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
    expect(header()).toHaveTextContent(/^Editing$/);
  });

  it("renames the picked Workflow with its pencil", async () => {
    const { puts } = serve(five(), ada, withSkills);
    await openList(`/settings/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(screen.getByRole("button", { name: "Rename Bugs" }));
    const name = screen.getByRole("textbox", { name: "Name of the Workflow" });
    expect(name).toHaveFocus();
    await userEvent.clear(name);
    await userEvent.type(name, "Defects{Enter}");
    expect(segments()).toContain("Defects");
    expect(await changeList()).toEqual(["Workflow renamedBugs → Defects"]);
    await userEvent.keyboard("{Escape}");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].workflows[1]).toEqual({ id: wfId.bugs, name: "Defects", position: 2 });
  });

  it("cancels a rename with Escape, back to the name it had, and keeps one typed when the field is left", async () => {
    serve(five(), ada, withSkills);
    await openList(`/settings/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(screen.getByRole("button", { name: "Rename Bugs" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Name of the Workflow" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name of the Workflow" }), "Defects{Escape}");
    expect(screen.queryByRole("textbox", { name: "Name of the Workflow" })).toBeNull();
    expect(segments()).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
    expect(header()).toHaveTextContent(/^Editing$/);
    // Leaving the field keeps what was typed.
    await userEvent.click(screen.getByRole("button", { name: "Rename Bugs" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Name of the Workflow" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name of the Workflow" }), "Defects");
    await userEvent.click(rail().getByRole("button", { name: "Triage" }));
    expect(screen.queryByRole("textbox", { name: "Name of the Workflow" })).toBeNull();
    expect(segments()).toEqual(["Triage", "Defects", "Features", "Prototypes", "Support"]);
    expect(await changeList()).toEqual(["Workflow renamedBugs → Defects"]);
  });

  it("cancels the name of a Workflow just added with Escape: it stays, named Workflow N", async () => {
    serve(five(), ada, withSkills);
    await openList(`/settings/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(screen.getByRole("button", { name: "Add a Workflow" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Name of the Workflow" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name of the Workflow" }), "Ops{Escape}");
    expect(segments()).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support", "Workflow 2"]);
    expect(await changeList()).toEqual(["Workflow addedWorkflow 2"]);
  });

  it("deletes a Workflow: its Tasks need a Step of another, the outcome into it is removed unless led on", async () => {
    const record = five({ fix: { tasks: 1 } });
    const { puts } = serve(record, ada, withSkills);
    await openList(`/settings/projects/WEB/workflows/${wfId.bugs}`);
    await userEvent.click(screen.getByRole("button", { name: "Delete Bugs" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Bugs" }));
    expect(dialog.getByText("The Steps of Bugs go with it: Investigate, Fix, Review, Verify.")).toBeInTheDocument();
    expect(dialog.getByText("1 Task at Fix")).toBeInTheDocument();
    expect(dialog.getByRole("combobox", { name: "Where bug out of Triage leads instead" })).toHaveTextContent("Remove this outcome");
    expect(dialog.getByRole("button", { name: "Delete Bugs" })).toBeDisabled();
    await userEvent.click(dialog.getByRole("combobox", { name: "Step that receives the Tasks at Fix" }));
    await userEvent.click(await screen.findByRole("option", { name: "Triage" }));
    // The Workflow, its four Steps and the outcome into it from Triage.
    expect(dialog.getByText("6 changes")).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Delete Bugs" }));
    expect(header()).toHaveTextContent("6 changes");
    expect(segments()).toEqual(["Triage", "Features", "Prototypes", "Support"]);
    // The rail moves to the Workflow after it.
    expect(rail().getByRole("button", { name: "Features" })).toHaveAttribute("aria-current", "true");
    expect(rows()).toEqual(["1. Build", "2. Code review", "3. QA", "4. Release"]);
    const listed = await changeList();
    expect(listed).toHaveLength(6);
    expect(listed[0]).toBe("Workflow deletedBugs");
    expect(listed).toContain("RemovedTriage · bug → Investigate");
    await userEvent.keyboard("{Escape}");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].moves).toEqual({ [wfStep.fix]: wfStep.triage });
    expect(puts[0].workflows.map((w) => w.name)).toEqual(["Triage", "Features", "Prototypes", "Support"]);
    expect(puts[0].connectors.some((c) => c.from === wfStep.triage && c.name === "bug")).toBe(false);
  });

  it("keeps the last Workflow", async () => {
    serve();
    await openList("/settings/projects/WEB/workflows");
    await userEvent.click(screen.getByRole("button", { name: "Delete Work" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Work" }));
    expect(dialog.getByText("A Project keeps one Workflow at least.")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Delete Work" })).toBeDisabled();
  });

  it("moves a Step into another Workflow from its panel, and the panel follows it", async () => {
    serve(five(), ada, withSkills);
    await openList(`/settings/projects/WEB/workflows/${wfId.bugs}?step=${wfStep.fix}`);
    await userEvent.click(screen.getByRole("combobox", { name: "Workflow of Fix" }));
    await userEvent.click(await screen.findByRole("option", { name: "Support" }));
    expect(rail().getByRole("button", { name: "Support" })).toHaveAttribute("aria-current", "true");
    expect(rows()).toEqual(["1. Support", "2. Awaiting customer", "3. Ops", "4. Approve", "5. Fix"]);
    expect(screen.getByRole("textbox", { name: "Name of Step 5" })).toHaveValue("Fix");
    expect(await changeList()).toEqual(["MovedFix to Support"]);
  });

  it("opens on the Workflow of the Step the address names, and a Member who is not an admin only picks", async () => {
    serve(five(), bob, withSkills);
    await openList(`/settings/projects/WEB/workflows?step=${wfStep.sketch}`);
    expect(rail().getByRole("button", { name: "Prototypes" })).toHaveAttribute("aria-current", "true");
    expect(rows()).toEqual(["1. Sketch", "2. Prototype review"]);
    expect(screen.queryByRole("button", { name: "Add a Workflow" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rename / })).toBeNull();
    await userEvent.click(rail().getByRole("button", { name: "Support" }));
    expect(rows()).toEqual(["1. Support", "2. Awaiting customer", "3. Ops", "4. Approve"]);
  });
});
