import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import type { Workflows } from "@/api/client";
import { mockApi, refuse, type Call } from "@/test/api";
import { answer, type Body } from "@/test/workflowPut";
import { ada, bob, builder, engineer, memberDetail, ops, review, skillReview, skills, step, web, wfId, wfStep, workflow, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import { signedIn } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { LiveActivity } from "@/api/live";
import { Providers, Root } from "@/App";
import { newQueryClient } from "@/queryClient";
import { toBody } from "./bind";
import { addOutcome, deleteStep, fromRecord, insertStep, makeMain, moveStepTo, renameOutcome, renameStep, reorderStep, setSkill, setTarget, removeOutcome, groupsOf } from "./edit/draft";

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

/** The Workflow's editor (the address names it), once WEB's draft is drawn on the line. */
async function openEditor(path = `/projects/WEB/workflows/wf-work/edit`) {
  renderApp(path);
  return within(await screen.findByRole("region", { name: "The line, editing" }));
}
const save = () => userEvent.click(screen.getByRole("button", { name: "Save" }));
const nameOf = (step: string) => screen.getByRole("textbox", { name: `Name of ${step}` });
const header = () => screen.getByRole("status", { name: "Editing" });
/** The Steps on the main line, in order, then Done: as the rail draws them. */
const onRail = () =>
  within(screen.getByRole("list", { name: "Steps on the line" }))
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("data-head"));
/** Picks `item` in a Step's ⋯ menu. */
async function menu(step: string, item: string) {
  await userEvent.click(screen.getByRole("button", { name: `More for ${step}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: item }));
}

function Address() {
  const l = useLocation();
  return <output aria-label="Address">{l.pathname + l.search}</output>;
}
/** The whole app at `path`, with where it is now read out beside it. */
function renderWithAddress(path: string) {
  render(
    <Providers client={newQueryClient()} live={new LiveActivity()}>
      <MemoryRouter initialEntries={[path]}>
        <Root />
        <Address />
      </MemoryRouter>
    </Providers>,
  );
}
const address = () => screen.getByLabelText("Address").textContent;

describe("a Workflow's editor", () => {
  it("shows a Member who is not an admin the line read-only, saying only an admin changes it", async () => {
    serve(workflow(), bob);
    renderApp("/projects/WEB/workflows/wf-work/edit");
    const line = within(await screen.findByRole("region", { name: "The line" }));
    expect(screen.getByText(/Only an admin changes Web's Workflow/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Work in Web" })).toHaveAttribute("href", "/projects/WEB/workflows/wf-work");
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Add a Step/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^More for / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(line.getByRole("list", { name: "Steps on the line" })).toHaveTextContent(/Build.*engineer.*Review/);
  });

  it("draws the draft on the line: a field per Step's name and Skill, its outcomes, Also starts here and When a Parent ends; no Task", async () => {
    serve();
    const line = await openEditor();
    expect(onRail()).toEqual(["Build", "Review", "Done"]);
    expect(nameOf("Build")).toHaveValue("Build");
    expect(screen.getByRole("combobox", { name: "Skill of Build" })).toHaveTextContent("engineer");
    // Review's pass rides the rail; its needs changes is a return beside it, both fields.
    expect(screen.getByRole("textbox", { name: "Outcome pass out of Review" })).toHaveValue("pass");
    expect(screen.getByRole("combobox", { name: "Where needs changes out of Review leads" })).toHaveTextContent("Build");
    const also = within(line.getByRole("region", { name: "Also starts here" }));
    expect(also.getByRole("textbox", { name: "Name of Backlog" })).toBeInTheDocument();
    expect(also.getByRole("combobox", { name: "Skill of Backlog" })).toHaveTextContent(/^Hold$/);
    expect(also.getByRole("textbox", { name: "Name of Plan" })).toBeInTheDocument();
    const after = within(line.getByRole("region", { name: "When a Parent ends" }));
    expect(after.getByRole("textbox", { name: "Name of Retro" })).toBeInTheDocument();
    expect(after.getByRole("textbox", { name: "Name of Skill review" })).toBeInTheDocument();
    // + Outcome is last under each Step.
    for (const s of ["Backlog", "Plan", "Build", "Review", "Retro", "Skill review"]) expect(screen.getByRole("button", { name: `Add an outcome out of ${s}` })).toBeInTheDocument();
    expect(line.queryAllByRole("button", { name: /waiting/ })).toEqual([]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("puts the Step the address names in focus", async () => {
    serve();
    await openEditor(`/projects/WEB/workflows/wf-work/edit?step=${step.review}`);
    await waitFor(() => expect(nameOf("Review")).toHaveFocus());
  });

  it("renames a Step: nothing sent until Save, then one PUT of the whole Workflow", async () => {
    const { api, puts } = serve();
    await openEditor();
    await userEvent.clear(nameOf("Build"));
    await userEvent.type(screen.getByRole("textbox", { name: "Name of the new Step" }), "Make");
    expect(header()).toHaveTextContent("1 change");
    expect(onRail()).toEqual(["Make", "Review", "Done"]);
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(renameStep(fromRecord(workflow()), step.build, "Make").wf));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
  });

  it("draws a changed Step and outcome in the changed colour", async () => {
    serve();
    const line = await openEditor();
    expect(line.getByRole("list", { name: "Steps on the line" }).querySelectorAll("[data-changed]")).toHaveLength(0);
    await userEvent.type(nameOf("Review"), "s");
    expect(line.getByRole("list", { name: "Steps on the line" }).closest("div")!.parentElement!.querySelector(`circle[data-dot="${step.review}"]`)).toHaveAttribute("data-changed");
    await userEvent.click(screen.getByRole("combobox", { name: "Where needs changes out of Reviews leads" }));
    await userEvent.click(await screen.findByRole("option", { name: "Plan" }));
    expect(screen.getByRole("combobox", { name: "Where needs changes out of Reviews leads" }).closest("[data-outcome]")).toHaveAttribute("data-changed");
  });

  it("lands a Project of one on its Workflow's page after Save, not the list", async () => {
    const { puts } = serve();
    renderWithAddress(`/projects/WEB/workflows/wf-work/edit`);
    const name = await screen.findByRole("textbox", { name: "Name of Build" });
    await userEvent.type(name, "s");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(() => expect(address()).toBe("/projects/WEB/workflows/wf-work"));
  });

  it("changes a Step's Skill, and makes a hold of another", async () => {
    const { puts } = serve();
    await openEditor();
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Build" }));
    await userEvent.click(await screen.findByRole("option", { name: /^review/ }));
    await userEvent.click(screen.getByRole("combobox", { name: "Skill of Plan" }));
    await userEvent.click(await screen.findByRole("option", { name: "None: a hold" }));
    expect(screen.getByRole("combobox", { name: "Skill of Plan" })).toHaveTextContent(/^Hold$/);
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
    await openEditor();
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
    await openEditor();
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

  it("adds a Step at the end of the line with + Step: a hold with no outcome, on the line, its name in focus; nothing is re-pointed", async () => {
    const { puts } = serve();
    await openEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add a Step at the end of the line" }));
    const name = screen.getByRole("textbox", { name: "Name of the new Step" });
    expect(name).toHaveFocus();
    expect(onRail()).toEqual(["Build", "Review", "New Step", "Done"]);
    expect(screen.getByRole("combobox", { name: "Skill of the new Step" })).toHaveTextContent(/^Hold$/);
    expect(screen.queryByRole("textbox", { name: /out of the new Step$/ })).toBeNull();
    await userEvent.type(name, "Security review");
    expect(header()).toHaveTextContent("1 change");
    expect(screen.getByRole("combobox", { name: "Where pass out of Build leads" })).toHaveTextContent("Review");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const r = insertStep(fromRecord(workflow()), step.review, "main", "wf-work");
    expect(puts[0]).toEqual(toBody(renameStep(r.draft, r.id, "Security review").wf));
    expect(puts[0].connectors.filter((c) => c.from === "Security review")).toEqual([]);
  });

  it("adds a Step after one from its menu, and at the end of When a Parent ends", async () => {
    serve();
    const line = await openEditor();
    await menu("Build", "Add Step after Build");
    expect(onRail()).toEqual(["Build", "New Step", "Review", "Done"]);
    await userEvent.click(screen.getByRole("button", { name: "Add a Step after a Parent" }));
    expect(within(line.getByRole("region", { name: "When a Parent ends" })).getAllByRole("textbox", { name: "Name of the new Step" })).toHaveLength(1);
    expect(header()).toHaveTextContent("2 changes");
  });

  it("re-points an outcome, and puts it back with its undo", async () => {
    serve();
    await openEditor();
    await userEvent.click(screen.getByRole("combobox", { name: "Where pass out of Build leads" }));
    await userEvent.click(await screen.findByRole("option", { name: "Plan" }));
    expect(header()).toHaveTextContent("1 change");
    await userEvent.click(screen.getByRole("button", { name: "Undo: lead pass back to Review" }));
    expect(screen.getByRole("combobox", { name: "Where pass out of Build leads" })).toHaveTextContent("Review");
    expect(header()).toHaveTextContent(/^Editing$/);
  });

  it("adds an outcome, names it and picks its Step; removes another", async () => {
    const { puts } = serve();
    await openEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add an outcome out of Build" }));
    const outcome = screen.getByRole("textbox", { name: "Outcome out of Build" });
    expect(outcome).toHaveFocus();
    await userEvent.type(outcome, "fail");
    await userEvent.click(screen.getByRole("combobox", { name: "Where fail out of Build leads" }));
    await userEvent.click(await screen.findByRole("option", { name: "Plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove needs changes out of Review" }));
    expect(header()).toHaveTextContent("2 changes");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const a = addOutcome(fromRecord(workflow()), step.build);
    let d = setTarget(renameOutcome(a.draft, a.id, "fail"), a.id, step.plan);
    d = removeOutcome(d, `${step.review}-c4`);
    expect(puts[0]).toEqual(toBody(d.wf));
  });

  it("makes another outcome the main way on with its dot: it goes first, the line follows it", async () => {
    const { puts } = serve();
    await openEditor();
    expect(screen.getByRole("button", { name: "pass out of Review: the main way on" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "needs changes out of Review: the main way on" }));
    expect(screen.getByRole("button", { name: "needs changes out of Review: the main way on" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "pass out of Review: the main way on" })).toHaveAttribute("aria-pressed", "false");
    expect(header()).toHaveTextContent("1 change");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(makeMain(fromRecord(workflow()), `${step.review}-c4`).wf));
  });

  it("moves a Step along its group with Alt+↑ and Alt+↓ on its grip, keeping the focus; never across groups", async () => {
    const { puts } = serve();
    await openEditor();
    const grip = screen.getByRole("button", { name: /^Move Build/ });
    act(() => grip.focus());
    fireEvent.keyDown(grip, { key: "ArrowDown", altKey: true });
    expect(onRail()).toEqual(["Review", "Build", "Done"]);
    expect(screen.getByRole("button", { name: /^Move Build/ })).toHaveFocus();
    // Build is last of the main Steps now: it does not cross into the Steps after a Parent.
    fireEvent.keyDown(screen.getByRole("button", { name: /^Move Build/ }), { key: "ArrowDown", altKey: true });
    expect(onRail()).toEqual(["Review", "Build", "Done"]);
    expect(header()).toHaveTextContent("1 change");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(reorderStep(fromRecord(workflow()), step.build, 1, groups).wf));
    expect(toBody(moveStepTo(fromRecord(workflow()), step.build, step.review).wf)).toEqual(puts[0]);
  });

  it("moves a Step from its menu, Move up off at the top of its group", async () => {
    serve();
    await openEditor();
    await menu("Review", "Move up");
    expect(onRail()).toEqual(["Review", "Build", "Done"]);
    await userEvent.click(screen.getByRole("button", { name: "More for Backlog" }));
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
  });

  it("asks before deleting a Step with Tasks and an outcome into it: where they go, the outcome removed or led on", async () => {
    const record = workflow(web, { review: { tasks: 2 } });
    const { puts } = serve(record);
    await openEditor();
    await menu("Review", "Delete Review");
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Review" }));
    expect(dialog.getByText("Review holds Tasks and other Steps lead into it.")).toBeInTheDocument();
    expect(dialog.getByRole("heading", { name: "2 Tasks at Review" })).toBeInTheDocument();
    expect(dialog.getByRole("heading", { name: "1 outcome leads into Review" })).toBeInTheDocument();
    expect(dialog.getByRole("combobox", { name: "Where pass out of Build leads instead" })).toHaveTextContent("Remove this outcome");
    expect(dialog.getByRole("note")).toHaveTextContent("Without Review, Build has no way out.");
    expect(dialog.getByRole("button", { name: "Delete Review" })).toBeDisabled();
    await userEvent.click(dialog.getByRole("combobox", { name: "Step that receives the Tasks at Review" }));
    await userEvent.click(await screen.findByRole("option", { name: "Build" }));
    await userEvent.click(dialog.getByRole("combobox", { name: "Where pass out of Build leads instead" }));
    await userEvent.click(await screen.findByRole("option", { name: "Done" }));
    expect(dialog.queryByRole("note")).toBeNull();
    await userEvent.click(dialog.getByRole("button", { name: "Delete Review" }));
    expect(onRail()).toEqual(["Build", "Done"]);
    expect(header()).toHaveTextContent("2 changes");
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    const d = deleteStep(fromRecord(record), step.review, step.build, { [`${step.build}-c2`]: { to: undefined } });
    expect(puts[0]).toEqual(toBody(d.wf, d.moves));
    expect(puts[0].moves).toEqual({ [step.review]: step.build });
  });

  it("removes the outcomes into a deleted Step when left to, lists every change, and says under the line where New Tasks start now", async () => {
    serve();
    await openEditor();
    expect(screen.queryByRole("note", { name: "Where New Tasks start" })).toBeNull();
    await menu("Build", "Delete Build");
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Build" }));
    expect(dialog.getByText("New Tasks start at Review, and so do Plan's Subtasks filed naming no Step.")).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Delete Build" }));
    expect(header()).toHaveTextContent("2 changes");
    expect(screen.getByRole("note", { name: "Where New Tasks start" })).toHaveTextContent("New Tasks start at Review");
    await userEvent.click(screen.getByRole("button", { name: "2 changes: list them" }));
    const changes = within(await screen.findByRole("list", { name: "Changes" }));
    expect(changes.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["DeletedBuild", "RemovedReview · needs changes → Build"]);
    expect(screen.getByText(/New Tasks start at Review\. Undo: ⌘Z/)).toBeInTheDocument();
  });

  it("deletes a Step at once when it holds no Task, nothing leads into it and it strands nothing", async () => {
    serve();
    await openEditor();
    await menu("Plan", "Delete Plan");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Name of Plan" })).toBeNull();
    expect(header()).toHaveTextContent("1 change");
  });

  it("says in words what /v1 would refuse, marks the field, and sends nothing", async () => {
    const { api } = serve();
    await openEditor();
    await userEvent.click(screen.getByRole("button", { name: "Add a Step at the end of the line" }));
    await save();
    expect(await screen.findByRole("alert")).toHaveTextContent("A Step needs a name.");
    expect(screen.getByRole("textbox", { name: "Name of the new Step" })).toHaveAttribute("aria-invalid", "true");
    expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await userEvent.type(screen.getByRole("textbox", { name: "Name of the new Step" }), "review");
    expect(screen.getByRole("alert")).toHaveTextContent(/^Two Steps are called Review/);
    expect(screen.getByRole("textbox", { name: "Name of review" })).toHaveAccessibleDescription("Named already in Work");
  });

  it("refuses a Step's name another Step has on its field, saying where it is", async () => {
    serve(workflowsFixture(web), ada, { "GET /v1/skills": { items: workflowsSkills } });
    await openEditor(`/projects/WEB/workflows/${wfId.features}/edit`);
    await userEvent.clear(nameOf("Build"));
    await userEvent.type(screen.getByRole("textbox", { name: "Name of the new Step" }), "verify");
    const field = screen.getByRole("textbox", { name: "Name of verify" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Named already in Bugs");
  });

  it("keeps the draft when /v1 refuses, and says why", async () => {
    serve(workflow(), ada, { "PUT /v1/projects/:project/workflow": refuse(409, "step_in_use", "Build still has Tasks.") });
    await openEditor();
    await userEvent.type(nameOf("Build"), "!");
    await save();
    expect(await screen.findByText(/Build still has Tasks/)).toBeInTheDocument();
    expect(nameOf("Build!")).toHaveValue("Build!");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("undoes the last change with ⌘Z outside a field, a run of typing as one", async () => {
    serve();
    await openEditor();
    const name = nameOf("Build");
    await userEvent.type(name, "er");
    act(() => name.blur());
    expect(header()).toHaveTextContent("1 change");
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    expect(nameOf("Build")).toHaveValue("Build");
    expect(header()).toHaveTextContent(/^Editing$/);
  });

  it("asks before Cancel throws changes away", async () => {
    serve();
    await openEditor();
    await userEvent.type(nameOf("Build"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Discard 1 change?" }));
    await userEvent.click(dialog.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /^Name of / })).toBeNull());
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
    /** Opens who takes `step` from its avatars on the line. */
    const takers = async (stepName: string) => {
      await userEvent.click(await screen.findByRole("button", { name: `Who takes ${stepName}` }));
      return within(await screen.findByRole("region", { name: "Taken by" }));
    };

    it("draws who takes each Step as avatars, Nobody when nobody does and nothing at a hold; a click lists them", async () => {
      serve(workflow(), ada, people);
      await openEditor();
      await waitFor(() => expect(screen.getByRole("button", { name: "Who takes Build" })).toHaveTextContent("builder"));
      expect(screen.getByRole("button", { name: "Who takes Plan" })).toHaveTextContent("Nobody");
      expect(screen.queryByRole("button", { name: "Who takes Backlog" })).toBeNull();
      const list = within((await takers("Build")).getByRole("list", { name: "Members with engineer" }));
      expect(list.getByRole("link", { name: "builder" })).toHaveAttribute("href", "/settings/organisation/agents/builder");
      expect(list.getByRole("button", { name: "Remove builder" })).toBeInTheDocument();
    });

    it("removes a Member into the draft: asked first when it reaches past this Step, listed, undone, and sent on Save", async () => {
      const { api, puts } = serve(workflow(), ada, people);
      await openEditor();
      await takers("Build");
      await userEvent.click(await screen.findByRole("button", { name: "Remove builder" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Remove builder from engineer?" }));
      expect(dialog.getByText("builder also takes engineer in Ops.")).toBeInTheDocument();
      await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
      expect(header()).toHaveTextContent(/^Editing$/);
      await userEvent.click(screen.getByRole("button", { name: "Remove builder" }));
      await userEvent.click(within(await screen.findByRole("dialog", { name: "Remove builder from engineer?" })).getByRole("button", { name: "Remove" }));
      expect(within(screen.getByRole("region", { name: "Taken by" })).getByText("Nobody")).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("button", { name: "Who takes Build" })).toHaveTextContent("Nobody");
      expect(header()).toHaveTextContent("1 change");
      expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
      await userEvent.click(screen.getByRole("button", { name: "1 change: list them" }));
      const changes = within(await screen.findByRole("list", { name: "Changes" }));
      expect(changes.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Removedbuilder from engineer"]);
      await userEvent.keyboard("{Escape}");
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
      await waitFor(() => expect(screen.getByRole("button", { name: "Who takes Build" })).toHaveTextContent("builder"));
      expect(header()).toHaveTextContent(/^Editing$/);
      await takers("Build");
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
      await openEditor();
      const taken = await takers("Review");
      await userEvent.click(await taken.findByRole("button", { name: "Remove ada" }));
      expect(screen.queryByRole("dialog", { name: /^Remove/ })).toBeNull();
      expect(taken.getByText("Nobody")).toBeInTheDocument();
      await save();
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(puts[0].revokes).toEqual([{ member: "m-ada", skill: review.id }]);
    });

    it("asks before taking skill-review, which is taken across the Organisation", async () => {
      serve(workflow(), ada, people);
      await openEditor();
      const taken = await takers("Skill review");
      await userEvent.click(await taken.findByRole("button", { name: "Remove ada" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Remove ada from skill-review?" }));
      expect(dialog.getByText("ada also takes skill-review in Ops.")).toBeInTheDocument();
    });

    it("adds a Member into the draft from a list grouped in and out of the Project; one from outside joins it on Save", async () => {
      const { api, puts } = serve(workflow(), ada, people);
      await openEditor();
      const taken = await takers("Build");
      await userEvent.click(await taken.findByRole("button", { name: "Add a Member" }));
      expect(await screen.findByRole("option", { name: /^ada/ })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: /^builder/ })).toBeNull();
      expect(screen.getByText("In Web")).toBeInTheDocument();
      expect(screen.getByText("Not in Web")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("option", { name: /^bob/ }));
      expect(within(screen.getByRole("list", { name: "Members with engineer" })).getByText("bob")).toBeInTheDocument();
      expect(header()).toHaveTextContent("1 change");
      // Removing one added in the draft takes back the add, unasked.
      await userEvent.click(screen.getByRole("button", { name: "Remove bob" }));
      expect(screen.queryByRole("dialog", { name: /^Remove/ })).toBeNull();
      expect(header()).toHaveTextContent(/^Editing$/);
      await userEvent.click(screen.getByRole("button", { name: "Add a Member" }));
      await userEvent.click(await screen.findByRole("option", { name: /^bob/ }));
      await userEvent.keyboard("{Escape}");
      expect(screen.getByRole("button", { name: "Who takes Build" })).toHaveTextContent(/builder.*bob|bob.*builder/);
      await userEvent.click(screen.getByRole("button", { name: "1 change: list them" }));
      const changes = within(await screen.findByRole("list", { name: "Changes" }));
      expect(changes.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Addedbob to engineer, joins Web"]);
      await userEvent.keyboard("{Escape}");
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
      await openEditor();
      const taken = await takers("Build");
      await userEvent.click(taken.getByRole("button", { name: "New agent" }));
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
      // Done closes the token; Escape then closes who takes Build, and another Step's opens alone.
      await userEvent.click(screen.getByRole("button", { name: "Done" }));
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("region", { name: "Taken by" })).toBeNull());
      await takers("Review");
      expect(screen.getAllByRole("region", { name: "Taken by" })).toHaveLength(1);
    });

    it("gives Members a Skill created on Save, in the same PUT, and none to a hold", async () => {
      const { puts } = serve(workflow(), ada, people);
      await openEditor();
      await userEvent.click(screen.getByRole("combobox", { name: "Skill of Review" }));
      await userEvent.type(await screen.findByPlaceholderText("Find or name a Skill"), "security");
      await userEvent.click(await screen.findByRole("option", { name: /New Skill “security”/ }));
      const dialog = within(await screen.findByRole("dialog", { name: "New Skill “security”" }));
      await userEvent.type(dialog.getByRole("textbox", { name: "Text" }), "x");
      await userEvent.click(dialog.getByRole("button", { name: "Use this Skill" }));
      const taken = await takers("Review");
      expect(taken.getByText("Nobody")).toBeInTheDocument();
      expect(taken.queryByRole("button", { name: "New agent" })).toBeNull();
      await userEvent.click(taken.getByRole("button", { name: "Add a Member" }));
      await userEvent.click(await screen.findByRole("option", { name: /^ada/ }));
      await userEvent.keyboard("{Escape}");
      await save();
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(puts[0].skills).toEqual([{ name: "security", body: "x" }]);
      expect(puts[0].grants).toEqual([{ member: "m-ada", skill: "security" }]);
    });
  });
});

describe("a Workflow's editor, of a Project of several", () => {
  const five = (extra: Parameters<typeof workflowsFixture>[1] = {}) => workflowsFixture(web, extra);
  const withSkills = { "GET /v1/skills": { items: workflowsSkills } };
  const changeList = async () => {
    await userEvent.click(screen.getByRole("button", { name: /^\d+ changes?: list them$/ }));
    return within(await screen.findByRole("list", { name: "Changes" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  };
  const nameField = () => screen.getByRole("textbox", { name: "Name of the Workflow" });

  it("edits one Workflow: its name in the head, its Steps on the line, an exit into another Workflow at its Step", async () => {
    serve(five(), ada, withSkills);
    await openEditor(`/projects/WEB/workflows/${wfId.bugs}/edit`);
    expect(nameField()).toHaveValue("Bugs");
    expect(screen.queryByRole("list", { name: "Workflows" })).toBeNull();
    expect(onRail()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]);
    // The Project, its Workflows' list, then the Workflow edited.
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("Web/Workflows/Bugs");
    expect(within(crumbs).getByRole("link", { name: "Workflows" })).toHaveAttribute("href", "/projects/WEB/workflows");
  });

  it("offers an outcome's targets with the Step's own Workflow first, then the others in order", async () => {
    serve(five(), ada, withSkills);
    await openEditor(`/projects/WEB/workflows/${wfId.bugs}/edit`);
    await userEvent.click(screen.getByRole("combobox", { name: "Where ready out of Fix leads" }));
    const groups = within(await screen.findByRole("listbox")).getAllByRole("group");
    expect(groups.map((g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["Bugs", "Triage", "Features", "Prototypes", "Support"]);
  });

  it("is answered as /v1 answers: a Step naming no Workflow of the body is refused, outcomes named in any case", () => {
    const body = toBody(workflow());
    expect(answer(workflow(), { ...body, steps: body.steps.map((st, i) => (i === 0 ? { ...st, workflow: "Nowhere" } : st)) })).toBeInstanceOf(Response);
    const made = answer(workflow(), { ...body, connectors: [...body.connectors, { from: "BUILD", name: "later", position: 9 }] }) as Workflows;
    expect(made.connectors.find((c) => c.name === "later")?.from_step_id).toBe(step.build);
  });

  it("renames the Workflow in its head, Enter keeping it; saved with the draft, then its live page", async () => {
    const { puts } = serve(five(), ada, withSkills);
    await openEditor(`/projects/WEB/workflows/${wfId.bugs}/edit`);
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Defects{Enter}");
    expect(nameField()).not.toHaveFocus();
    expect(nameField()).toHaveValue("Defects");
    expect(await changeList()).toEqual(["Workflow renamedBugs → Defects"]);
    await userEvent.keyboard("{Escape}");
    expect(puts).toEqual([]);
    await save();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].workflows[1]).toEqual({ id: wfId.bugs, name: "Defects", position: 2 });
    expect(await screen.findByRole("button", { name: "Workflow: Defects" })).toBeInTheDocument();
  });

  it("opened by its name, goes to its id first: a rename keeps the editor", async () => {
    serve(five(), ada, withSkills);
    renderWithAddress(`/projects/WEB/workflows/bugs/edit?step=${wfStep.fix}`);
    await screen.findByRole("region", { name: "The line, editing" });
    await waitFor(() => expect(address()).toBe(`/projects/WEB/workflows/${wfId.bugs}/edit?step=${wfStep.fix}`));
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Defects");
    expect(nameField()).toHaveValue("Defects");
    expect(screen.queryByText("Not found")).toBeNull();
    expect(onRail()).toEqual(["Investigate", "Fix", "Review", "Verify", "Done"]);
    expect(address()).toBe(`/projects/WEB/workflows/${wfId.bugs}/edit?step=${wfStep.fix}`);
  });

  it("refuses a name another Workflow has in another case, before anything is sent", async () => {
    const { puts } = serve(five(), ada, withSkills);
    await openEditor(`/projects/WEB/workflows/${wfId.bugs}/edit`);
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "support{Enter}");
    await save();
    expect(await screen.findByText("Two Workflows are called support: a name is used once in a Project, whatever its case.")).toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it("puts the name back with Escape, nothing changed; a name typed and left is kept", async () => {
    serve(five(), ada, withSkills);
    await openEditor(`/projects/WEB/workflows/${wfId.bugs}/edit`);
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Defects{Escape}");
    expect(nameField()).toHaveValue("Bugs");
    expect(nameField()).not.toHaveFocus();
    expect(header()).toHaveTextContent(/^Editing$/);
    // Leaving the field keeps what was typed.
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), "Defects");
    await userEvent.click(nameOf("Investigate"));
    expect(nameField()).toHaveValue("Defects");
    expect(await changeList()).toEqual(["Workflow renamedBugs → Defects"]);
  });

  it("marks an empty name on Save and sends nothing", async () => {
    const { puts } = serve(five(), ada, withSkills);
    await openEditor(`/projects/WEB/workflows/${wfId.bugs}/edit`);
    await userEvent.clear(nameField());
    await save();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    expect(puts).toEqual([]);
  });

  it("moves a Step into another Workflow from its menu; the editor follows it there, the draft kept", async () => {
    serve(five(), ada, withSkills);
    await openEditor(`/projects/WEB/workflows/${wfId.bugs}/edit`);
    await userEvent.click(screen.getByRole("button", { name: "More for Fix" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move to Workflow" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Support" }));
    await waitFor(() => expect(nameField()).toHaveValue("Support"));
    expect(nameOf("Fix")).toHaveFocus();
    expect(await changeList()).toEqual(["MovedFix to Support"]);
  });

  it("goes back to the Workflow's page on Cancel", async () => {
    serve(five(), ada, withSkills);
    renderWithAddress(`/projects/WEB/workflows/${wfId.bugs}/edit`);
    await screen.findByRole("region", { name: "The line, editing" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Workflow: Bugs" })).toBeInTheDocument();
    expect(address()).toBe(`/projects/WEB/workflows/${wfId.bugs}`);
  });

  it("lands on the Workflow's page after Discard", async () => {
    serve(five(), ada, withSkills);
    renderWithAddress(`/projects/WEB/workflows/${wfId.bugs}/edit`);
    await screen.findByRole("region", { name: "The line, editing" });
    await userEvent.type(nameField(), "!");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Discard 1 change?" }));
    await userEvent.click(dialog.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(address()).toBe(`/projects/WEB/workflows/${wfId.bugs}`));
  });

  it("shows a Member who is not an admin the Workflow's name, not a field", async () => {
    serve(five(), bob, withSkills);
    renderApp(`/projects/WEB/workflows/${wfId.prototypes}/edit`);
    expect(await screen.findByRole("heading", { name: "Prototypes" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Name of the Workflow" })).toBeNull();
    expect(onRail()).toEqual(["Sketch", "Prototype review", "Done"]);
  });

  it("says a Workflow the address names that is none of the Project's is not found", async () => {
    serve(five(), ada, withSkills);
    renderApp("/projects/WEB/workflows/nothing-here/edit");
    expect((await screen.findAllByText("Not found")).length).toBeGreaterThan(0);
  });
});
