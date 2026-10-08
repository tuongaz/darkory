import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Schemas, Workflow } from "@/api/client";
import { mockApi, refuse, type Call } from "@/test/api";
import { ada, bob, builder, engineer, memberDetail, review, skillReview, skills, step, task, web, workflow } from "@/test/fixtures";
import { signedIn } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { toBody } from "./bind";
import { addOutcome, deleteStep, fromRecord, insertStep, moveStepTo, renameOutcome, renameStep, reorderStep, setSkill, setTarget, removeOutcome, groupsOf } from "./edit/draft";

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
    "GET /v1/projects/:project/workflow": () => current,
    "PUT /v1/projects/:project/workflow": ({ body }: Call) => {
      puts.push(body as Body);
      current = answer(current, body as Body);
      return current;
    },
    ...extra,
  });
  return { api, puts, current: () => current };
}

// React Flow draws a node hidden until it has measured it, which jsdom never does.
const stepNode = (name: string) => screen.getAllByRole("group", { hidden: true }).find((n) => n.getAttribute("aria-label")?.startsWith(`${name}:`))!;

describe("the live Workflow", () => {
  it("draws the record: each Step's counts and takers, a working taker ringed", async () => {
    const claim = { id: "c1", task_id: "k-1", holder_id: builder.id, session_id: "s", started_at: "2026-10-08T09:00:00Z" };
    serve(workflow(web, { build: { tasks: 2, working: 1 } }), ada, { "GET /v1/tasks": { items: [task(1, { claim }), task(2)] } });
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(stepNode("Build")).toHaveAttribute("aria-label", "Build: Skill engineer; 1 waiting, 1 working; taken by builder (agent)"));
    expect(stepNode("Plan").getAttribute("aria-label")).toContain("no Member has breakdown");
    expect(screen.getAllByRole("img", { name: "builder (agent), working", hidden: true })[0]).toHaveAttribute("data-working", "running");
    expect(screen.queryByRole("button", { name: "Tidy up", hidden: true })).toBeNull();
  });

  it("opens a Step's peek from the canvas: its Tasks, takers, median and outcomes, and Edit in Settings for an admin", async () => {
    serve(workflow(web, { build: { tasks: 1, median_ms: 2 * 3_600_000 } }), ada, { "GET /v1/tasks": { items: [task(7, { title: "Store names as NFC" })] } });
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(stepNode("Build")).toBeDefined());
    act(() => stepNode("Build").focus());
    fireEvent.keyDown(stepNode("Build"), { key: "Enter" });
    const peek = within(await screen.findByRole("dialog", { name: "Step Build" }));
    expect(peek.getByText("2 h")).toBeInTheDocument();
    expect(peek.getByRole("list", { name: "Takers at Build" })).toHaveTextContent("builder");
    expect(peek.getByRole("list", { name: "Outcomes out of Build" })).toHaveTextContent("passReview");
    const row = await peek.findByRole("link", { name: /^WEB-7 Store names as NFC/ });
    // Opening a Task closes the Step's peek: the Task's takes its place.
    expect(row.getAttribute("href")).toBe("/projects/WEB/workflow?task=WEB-7");
    expect(peek.getByRole("link", { name: "Edit in Settings" })).toHaveAttribute("href", `/settings/projects/WEB/workflow?step=${step.build}`);
  });

  it("says in the live canvas and a Step's peek when the Step has no way out", async () => {
    const record = workflow();
    record.connectors = record.connectors.filter((c) => c.from_step_id !== step.build);
    serve(record);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(stepNode("Build")).toBeDefined());
    expect(within(stepNode("Build")).getByText("No way out")).toBeInTheDocument();
    act(() => stepNode("Build").focus());
    fireEvent.keyDown(stepNode("Build"), { key: "Enter" });
    const peek = within(await screen.findByRole("dialog", { name: "Step Build" }));
    expect(peek.getByText("No way out: Tasks here can only be moved by hand.")).toBeInTheDocument();
  });

  it("asks the Tasks at the Step by its id, and offers a Member who is not an admin no Edit", async () => {
    const { api } = serve(workflow(), bob);
    renderApp(`/projects/WEB/workflow?view=text`);
    await userEvent.click(await screen.findByRole("button", { name: "Open Review" }));
    const peek = within(await screen.findByRole("dialog", { name: "Step Review" }));
    await peek.findByText("No Task is at Review.");
    expect(api.calls.some((c) => c.path === "/v1/tasks" && c.query.get("step") === step.review && c.query.get("state") === "open")).toBe(true);
    expect(peek.queryByRole("link", { name: "Edit in Settings" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Edit/ })).toBeNull();
  });

  it("lists the Steps and their Connectors in the text view", async () => {
    serve();
    renderApp("/projects/WEB/workflow?view=text");
    const steps = await screen.findByRole("list", { name: "Steps" });
    expect(within(steps).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Open Backlog",
      "Open Plan",
      "Open Build",
      "Open Review",
      "Open Retro",
      "Open Skill review",
    ]);
    expect(screen.getByRole("list", { name: "Connectors out of Review" })).toHaveTextContent(/pass.*Done.*needs changes.*Build/);
    expect(screen.getByText("No Member has breakdown", { exact: false })).toBeInTheDocument();
  });
});

const skillMap = new Map(skills.map((s) => [s.id, s]));
const groups = groupsOf(workflow(), skillMap);

/** Settings › Workflow open on the list, once WEB's Workflow is drawn. */
async function openList(path = "/settings/projects/WEB/workflow") {
  renderApp(path);
  await screen.findByRole("list", { name: "Steps" });
  return within(screen.getByRole("list", { name: "Steps" }));
}
const save = () => userEvent.click(screen.getByRole("button", { name: "Save" }));
const header = () => screen.getByRole("status", { name: "Editing" });

describe("Settings › Workflow", () => {
  it("shows a Member who is not an admin the list read-only, saying only an admin changes it", async () => {
    serve(workflow(), bob);
    const list = await openList();
    expect(screen.getByText(/Only an admin changes Web's Workflow/)).toBeInTheDocument();
    expect(list.queryAllByRole("textbox")).toHaveLength(0);
    expect(list.queryByRole("button", { name: /Add a Step/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(list.getByRole("listitem", { name: "3. Build" })).toHaveTextContent(/Build.*engineer.*pass.*Review/);
  });

  it("lists the Steps in order with the Steps after a Parent in their own group, and the line above", async () => {
    serve();
    const list = await openList();
    expect(list.getAllByRole("listitem").map((r) => r.getAttribute("aria-label"))).toEqual(["1. Backlog", "2. Plan", "3. Build", "4. Review", "5. Retro", "6. Skill review"]);
    expect(list.getByText("After a Parent")).toBeInTheDocument();
    expect(within(list.getByRole("listitem", { name: "1. Backlog" })).getByText("moved by hand")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^The line: Backlog · Plan · Build → Review → Done$/ })).toBeInTheDocument();
    expect(screen.getByText(/After a Parent ·/)).toHaveTextContent("After a Parent · Retro → Skill review");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("renames a Step: nothing sent until Save, then one PUT of the whole Workflow", async () => {
    const { api, puts } = serve();
    await openList();
    const name = screen.getByRole("textbox", { name: "Name of Step 3" });
    await userEvent.clear(name);
    await userEvent.type(name, "Make");
    expect(header()).toHaveTextContent("Editing · 1 change");
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(renameStep(fromRecord(workflow()), step.build, "Make").wf));
    // Saved: the live Workflow.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
  });

  it("changes a Step's Skill, and makes a hold of another", async () => {
    const { puts } = serve();
    await openList();
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Build" }));
    await userEvent.click(await screen.findByRole("option", { name: /^review/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Plan" }));
    await userEvent.click(await screen.findByRole("option", { name: "None: a hold" }));
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
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Review" }));
    await userEvent.type(await screen.findByPlaceholderText("Find or name a Skill"), "security");
    await userEvent.click(await screen.findByRole("option", { name: /New Skill “security”/ }));
    const dialog = within(await screen.findByRole("dialog", { name: "New Skill “security”" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Text" }), "Look for holes.");
    await userEvent.click(dialog.getByRole("button", { name: "Use this Skill" }));
    expect(screen.getByRole("combobox", { name: "Skill of Review" })).toHaveTextContent("security");
    // Nothing is created before Save.
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

  it("inserts a Step after Review: Review's first outcome now leads into it, struck with undo, and it leads on to Done", async () => {
    const { puts } = serve();
    const list = await openList();
    await userEvent.click(list.getByRole("button", { name: "Add a Step after Review" }));
    const name = screen.getByRole("textbox", { name: "Name of Step 5" });
    expect(name).toHaveFocus();
    await userEvent.type(name, "Security review");
    expect(header()).toHaveTextContent("2 changes");
    const reviewRow = within(list.getByRole("listitem", { name: "4. Review" }));
    expect(reviewRow.getByRole("combobox", { name: "Where pass out of Review leads" })).toHaveTextContent("Security review");
    expect(reviewRow.getByText("Done", { selector: "s" })).toBeInTheDocument();
    expect(within(list.getByRole("listitem", { name: "5. Security review" })).getByRole("combobox", { name: "Where pass out of Security review leads" })).toHaveTextContent("Done");
    expect(screen.getByRole("img", { name: /Review → Security review → Done/ })).toBeInTheDocument();
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const r = insertStep(fromRecord(workflow()), step.review, groups);
    const expected = toBody(renameStep(r.draft, r.id, "Security review").wf);
    expect(puts[0]).toEqual(expected);
    expect(puts[0].connectors.find((c) => c.from === step.review && c.name === "pass")).toMatchObject({ to: "Security review" });
    expect(puts[0].connectors.find((c) => c.from === "Security review")).toEqual({ from: "Security review", name: "pass", position: 1 });
  });

  it("puts a re-pointed outcome back with its undo", async () => {
    serve();
    const list = await openList();
    await userEvent.click(list.getByRole("button", { name: "Add a Step after Review" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name of Step 5" }), "Security review");
    await userEvent.click(list.getByRole("button", { name: "Undo: lead pass back to Done" }));
    expect(within(list.getByRole("listitem", { name: "4. Review" })).getByRole("combobox", { name: "Where pass out of Review leads" })).toHaveTextContent("Done");
    expect(header()).toHaveTextContent("1 change");
  });

  it("adds an outcome, names it and picks its Step; removes another", async () => {
    const { puts } = serve();
    const list = await openList();
    await userEvent.click(list.getByRole("button", { name: "Add an outcome out of Build" }));
    const outcome = screen.getAllByRole("textbox", { name: "Outcome out of Build" }).at(-1)!;
    expect(outcome).toHaveFocus();
    await userEvent.type(outcome, "fail");
    await userEvent.click(screen.getByRole("combobox", { name: "Where fail out of Build leads" }));
    await userEvent.click(await screen.findByRole("option", { name: "Plan" }));
    await userEvent.click(list.getByRole("button", { name: "Remove needs changes out of Review" }));
    expect(header()).toHaveTextContent("2 changes");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const a = addOutcome(fromRecord(workflow()), step.build);
    let d = setTarget(renameOutcome(a.draft, a.id, "fail"), a.id, step.plan);
    d = removeOutcome(d, `${step.review}-c4`);
    expect(puts[0]).toEqual(toBody(d.wf));
    expect(puts[0].connectors.filter((c) => c.from === step.build)).toEqual([
      { id: `${step.build}-c2`, from: step.build, to: step.review, name: "pass", position: 1 },
      { from: step.build, to: step.plan, name: "fail", position: 2 },
    ]);
  });

  it("reorders Steps within their group with Alt+↑ and Alt+↓", async () => {
    const { puts } = serve();
    const list = await openList();
    const plan = screen.getByRole("textbox", { name: "Name of Step 2" });
    act(() => plan.focus());
    fireEvent.keyDown(plan, { key: "ArrowDown", altKey: true });
    expect(list.getAllByRole("listitem").map((r) => r.getAttribute("aria-label")).slice(0, 4)).toEqual(["1. Backlog", "2. Build", "3. Plan", "4. Review"]);
    expect(plan).toHaveFocus();
    // Review is last of the main Steps: it does not cross into the Steps after a Parent.
    const reviewName = screen.getByRole("textbox", { name: "Name of Step 4" });
    fireEvent.keyDown(reviewName, { key: "ArrowDown", altKey: true });
    expect(list.getAllByRole("listitem")[3]).toHaveAttribute("aria-label", "4. Review");
    expect(header()).toHaveTextContent("1 change");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(reorderStep(fromRecord(workflow()), step.plan, 1, groups).wf));
    expect(puts[0].steps.map((s) => s.name)).toEqual(["Backlog", "Build", "Plan", "Review", "Retro", "Skill review"]);
    expect(toBody(moveStepTo(fromRecord(workflow()), step.plan, step.build).wf)).toEqual(puts[0]);
  });

  it("asks where a Step's Tasks go before deleting it, re-points the outcome into it, and sends the moves", async () => {
    const record = workflow(web, { review: { tasks: 2 } });
    const { puts } = serve(record);
    const list = await openList();
    await userEvent.click(list.getByRole("button", { name: "Delete Review" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Review" }));
    expect(dialog.getByText(/2 Tasks are at Review/)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Delete Review" })).toBeDisabled();
    await userEvent.click(dialog.getByRole("combobox", { name: "Step that receives the Tasks at Review" }));
    await userEvent.click(await screen.findByRole("option", { name: "Build" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete Review" }));
    expect(list.queryByRole("listitem", { name: /Review$/ })).toBeNull();
    // Build's pass led into Review: it now leads where Review's did.
    expect(within(list.getByRole("listitem", { name: "3. Build" })).getByRole("combobox", { name: "Where pass out of Build leads" })).toHaveTextContent("Done");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const d = deleteStep(fromRecord(record), step.review, step.build);
    expect(puts[0]).toEqual(toBody(d.wf, d.moves));
    expect(puts[0].moves).toEqual({ [step.review]: step.build });
  });

  it("warns when deleting a Step leaves another with no way out, and deletes it", async () => {
    const record = workflow();
    record.connectors = record.connectors.filter((c) => c.from_step_id !== step.review);
    const { puts } = serve(record);
    const list = await openList();
    expect(within(list.getByRole("listitem", { name: "4. Review" })).getByText("No way out: Tasks here can only be moved by hand.")).toBeInTheDocument();
    await userEvent.click(list.getByRole("button", { name: "Delete Review" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Review" }));
    expect(dialog.queryByRole("combobox")).not.toBeInTheDocument();
    expect(dialog.getByRole("note")).toHaveTextContent("Build leads out only into Review: without it, it has no way out, and its Tasks can only be moved by hand.");
    await userEvent.click(dialog.getByRole("button", { name: "Delete Review" }));
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(deleteStep(fromRecord(record), step.review).wf));
    expect(puts[0].connectors.some((c) => c.from === step.build)).toBe(false);
  });

  it("deletes a Step that strands nothing and holds no Task at once", async () => {
    serve();
    const list = await openList();
    await userEvent.click(list.getByRole("button", { name: "Delete Skill review" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(list.queryByRole("listitem", { name: "6. Skill review" })).toBeNull();
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
    await waitFor(() => expect(screen.queryByRole("list", { name: "Steps" })?.querySelector("input")).toBeFalsy());
  });

  describe("who takes a Step's Tasks", () => {
    // builder holds engineer, ada review and skill-review; both are in WEB.
    const people = {
      "GET /v1/projects/:project": { project: web, members: [ada, builder] },
      "GET /v1/members/:member": ({ params }: Call & { params: Record<string, string> }) => {
        const m = [ada, bob, builder].find((x) => x.id === params.member || x.name === params.member)!;
        return memberDetail(m, { skills: m === builder ? [engineer] : m === ada ? [review, skillReview] : [] });
      },
    };

    it("marks each Step with the Members holding its Skill, and warns when none does", async () => {
      serve(workflow(), ada, people);
      const list = await openList();
      expect(await within(list.getByRole("listitem", { name: "3. Build" })).findByRole("img", { name: "Members with engineer: builder" })).toBeInTheDocument();
      expect(within(list.getByRole("listitem", { name: "4. Review" })).getByRole("img", { name: "Members with review: ada" })).toBeInTheDocument();
      expect(within(list.getByRole("listitem", { name: "2. Plan" })).getByText("No Member has it")).toBeInTheDocument();
      expect(within(list.getByRole("listitem", { name: "1. Backlog" })).queryByText("No Member has it")).toBeNull();
    });

    it("adds a Member with the Skill at once, joining the Project, and sends no Workflow", async () => {
      const { api, puts } = serve(workflow(), ada, {
        ...people,
        "PUT /v1/projects/:project/members/:member": undefined,
        "PUT /v1/members/:member/skills/:skill": undefined,
      });
      await openList();
      await userEvent.click(screen.getByRole("button", { name: "Who takes Build's Tasks" }));
      expect(await screen.findByText(/this happens now/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("menuitem", { name: "Add Member…" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Add a Member with engineer" }));
      expect(dialog.queryByRole("option", { name: /^builder:/ })).toBeNull();
      await userEvent.click(dialog.getByRole("option", { name: "bob: Joins Web, gets engineer" }));
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
      await userEvent.click(screen.getByRole("button", { name: "Who takes Build's Tasks" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Create an agent…" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Create an agent" }));
      expect(dialog.getByText(/This happens now/)).toBeInTheDocument();
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
      expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/members")!.body).toEqual({ name: "builder-2", kind: "agent" });
      expect(api.calls.find((c) => c.method === "PATCH")!.body).toEqual({ model: "claude-sonnet-5-5" });
      expect(puts).toHaveLength(0);
    });

    it("offers no Member to a Skill created on Save, and none to a hold", async () => {
      serve(workflow(), ada, people);
      const list = await openList();
      expect(within(list.getByRole("listitem", { name: "1. Backlog" })).queryByRole("button", { name: /^Who takes/ })).toBeNull();
      await userEvent.click(screen.getByRole("combobox", { name: "Skill of Review" }));
      await userEvent.type(await screen.findByPlaceholderText("Find or name a Skill"), "security");
      await userEvent.click(await screen.findByRole("option", { name: /New Skill “security”/ }));
      const dialog = within(await screen.findByRole("dialog", { name: "New Skill “security”" }));
      await userEvent.type(dialog.getByRole("textbox", { name: "Text" }), "x");
      await userEvent.click(dialog.getByRole("button", { name: "Use this Skill" }));
      expect(within(list.getByRole("listitem", { name: "4. Review" })).getByText("No Member has it")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Who takes Review's Tasks" }));
      expect(await screen.findByText("security is created on Save: add its Members after.")).toBeInTheDocument();
      expect(screen.queryByRole("menuitem")).toBeNull();
    });
  });
});
