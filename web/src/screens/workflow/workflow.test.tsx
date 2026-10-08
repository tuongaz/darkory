import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Schemas, Workflow } from "@/api/client";
import { mockApi, refuse, type Call } from "@/test/api";
import { ada, bob, builder, engineer, memberDetail, ops, review, skillReview, skills, step, web, workflow } from "@/test/fixtures";
import { signedIn } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { toBody } from "./bind";
import { addOutcome, deleteStep, fromRecord, insertStep, makeMain, moveStepTo, renameOutcome, renameStep, reorderStep, setSkill, setTarget, removeOutcome, groupsOf } from "./edit/draft";

type Body = Schemas["SetWorkflowBody"];

/** The record a PUT body makes of `wf`, as /v1 answers: new Steps and Connectors get ids, the facts stay. */
function answer(wf: Workflow, body: Body): Workflow {
  let n = 0;
  const steps = body.steps.map((s) => {
    const was = wf.steps.find((x) => x.id === s.id);
    return {
      id: s.id ?? `st-made-${++n}`,
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
  const ref = (r?: string) => (r === undefined ? undefined : (steps.find((s) => s.id === r || s.name === r)?.id ?? r));
  return {
    project_id: wf.project_id,
    steps,
    connectors: body.connectors.map((c) => ({ id: c.id ?? `c-made-${++n}`, from_step_id: ref(c.from)!, to_step_id: ref(c.to), name: c.name, position: c.position })),
  };
}

/** Signed in as `who`, WEB's Workflow served from `record` and replaced by each PUT, which is recorded. */
function serve(record: Workflow = workflow(), who = ada, extra: Record<string, unknown> = {}) {
  let current = record;
  const puts: Body[] = [];
  const api = mockApi({
    ...signedIn(who),
    "GET /v1/projects/:project/workflow": ({ params }: Call & { params: Record<string, string> }) => (params.project === "WEB" || params.project === web.id ? current : workflow(ops)),
    "PUT /v1/projects/:project/workflow": ({ body }: Call) => {
      puts.push(body as Body);
      current = answer(current, body as Body);
      return current;
    },
    ...extra,
  });
  return { api, puts, current: () => current };
}


const skillMap = new Map(skills.map((s) => [s.id, s]));
const groups = groupsOf(workflow(), skillMap);

/** Settings › Workflow open on the list with Build in the panel (the address names it), once WEB's Workflow is drawn. */
async function openList(path = `/settings/projects/WEB/workflow?step=${step.build}`) {
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

  it("lists the Steps as text in order, the Steps after a Parent in their own group with why, the line above, and none open", async () => {
    serve();
    const list = await openList("/settings/projects/WEB/workflow");
    expect(list.getAllByRole("listitem").map((r) => r.getAttribute("aria-label"))).toEqual(["1. Backlog", "2. Plan", "3. Build", "4. Review", "5. Retro", "6. Skill review"]);
    expect(list.getByText("After a Parent")).toBeInTheDocument();
    expect(list.getByText(/Darkory files Acceptance under a Parent/)).toBeInTheDocument();
    expect(list.getByRole("listitem", { name: "1. Backlog" })).toHaveTextContent(/Backlog.*Hold.*by hand/);
    expect(list.getByRole("listitem", { name: "2. Plan" })).toHaveTextContent("Break down · Subtasks start at Build by default");
    expect(list.getByRole("listitem", { name: "3. Build" })).toHaveTextContent("New Tasks start here");
    expect(list.getByRole("listitem", { name: "6. Skill review" })).toHaveTextContent("Taken by anyone in the Organisation with skill-review");
    expect(list.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getByRole("img", { name: /^The line: Build → Review → Done\. New Tasks start at Build\. Break down: Plan, whose Subtasks start at Build by default\. Hold: Backlog, moved on by hand\.$/ })).toBeInTheDocument();
    // No Step is open until one is picked: the panel says how.
    expect(list.getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "true")).toEqual([]);
    expect(screen.queryByRole("textbox", { name: /^Name of Step/ })).toBeNull();
    expect(screen.getByRole("note", { name: "No Step picked" })).toHaveTextContent("Pick a Step in the list or on the line");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await pick("3. Build");
    expect(screen.getByRole("textbox", { name: "Name of Step 3" })).toHaveValue("Build");
    expect(screen.queryByRole("note", { name: "No Step picked" })).toBeNull();
  });

  it("picks a Step from its row, with ↑ and ↓, and from the address", async () => {
    serve();
    const list = await openList("/settings/projects/WEB/workflow?step=st-review");
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
    expect(screen.getByRole("combobox", { name: "Skill of Plan" })).toHaveTextContent("Hold · pick a Skill");
    expect(panel("Step 2: Plan").getByText("Moved on by hand.")).toBeInTheDocument();
    expect(header()).toHaveTextContent("2 changes");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    let d = setSkill(fromRecord(workflow()), step.build, { id: review.id });
    d = setSkill(d, step.plan, undefined);
    expect(puts[0]).toEqual(toBody(d.wf));
    expect(puts[0].steps.find((s) => s.name === "Plan")!.skill).toBeUndefined();
  });

  it("creates a new generic Skill on Save, before the Workflow, and the Step carries it", async () => {
    const { api, puts } = serve(workflow(), ada, {
      "POST /v1/skills": ({ body }: Call) => ({
        skill: { id: "sk-security", name: (body as { name: string }).name, kind: "generic", builtin: false, current_version: 1, created_at: "2026-10-08T00:00:00Z" },
        current: { skill_id: "sk-security", version: 1, body: "", published_at: "2026-10-08T00:00:00Z" },
      }),
    });
    await openList();
    await pick("4. Review");
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Review" }));
    await userEvent.type(await screen.findByPlaceholderText("Find or name a Skill"), "security");
    await userEvent.click(await screen.findByRole("option", { name: /New Skill “security”/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "New Skill “security”" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Text" }), "Look for holes.");
    await userEvent.click(dialog.getByRole("button", { name: "Use this Skill" }));
    expect(screen.getByRole("combobox", { name: "Skill of Review" })).toHaveTextContent("security");
    expect(panel("Step 4: Review").getByText("security is created on Save: add its Members after.")).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const writes = api.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/skills", "PUT /v1/projects/WEB/workflow"]);
    expect(writes[0].body).toEqual({ name: "security", kind: "generic", body: "Look for holes." });
    expect(puts[0].steps.find((s) => s.name === "Review")!.skill).toBe("sk-security");
  });

  it("creates a new Skill once: a refused Workflow keeps it, and the next Save sends only the Workflow", async () => {
    let refusing = true;
    const { api, puts } = serve(workflow(), ada, {
      "POST /v1/skills": ({ body }: Call) => ({
        skill: { id: "sk-security", name: (body as { name: string }).name, kind: "generic", builtin: false, current_version: 1, created_at: "2026-10-08T00:00:00Z" },
        current: { skill_id: "sk-security", version: 1, body: "", published_at: "2026-10-08T00:00:00Z" },
      }),
    });
    const put = api.routes["PUT /v1/projects/:project/workflow"] as (call: Call) => Workflow;
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
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(puts[0].steps.find((s) => s.name === "Review")!.skill).toBe("sk-security");
  });

  it("adds a Step between two: a hold with no outcome, open with its name in focus; nothing is re-pointed", async () => {
    const { puts } = serve();
    const list = await openList();
    await userEvent.click(list.getByRole("button", { name: "Add a Step after Build" }));
    const name = screen.getByRole("textbox", { name: "Name of Step 4" });
    expect(name).toHaveFocus();
    expect(list.getByRole("button", { name: "4. New Step" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("combobox", { name: "Skill of the new Step" })).toHaveTextContent("Hold · pick a Skill");
    const p = panel("Step 4: New Step");
    expect(p.getByText("New · no Tasks")).toBeInTheDocument();
    expect(p.getByText("Moved on by hand.")).toBeInTheDocument();
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
    expect(dialog.getByRole("note")).toHaveTextContent("Build leads out only into Review");
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
    expect(screen.getByText(/New Tasks will start at Review\. ⌘Z undoes the last change\./)).toBeInTheDocument();
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
      expect(within(screen.getByRole("list", { name: "Members with engineer" })).getByText("builder")).toBeInTheDocument();
      expect(screen.getByText(/1 in Web with engineer · changes here happen at once, not on Save/)).toBeInTheDocument();
      await pick("2. Plan");
      expect(screen.getByText("Nobody in Web has breakdown: each Task's Owner takes it.")).toBeInTheDocument();
    });

    it("takes the Skill away at once, after naming every Step it reaches in every Project", async () => {
      const { api, puts } = serve(workflow(), ada, { ...people, "DELETE /v1/members/:member/skills/:skill": undefined });
      await openList();
      await userEvent.click(await screen.findByRole("button", { name: "Take builder off Build" }));
      expect(await screen.findByRole("menuitem", { name: /^Take engineer from builder…/ })).toHaveTextContent("Also stops Build in Ops · 0 Tasks");
      expect(screen.getByRole("menuitem", { name: /^Remove builder from Web…/ })).toHaveTextContent("Leaves Build · stays in Ops");
      await userEvent.click(screen.getByRole("menuitem", { name: /^Take engineer from builder…/ }));
      const dialog = within(await screen.findByRole("dialog", { name: "Take engineer from builder?" }));
      expect(within(dialog.getByRole("list", { name: "Steps it reaches" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Ops · Build0 Tasks", "Web · Build0 Tasks"]);
      expect(dialog.getByText("Nobody else in Ops or Web takes Build: each Task's Owner takes those Tasks.")).toBeInTheDocument();
      await userEvent.click(dialog.getByRole("button", { name: "Take engineer away" }));
      await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === `/v1/members/m-builder/skills/${engineer.id}`)).toBe(true));
      expect(puts).toHaveLength(0);
      expect(header()).toHaveTextContent(/^Editing$/);
    });

    it("removes a Member from the Project at once, after naming the Steps they leave and where they stay", async () => {
      const { api } = serve(workflow(), ada, { ...people, "DELETE /v1/projects/:project/members/:member": undefined });
      await openList();
      await userEvent.click(await screen.findByRole("button", { name: "Take builder off Build" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: /^Remove builder from Web…/ }));
      const dialog = within(await screen.findByRole("dialog", { name: "Remove builder from Web?" }));
      expect(dialog.getByText("builder stays in Ops.")).toBeInTheDocument();
      await userEvent.click(dialog.getByRole("button", { name: "Remove from Web" }));
      await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/v1/projects/WEB/members/m-builder")).toBe(true));
    });

    it("offers no removal from the Project for skill-review, which is taken across the Organisation", async () => {
      serve(workflow(), ada, people);
      await openList();
      await pick("6. Skill review");
      await userEvent.click(await screen.findByRole("button", { name: "Take ada off Skill review" }));
      expect(await screen.findByRole("menuitem", { name: /^Take skill-review from ada…/ })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /^Remove ada from/ })).toBeNull();
    });

    it("adds a Member at once from a list grouped in and out of the Project, each saying what it does", async () => {
      const { api, puts } = serve(workflow(), ada, {
        ...people,
        "PUT /v1/projects/:project/members/:member": undefined,
        "PUT /v1/members/:member/skills/:skill": undefined,
      });
      await openList();
      await userEvent.click(await screen.findByRole("button", { name: "Add a Member" }));
      expect(await screen.findByRole("option", { name: "ada: Gets engineer" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /^builder:/ })).toBeNull();
      expect(screen.getByText("In Web · without engineer")).toBeInTheDocument();
      expect(screen.getByText("Not in Web")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("option", { name: "bob: Joins Web, gets engineer" }));
      await waitFor(() => expect(api.calls.some((c) => c.method === "PUT" && c.path === `/v1/members/m-bob/skills/${engineer.id}`)).toBe(true));
      expect(api.calls.some((c) => c.method === "PUT" && c.path === "/v1/projects/WEB/members/m-bob")).toBe(true);
      expect(puts).toHaveLength(0);
      expect(header()).toHaveTextContent(/^Editing$/);
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
      await userEvent.click(screen.getByRole("button", { name: "Create an agent" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Create an agent" }));
      expect(dialog.getByText("An agent Member of Web with engineer.")).toBeInTheDocument();
      await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "builder-2");
      await userEvent.click(dialog.getByRole("button", { name: "Create agent" }));
      expect(await screen.findByRole("textbox", { name: "Secret of builder-2's token" })).toHaveValue("dk_secret");
      expect(screen.getByText("The Runner starts its sessions on this Install, on claude-sonnet-5-5.")).toBeInTheDocument();
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

    it("offers no Member to a Skill created on Save, and none to a hold", async () => {
      serve(workflow(), ada, people);
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
      expect(screen.getByText("security is created on Save: add its Members after.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add a Member" })).toBeNull();
    });
  });
});
