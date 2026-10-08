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
    expect(dialog).toHaveTextContent("In WEB.");
    const stepField = within(dialog).getByRole("combobox", { name: "Step" });
    expect(stepField).toHaveTextContent("Build");
    expect(stepField).toHaveTextContent("engineer");
    expect(within(stepField).getByLabelText("Taken by builder")).toBeInTheDocument();
    // The Workflow has a breakdown Step and no acceptance Step.
    expect(within(dialog).getByRole("switch", { name: "Break down" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("switch", { name: "Acceptance" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Owner" })).toHaveTextContent("ada");

    await userEvent.type(within(dialog).getByLabelText("Title"), "Gift wrapping");
    await pick(dialog, "Labels optional", /client-x/);
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
    await waitFor(() => expect(dialog).toHaveTextContent("In WEB."));
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
    expect(within(dialog).getByRole("combobox", { name: "Step" })).toBeDisabled();
    expect(within(dialog).getByText("Also files its Breakdown at Plan")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "File Task" }));
    await waitFor(() => expect(filed(api)).toBeDefined());
    expect(filed(api)!.body).toMatchObject({ breakdown: true });
    expect(filed(api)!.body).not.toHaveProperty("step");
  });

  it("files a Subtask under a Parent, which names no Owner or Auto-complete", async () => {
    const api = mockApi(routes(answer()));
    const dialog = await openDialog();
    await pick(dialog, "Parent optional", /Checkout/);
    expect(dialog).toHaveTextContent("In WEB, under WEB-3.");
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
    await userEvent.type(within(dialog).getByLabelText("Note optional"), "Two parts");
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
    expect(within(dialog).getByRole("combobox", { name: "Step" })).toBeDisabled();
    expect(within(dialog).getByText("Waits with bob, blocking WEB-4")).toBeInTheDocument();
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
    expect(dialog).toHaveTextContent("Confirmed as a whole at the Acceptance Step before it is done");
    expect(dialog).not.toHaveTextContent("Acceptance at Acceptance");
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
    expect(dialog).toHaveTextContent("Acceptance runs at the Accept Step before it is done");
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
});
