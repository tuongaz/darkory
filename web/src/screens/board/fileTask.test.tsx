import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "@/api/client";
import { mockApi, refuse, type Call } from "@/test/api";
import { acceptance, ada, bob, builder, detail, me, ops, step, task, web, workflow } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { openFileTask } from "./state";
import { cart, routes } from "./testData";

beforeEach(() => localStorage.clear());

const filed = (api: { calls: Call[] }) => api.calls.find((c) => c.method === "POST" && c.path === "/v1/tasks");

async function openDialog(path = "/projects/WEB/tasks") {
  renderApp(path);
  await screen.findByRole("link", { name: /WEB-2/ });
  await userEvent.keyboard("c");
  return screen.findByRole("dialog", { name: "File a Task" });
}

async function pick(dialog: HTMLElement, field: string, option: RegExp) {
  await userEvent.click(within(dialog).getByRole("combobox", { name: field }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

const answer = () => ({ "POST /v1/tasks": ({ body }: { body: unknown }) => detail(task(11, { title: (body as { title: string }).title })) });

describe("File a Task", () => {
  it("files in the current Project at its first work Step, showing that Step's Skill and takers", async () => {
    const api = mockApi(routes(answer()));
    const dialog = await openDialog();
    expect(within(dialog).getByRole("combobox", { name: "Project" })).toHaveTextContent("Web");
    const stepField = within(dialog).getByRole("combobox", { name: "Step" });
    expect(stepField).toHaveTextContent("Build");
    expect(stepField).toHaveTextContent("engineer");
    expect(within(stepField).getByLabelText("Taken by builder")).toBeInTheDocument();
    // The Workflow has a breakdown Step and no acceptance Step.
    expect(within(dialog).getByRole("switch", { name: "Break down" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("switch", { name: "Acceptance" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Owner" })).toHaveTextContent("ada");

    await userEvent.type(within(dialog).getByLabelText("Title"), "Gift wrapping");
    await pick(dialog, "Labels", /client-x/);
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toEqual({
      project: "WEB",
      title: "Gift wrapping",
      owner: ada.id,
      step: step.build,
      auto_complete: false,
      labels: ["l-client-x"],
    });
    expect(await screen.findByText("Filed WEB-11")).toBeInTheDocument();
  });

  it("opened by C before the Projects load, files in the Project of the address, not the Member's first", async () => {
    let loaded!: () => void;
    const loading = new Promise<void>((resolve) => (loaded = resolve));
    const api = mockApi(
      routes({
        ...answer(),
        "GET /v1/me": { ...me(ada), projects: [ops, web] },
        "GET /v1/projects": async () => {
          await loading;
          return { items: [ops, web] };
        },
      }),
    );
    renderApp("/projects/WEB/tasks");
    await waitFor(() => expect(api.calls.some((c) => c.path === "/v1/projects")).toBe(true));
    await userEvent.keyboard("c");
    loaded();
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Project" })).toHaveTextContent("Web"));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Gift wrapping");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toMatchObject({ project: "WEB" });
    // Nothing asked of /v1 for a Project not known yet.
    expect(api.calls.filter((c) => c.path === "/v1/tasks" && c.query.get("project") === "")).toEqual([]);
  });

  it("refuses a blank title before asking /v1", async () => {
    const api = mockApi(routes());
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    expect(within(dialog).getByText("Name the Task.")).toBeInTheDocument();
    expect(filed(api)).toBeUndefined();
  });

  it("with Break down files a Parent with its Breakdown, at no Step", async () => {
    const api = mockApi(routes(answer()));
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("Title"), "Checkout v2");
    await userEvent.click(within(dialog).getByRole("switch", { name: "Break down" }));
    const stepField = within(dialog).getByRole("combobox", { name: "Step" });
    expect(stepField).toBeDisabled();
    expect(stepField).toHaveTextContent("None: a Parent");
    // A Parent is never blocked: Blocked by goes.
    expect(within(dialog).queryByRole("combobox", { name: "Blocked by" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "About Step" }));
    expect(await screen.findByText("Filed as a Parent, it is at no Step; its Breakdown waits at Plan.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toMatchObject({ breakdown: true });
    expect(filed(api)!.body).not.toHaveProperty("step");
  });

  it("files a Subtask under a Parent, which names no Owner or Auto-complete", async () => {
    const api = mockApi(routes(answer()));
    const dialog = await openDialog();
    await pick(dialog, "Parent", /Checkout/);
    expect(within(dialog).getByRole("combobox", { name: "Parent" })).toHaveTextContent("WEB-3");
    // A Subtask has no Subtasks: their group goes.
    expect(within(dialog).queryByRole("group", { name: "Subtasks" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: "Owner" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("switch", { name: "Auto-complete" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("switch", { name: "Break down" })).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Title"), "Coupon field");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toEqual({ project: "WEB", title: "Coupon field", parent: "WEB-3", step: step.build });
  });

  it("tells the holder that filing a Subtask under the Task they hold ends their Claim, and carries their Note", async () => {
    const api = mockApi(routes(answer(), builder));
    renderApp("/projects/WEB/tasks");
    await screen.findByRole("link", { name: /WEB-2/ });
    openFileTask({ project: "WEB", parent: cart.key });
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    expect(await within(dialog).findByText("This ends your Claim on WEB-2")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Title"), "Cart totals");
    await userEvent.type(within(dialog).getByLabelText("Note"), "Two parts");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toMatchObject({ parent: "WEB-2", note: "Two parts" });
  });

  it("says in words why a Subtask under someone else's held Task is refused", async () => {
    mockApi(routes({ "POST /v1/tasks": refuse(409, "held", "held by another Member") }));
    renderApp("/projects/WEB/tasks");
    await screen.findByRole("link", { name: /WEB-2/ });
    openFileTask({ project: "WEB", parent: cart.key });
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    await userEvent.type(within(dialog).getByLabelText("Title"), "Cart totals");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    expect(await within(dialog).findByText("builder holds WEB-2: only they file Subtasks under it, which ends their Claim.")).toBeInTheDocument();
  });

  it("files a question aimed at a Member that blocks a Task, at no Step and beside it", async () => {
    const api = mockApi(routes(answer()));
    renderApp("/projects/WEB/tasks");
    await screen.findByRole("link", { name: /WEB-2/ });
    openFileTask({ project: "WEB", blocks: "WEB-4", aim: bob.id });
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    // WEB-4 is a Subtask of WEB-3: the question joins WEB-3.
    expect(within(dialog).getByText("Joins WEB-3, beside WEB-4")).toBeInTheDocument();
    // The Question group opens itself for what the entry point named.
    expect(within(dialog).getByRole("switch", { name: "Question" })).toBeChecked();
    expect(within(dialog).getByRole("combobox", { name: "Aim at" })).toHaveTextContent("bob");
    expect(within(dialog).getByRole("combobox", { name: "Blocks" })).toHaveTextContent("WEB-4");
    const stepField = within(dialog).getByRole("combobox", { name: "Step" });
    expect(stepField).toBeDisabled();
    expect(stepField).toHaveTextContent("With bob");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Which card brands?");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toEqual({ project: "WEB", title: "Which card brands?", aim: bob.id, blocks: "WEB-4" });
  });

  it("names the Acceptance Step once when it is named Acceptance", async () => {
    const wf = workflow();
    wf.steps.push({ ...wf.steps[3], id: "st-accept", name: "Acceptance", skill_id: acceptance.id, position: 7, takers: [] });
    mockApi(routes({ ...answer(), "GET /v1/projects/:project/workflow": wf }));
    const dialog = await openDialog();
    await within(dialog).findByRole("switch", { name: "Acceptance" });
    // Explained from its ⓘ, not under it.
    expect(dialog).not.toHaveTextContent("runs before it completes");
    await userEvent.click(within(dialog).getByRole("button", { name: "About Acceptance" }));
    expect(await screen.findByText("Acceptance runs before it completes.")).toBeInTheDocument();
  });

  it("offers Acceptance when the Workflow has an acceptance Step, starting at the Project's default", async () => {
    const wf = workflow();
    wf.steps.push({ ...wf.steps[3], id: "st-accept", name: "Accept", skill_id: acceptance.id, position: 7, takers: [] });
    const api = mockApi(
      routes({
        ...answer(),
        "GET /v1/projects/:project/workflow": wf,
        "GET /v1/projects": { items: [{ ...web, acceptance: true, auto_complete: true }] },
      }),
    );
    const dialog = await openDialog();
    expect(await within(dialog).findByRole("switch", { name: "Acceptance" })).toBeChecked();
    expect(within(dialog).getByRole("switch", { name: "Auto-complete" })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "About Acceptance" }));
    expect(await screen.findByText("Runs at the Accept Step before it completes.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(dialog).getByRole("switch", { name: "Acceptance" }));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Refunds");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toMatchObject({ auto_complete: true, acceptance: false });
  });

  it("names the Project's default Workspace to start with, and none once it is taken out", async () => {
    const shop: Workspace = { id: "w-shop", name: "shop", kind: "git", path: "/src/shop", mode: "plain", default_branch: "main", created_at: web.created_at };
    const api = mockApi(
      routes({
        ...answer(),
        "GET /v1/workspaces": { items: [shop] },
        "GET /v1/projects": { items: [{ ...web, default_workspace_id: shop.id }] },
      }),
    );
    const dialog = await openDialog();
    expect(await within(dialog).findByRole("button", { name: "Take out shop" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Take out shop" }));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Docs");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toMatchObject({ workspaces: [] });
  });

  it("groups its fields by what the filer decides, with no line repeating a field", async () => {
    mockApi(routes(answer()));
    const dialog = await openDialog();
    const group = (name: string) => within(dialog).getByRole("group", { name });
    const fields = (g: HTMLElement) => within(g).queryAllByRole("combobox").map((c) => c.id);
    // The Task itself comes first, under no heading; the Title has the focus.
    expect(within(dialog).getByLabelText("Title")).toHaveFocus();
    expect(fields(group("Belongs to"))).toEqual(["file-task-project", "file-task-parent", "file-task-owner"]);
    expect(fields(group("Start"))).toEqual(["file-task-step", "file-task-blocked-by"]);
    expect(within(group("Subtasks")).getAllByRole("switch").map((s) => s.id)).toEqual(["file-task-breakdown", "file-task-auto-complete"]);
    // The question is asked for: off, its fields are not there.
    const question = within(group("Question")).getByRole("switch", { name: "Question" });
    expect(question).not.toBeChecked();
    expect(within(dialog).queryByRole("combobox", { name: "Aim at" })).not.toBeInTheDocument();
    // Nothing repeats what a field shows: no "In WEB." under the title, no "Starts at Build" by the buttons, no "optional".
    expect(dialog).not.toHaveTextContent(/In WEB|Starts at|optional/);
    // Focus follows the groups: Title, Description, Labels, then Project.
    await userEvent.tab();
    expect(within(dialog).getByLabelText("Description")).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByRole("combobox", { name: "Labels" })).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByRole("combobox", { name: "Project" })).toHaveFocus();
  });

  it("asks a question once switched on, and switched off asks none", async () => {
    const api = mockApi(routes(answer()));
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("switch", { name: "Question" }));
    await pick(dialog, "Aim at", /bob/);
    expect(within(dialog).getByRole("combobox", { name: "Step" })).toHaveTextContent("With bob");
    // A question waits for its answer: what it would do as a Parent is not asked.
    expect(within(dialog).queryByRole("group", { name: "Subtasks" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("switch", { name: "Question" }));
    expect(within(dialog).getByRole("group", { name: "Subtasks" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: "Aim at" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Step" })).toHaveTextContent("Build");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Gift wrapping");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).not.toHaveProperty("aim");
    expect(filed(api)!.body).toMatchObject({ step: step.build });
  });

  it("files a Task blocked by others from its first moment", async () => {
    const api = mockApi(routes(answer()));
    const dialog = await openDialog();
    await pick(dialog, "Blocked by", /Draft the launch copy/);
    await userEvent.keyboard("{Escape}");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Launch post");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toMatchObject({ title: "Launch post", step: step.build, blocked_by: ["WEB-1"] });
  });

  it("drops Blocked by when Break down makes it a Parent", async () => {
    const api = mockApi(routes(answer()));
    const dialog = await openDialog();
    await pick(dialog, "Blocked by", /Draft the launch copy/);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(dialog).getByRole("switch", { name: "Break down" }));
    await userEvent.type(within(dialog).getByLabelText("Title"), "Launch");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toMatchObject({ breakdown: true });
    expect(filed(api)!.body).not.toHaveProperty("blocked_by");
  });

  it("explains a Subtask's Workspaces from its ⓘ", async () => {
    const shop: Workspace = { id: "w-shop", name: "shop", kind: "git", path: "/src/shop", mode: "plain", default_branch: "main", created_at: web.created_at };
    const api = mockApi(routes({ ...answer(), "GET /v1/workspaces": { items: [shop] } }));
    const dialog = await openDialog();
    expect(within(dialog).queryByRole("button", { name: "About Workspaces" })).not.toBeInTheDocument();
    await pick(dialog, "Parent", /Checkout/);
    expect(within(within(dialog).getByRole("group", { name: "Start" })).getByRole("combobox", { name: "Workspaces" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "About Workspaces" }));
    expect(await screen.findByText("Its branch starts from its Parent's.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Coupon field");
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toMatchObject({ parent: "WEB-3", workspaces: [] });
  });
});
