import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NodeChange, ReactFlowProps } from "@xyflow/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Schemas, Workflow } from "@/api/client";
import type { CanvasNode, ConnectorFlowEdge } from "@/components/workflow/flow";
import { tidy } from "@/components/workflow/layout";
import { mockApi, refuse, type Call } from "@/test/api";
import { ada, bob, builder, engineer, review, skills, step, task, web, workflow } from "@/test/fixtures";
import { signedIn } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { toBody, toCanvas } from "./bind";
import { addConnector, addStep, deleteStep, layoutSteps, placeStep, removeConnector, renameConnector, renameStep, setStepSkill } from "./edits";

// What the editing canvas hands React Flow, so a test can drop a step as a drag would.
const flow = vi.hoisted(() => ({ props: undefined as unknown as ReactFlowProps<CanvasNode, ConnectorFlowEdge> }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...mod,
    ReactFlow: (props: ReactFlowProps<CanvasNode, ConnectorFlowEdge>) => {
      if (props.onConnect) flow.props = props;
      return <mod.ReactFlow {...(props as ComponentProps<typeof mod.ReactFlow>)} />;
    },
  };
});

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

const putsOf = (api: ReturnType<typeof mockApi>) => api.calls.filter((c) => c.method === "PUT");
// React Flow draws a node hidden until it has measured it, which jsdom never does.
const stepNode = (name: string) => screen.getAllByRole("group", { hidden: true }).find((n) => n.getAttribute("aria-label")?.startsWith(`${name}:`))!;
const panel = () => screen.findByRole("region", { name: /^(Step|Connector) / });

async function openEditing(path = "/settings/projects/WEB/workflow?step=st-build") {
  renderApp(path);
  return within(await panel());
}

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

describe("Settings › Workflow", () => {
  it("shows a Member who is not an admin the Workflow live, saying only an admin changes it", async () => {
    serve(workflow(), bob);
    renderApp("/settings/projects/WEB/workflow");
    expect(await screen.findByText(/Only an admin changes Web's Workflow/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add step" })).toBeNull();
  });

  it("renames a Step: one PUT of the whole Workflow", async () => {
    const { puts } = serve();
    const p = await openEditing();
    const name = p.getByRole("textbox", { name: "Name of Build" });
    await userEvent.clear(name);
    await userEvent.type(name, "Make{Enter}");
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(renameStep(workflow(), step.build, "Make").next));
    expect(await screen.findByText("Renamed Build to Make")).toBeInTheDocument();
  });

  it("changes a Step's Skill", async () => {
    const { puts } = serve();
    const p = await openEditing();
    await userEvent.click(p.getByRole("combobox", { name: "Skill of Build" }));
    await userEvent.click(await screen.findByRole("option", { name: "review" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(setStepSkill(workflow(), step.build, review).next));
  });

  it("adds a Step after one from its +, and selects it once /v1 has named it", async () => {
    const { puts } = serve();
    renderApp("/settings/projects/WEB/workflow");
    await userEvent.click(await screen.findByRole("button", { name: "Add a step after Review", hidden: true }));
    await waitFor(() => expect(puts).toHaveLength(1));
    const sent = puts[0];
    const expected = toBody(addStep(workflow(), step.review).next);
    expect(sent).toEqual(expected);
    expect(sent.connectors.find((c) => c.to === "New step")).toEqual({ from: step.review, to: "New step", name: "next", position: 3 });
    const p = within(await panel());
    expect(p.getByRole("textbox", { name: "Name of New step" })).toBeInTheDocument();
    // Renamed once /v1 has given it its id: sent by that id.
    await userEvent.type(p.getByRole("textbox", { name: "Name of New step" }), "{Control>}a{/Control}Docs{Enter}");
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].steps.find((s) => s.name === "Docs")).toMatchObject({ id: "st-made-1" });
  });

  it("asks where a Step's Tasks go before deleting it, and sends the moves", async () => {
    const record = workflow(web, { review: { tasks: 2 } });
    const { puts } = serve(record);
    const p = await openEditing(`/settings/projects/WEB/workflow?step=${step.review}`);
    await userEvent.click(p.getByRole("button", { name: "Delete Review" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete Review" }));
    expect(dialog.getByText(/2 Tasks are at Review/)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Delete Review" })).toBeDisabled();
    await userEvent.click(dialog.getByRole("combobox", { name: "Step that receives the Tasks at Review" }));
    await userEvent.click(await screen.findByRole("option", { name: "Build" }));
    await userEvent.click(dialog.getByRole("button", { name: "Delete Review" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    const c = deleteStep(record, step.review, step.build);
    expect(puts[0]).toEqual(toBody(c.next, c.moves));
    expect(puts[0].moves).toEqual({ [step.review]: step.build });
  });

  it("connects a Step to another with Connect to…, renames and removes a Connector", async () => {
    const { puts } = serve();
    const p = await openEditing(`/settings/projects/WEB/workflow?step=${step.backlog}`);
    await userEvent.click(p.getByRole("button", { name: "Connect to…" }));
    await userEvent.click(p.getByRole("combobox", { name: "Lead to" }));
    await userEvent.click(await screen.findByRole("option", { name: "Build" }));
    const outcome = p.getByRole("textbox", { name: "Outcome" });
    expect(outcome).toHaveValue("pass");
    await userEvent.clear(outcome);
    await userEvent.type(outcome, "start");
    await userEvent.click(p.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(addConnector(workflow(), step.backlog, step.build, "start").next));

    await userEvent.click(screen.getByRole("button", { name: "Text" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit needs changes, Review to Build" }));
    const c = within(await screen.findByRole("region", { name: "Connector needs changes" }));
    const name = c.getByRole("textbox", { name: "Outcome needs changes" });
    await userEvent.clear(name);
    await userEvent.type(name, "rework{Enter}");
    await waitFor(() => expect(puts).toHaveLength(2));
    const afterAdd = answer(workflow(), puts[0]);
    expect(puts[1]).toEqual(toBody(renameConnector(afterAdd, `${step.review}-c4`, "rework").next));

    await userEvent.click(c.getByRole("button", { name: "Remove rework" }));
    await waitFor(() => expect(puts).toHaveLength(3));
    expect(puts[2]).toEqual(toBody(removeConnector(answer(afterAdd, puts[1]), `${step.review}-c4`).next));
  });

  it("saves a Step's place when its drag ends, and every place on Tidy up", async () => {
    const { puts } = serve();
    renderApp("/settings/projects/WEB/workflow");
    await screen.findByRole("button", { name: "Tidy up", hidden: true });
    const drop: NodeChange<CanvasNode>[] = [{ type: "position", id: step.plan, position: { x: 101.4, y: 202.6 }, dragging: false }];
    act(() => flow.props.onNodesChange!(drop));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual(toBody(placeStep(workflow(), step.plan, 101, 203).next));

    await userEvent.click(screen.getByRole("button", { name: "Tidy up", hidden: true }));
    await waitFor(() => expect(puts).toHaveLength(2));
    const placed = answer(workflow(), puts[0]);
    const positions = tidy(toCanvas(placed, new Map(skills.map((s) => [s.id, s]))));
    expect(puts[1]).toEqual(toBody(layoutSteps(placed, positions).next));
  });

  it("draws changes made while one is on its way and sends them together after it, a new Step by its new id", async () => {
    let release!: () => void;
    const { puts, api } = serve();
    const first = api.routes["PUT /v1/projects/:project/workflow"] as (c: Call & { params: Record<string, string> }) => unknown;
    api.routes["PUT /v1/projects/:project/workflow"] = async (c: Call & { params: Record<string, string> }) => {
      if (puts.length === 0) await new Promise<void>((r) => (release = r));
      return first(c) as object;
    };
    renderApp("/settings/projects/WEB/workflow");
    await userEvent.click(await screen.findByRole("button", { name: "Add step" }));
    const p = within(await panel());
    const name = p.getByRole("textbox", { name: "Name of New step" });
    await userEvent.type(name, "{Control>}a{/Control}Docs{Enter}");
    // Drawn at once, not sent yet.
    await waitFor(() => expect(stepNode("Docs")).toBeDefined());
    expect(puts).toHaveLength(0);
    release();
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[0].steps.at(-1)).toEqual({ name: "New step", position: 7, x: 896, y: 0 });
    expect(puts[1].steps.at(-1)).toEqual({ id: "st-made-1", name: "Docs", position: 7, x: 896, y: 0 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
  });

  it("says in words what /v1 would refuse, and sends nothing", async () => {
    const { api } = serve();
    const p = await openEditing(`/settings/projects/WEB/workflow?step=${step.plan}`);
    const name = p.getByRole("textbox", { name: "Name of Plan" });
    await userEvent.clear(name);
    await userEvent.type(name, "build{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Two steps are called build: a name is used once in a Workflow, whatever its case.");
    expect(name).toHaveValue("Plan");
    expect(putsOf(api)).toHaveLength(0);
  });

  it("puts the Workflow back when /v1 refuses, and says why", async () => {
    const { api } = serve(workflow(), ada, {
      "PUT /v1/projects/:project/workflow": refuse(409, "step_in_use", "Build has open Tasks."),
    });
    const p = await openEditing();
    const name = p.getByRole("textbox", { name: "Name of Build" });
    await userEvent.clear(name);
    await userEvent.type(name, "Make{Enter}");
    await waitFor(() => expect(putsOf(api)).toHaveLength(1));
    expect(await screen.findByText("step_in_use")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Step Build" })).getByRole("textbox", { name: "Name of Build" })).toHaveValue("Build"));
  });

  it("undoes the last change from its toast: the Workflow as it was, sent whole", async () => {
    const { puts } = serve();
    const p = await openEditing();
    const name = p.getByRole("textbox", { name: "Name of Build" });
    await userEvent.clear(name);
    await userEvent.type(name, "Make{Enter}");
    await waitFor(() => expect(puts).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toEqual(toBody(workflow()));
    expect(await screen.findByText("Undid: Renamed Build to Make")).toBeInTheDocument();
  });

  it("gives a Step's Skill to a Member, adding them to the Project", async () => {
    const { api } = serve(workflow(), ada, { "PUT /v1/projects/:project/members/:member": undefined, "PUT /v1/members/:member/skills/:skill": undefined });
    const p = await openEditing();
    await userEvent.click(p.getByRole("button", { name: "Add Member" }));
    await userEvent.click(await screen.findByRole("option", { name: "bob: Joins Web, gets engineer" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "PUT" && c.path === "/v1/members/m-bob/skills/s-engineer")).toBe(true));
    expect(api.calls.some((c) => c.method === "PUT" && c.path === "/v1/projects/WEB/members/m-bob")).toBe(true);
  });

  it("creates an agent for the Step and shows its token once", async () => {
    const made = { ...builder, id: "m-new", name: "builder-2" };
    const { api } = serve(workflow(), ada, {
      "POST /v1/members": made,
      "PUT /v1/projects/:project/members/:member": undefined,
      "PUT /v1/members/:member/skills/:skill": undefined,
      "PATCH /v1/members/:member/agent": made,
      "POST /v1/members/:member/tokens": { token: { id: "t1", member_id: "m-new", name: "default", created_at: "" }, secret: "dk_secret" },
    });
    const p = await openEditing();
    await userEvent.click(p.getByRole("button", { name: "Create an agent" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Create an agent" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "Name" }), "builder-2");
    await userEvent.click(dialog.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByRole("textbox", { name: "Secret of builder-2's token" })).toHaveValue("dk_secret");
    const writes = api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual([
      "POST /v1/members",
      "PUT /v1/projects/WEB/members/m-new",
      `PUT /v1/members/m-new/skills/${engineer.id}`,
      "PATCH /v1/members/m-new/agent",
      "POST /v1/members/m-new/tokens",
    ]);
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/members")!.body).toEqual({ name: "builder-2", kind: "agent" });
    expect(api.calls.find((c) => c.method === "PATCH")!.body).toEqual({ model: "claude-sonnet-5-5" });
  });
});
