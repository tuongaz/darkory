import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Project, Task, Workspace } from "@/api/client";
import { json, mockApi, refuse, type Handler } from "@/test/api";
import { acceptance, ada, bob, builder, me, memberDetail, ops, review, signedIn, task, web, workflow } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const at = "2026-10-01T09:00:00Z";
const shop: Workspace = { id: "w-shop", name: "shop", kind: "git", path: "/src/shop", mode: "plain", default_branch: "main", created_at: at };
const docs: Workspace = { id: "w-docs", name: "docs", kind: "git", path: "/src/docs", mode: "pull_request", default_branch: "trunk", created_at: at };

const writes = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method !== "GET");

/** The Projects as the server keeps them: a PATCH changes what the next read returns. */
function routes(start: Project[] = [ops, web], extra: Record<string, Handler> = {}): Record<string, Handler> {
  const projects = new Map(start.map((p) => [p.key, p]));
  return {
    ...signedIn(),
    "GET /v1/projects": () => ({ items: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)) }),
    "GET /v1/projects/:project": ({ params }) => ({ project: projects.get(params.project)!, members: [ada, bob, builder] }),
    "PATCH /v1/projects/:project": ({ params, body }) => {
      const { default_workspace, ...rest } = body as { default_workspace?: string; name?: string };
      let p = { ...projects.get(params.project)!, ...rest };
      if (default_workspace !== undefined) p = { ...p, default_workspace_id: default_workspace || undefined };
      projects.set(p.key, p);
      return p;
    },
    "GET /v1/workspaces": { items: [docs, shop] },
    ...extra,
  };
}

describe("Settings › a Project › General", () => {
  it("renames the Project, keeps its key, and sets the defaults a Task filed in it takes", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());
    renderApp("/settings/projects/WEB/general");
    const form = await screen.findByRole("group", { name: "General settings of Web" });
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Settings/Web/General");
    expect(form).toHaveTextContent("KeyWEB");
    expect(within(form).queryByRole("textbox", { name: "Key" })).not.toBeInTheDocument();

    const name = within(form).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Website{Enter}");
    await waitFor(() => expect(writes(api.calls)).toHaveLength(1));

    const select = within(form).getByRole("combobox", { name: "Default Workspace" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /shop/ }));
    await waitFor(() => expect(writes(api.calls)).toHaveLength(2));

    await user.click(within(form).getByRole("switch", { name: "Auto-complete" }));
    await waitFor(() => expect(writes(api.calls)).toHaveLength(3));
    await user.click(within(form).getByRole("switch", { name: "Acceptance" }));
    await waitFor(() => expect(writes(api.calls)).toHaveLength(4));

    expect(writes(api.calls).map((c) => [c.path, c.body])).toEqual([
      ["/v1/projects/WEB", { name: "Website" }],
      ["/v1/projects/WEB", { default_workspace: shop.id }],
      ["/v1/projects/WEB", { auto_complete: true }],
      ["/v1/projects/WEB", { acceptance: true }],
    ]);
  });

  it("says when the Workflow has no Step carrying acceptance, so none is filed", async () => {
    const withAcceptance = workflow(web);
    withAcceptance.steps.push({ ...withAcceptance.steps[3], id: "st-accept", name: "Acceptance", skill_id: acceptance.id, position: 7 });
    mockApi(routes());
    const first = renderApp("/settings/projects/WEB/general");
    expect(await screen.findByText(/has no Step carrying acceptance/)).toBeInTheDocument();
    const form = screen.getByRole("group", { name: "General settings of Web" });
    expect(within(form).getByRole("link", { name: "Workflow" })).toHaveAttribute("href", "/settings/projects/WEB/workflow");
    first.unmount();

    mockApi(routes(undefined, { "GET /v1/projects/:project/workflow": withAcceptance }));
    renderApp("/settings/projects/WEB/general");
    expect(await screen.findByText(/confirms a Parent filed here as a whole/)).toBeInTheDocument();
    expect(screen.queryByText(/has no Step carrying acceptance/)).not.toBeInTheDocument();
  });

  it("points to Workspaces when the Install has none", async () => {
    mockApi(routes(undefined, { "GET /v1/workspaces": { items: [] } }));
    renderApp("/settings/projects/WEB/general");
    expect(await screen.findByRole("link", { name: "add one in Workspaces" })).toHaveAttribute("href", "/settings/projects/WEB/workspaces");
  });

  it("shows a Member who is not an admin the settings as text", async () => {
    mockApi(routes([ops, { ...web, default_workspace_id: shop.id, auto_complete: true }], { "GET /v1/me": me(bob) }));
    renderApp("/settings/projects/WEB/general");
    const form = await screen.findByRole("group", { name: "General settings of Web" });
    expect(await within(form).findByText("shop")).toBeInTheDocument();
    expect(form).toHaveTextContent("NameWeb");
    expect(form).toHaveTextContent("Auto-completeOn");
    expect(form).toHaveTextContent("AcceptanceOff");
    expect(within(form).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(form).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(form).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("Settings › a Project › Members", () => {
  const outsider = { ...bob, id: "m-cy", name: "cy", manager_id: undefined };
  const members = {
    "GET /v1/members/:member": ({ params }: { params: Record<string, string> }) =>
      memberDetail([ada, bob, builder, outsider].find((m) => m.id === params.member)!, { skills: params.member === bob.id ? [review] : [] }),
  };

  it("lists humans then agents with their Skills and Reporting line, and adds and removes Members", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes(undefined, {
        ...members,
        "GET /v1/members": { items: [ada, bob, builder, outsider] },
        "GET /v1/projects/:project": { project: web, members: [ada, bob, builder] },
        "PUT /v1/projects/:project/members/:member": undefined,
        "DELETE /v1/projects/:project/members/:member": undefined,
      }),
    );
    renderApp("/settings/projects/WEB/members");
    const table = await screen.findByRole("table", { name: "Members of Web" });
    expect(within(table).getByRole("rowheader", { name: "Humans 2" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Agents 1" })).toBeInTheDocument();
    const b = within(table).getByRole("row", { name: "bob" });
    expect(await within(b).findByText("review")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: "builder" })).getByText("Agent")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add Member" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Ccy" + "Human"]);
    await user.click(screen.getByRole("option", { name: /cy/ }));
    await user.click(within(b).getByRole("button", { name: "More for bob" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from Web" }));
    await waitFor(() => expect(writes(api.calls)).toHaveLength(2));
    expect(writes(api.calls).map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /v1/projects/WEB/members/m-cy", "DELETE /v1/projects/WEB/members/m-bob"]);
  });

  it("New agent makes an agent with this Project ticked", async () => {
    const user = userEvent.setup();
    mockApi(routes(undefined, members));
    renderApp("/settings/projects/OPS/members");
    await user.click(await screen.findByRole("button", { name: "New agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New agent" });
    const projects = await within(dialog).findByRole("group", { name: "Projects" });
    expect(within(projects).getByRole("checkbox", { name: "Ops" })).toBeChecked();
    expect(within(projects).getByRole("checkbox", { name: "Web" })).not.toBeChecked();
  });

  it("shows a Member who is not an admin who is in it, with nothing to change", async () => {
    mockApi(routes(undefined, { ...members, "GET /v1/me": me(bob) }));
    renderApp("/settings/projects/WEB/members");
    const table = await screen.findByRole("table", { name: "Members of Web" });
    expect(within(table).getByRole("row", { name: "ada" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New agent" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /More for/ })).not.toBeInTheDocument();
    expect(within(table).queryByRole("link")).not.toBeInTheDocument();
  });
});

/** Two open Tasks name shop, one ended Task names docs. */
const tasks: Task[] = [
  task(3, { workspace_ids: [shop.id] }),
  task(4, { workspace_ids: [shop.id, docs.id] }),
  task(5, { workspace_ids: [docs.id], state: "done", step_id: undefined }),
];
const webShop: Project = { ...web, default_workspace_id: shop.id };
const opsShop: Project = { ...ops, default_workspace_id: shop.id };

function workspaceRoutes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return routes([opsShop, webShop], {
    "GET /v1/tasks": ({ query }) => ({ items: query.get("state") === "open" ? tasks.filter((t) => t.state === "open") : tasks }),
    ...extra,
  });
}

describe("Settings › a Project › Workspaces", () => {
  it("lists each Workspace with how work lands, this Project's default, the Projects it is the default of and the open Tasks naming it", async () => {
    mockApi(workspaceRoutes());
    renderApp("/settings/projects/WEB/workspaces");
    const table = await screen.findByRole("table", { name: "Workspaces" });
    expect(within(table).getAllByRole("row").map((r) => r.getAttribute("aria-label")).filter(Boolean)).toEqual(["docs", "shop"]);

    const shopRow = within(table).getByRole("row", { name: "shop" });
    expect(within(shopRow).getByText("Default")).toBeInTheDocument();
    expect(within(shopRow).getByRole("button", { name: "Change path of shop" })).toHaveTextContent("/src/shop");
    expect(within(shopRow).getByRole("combobox", { name: "Mode of shop" })).toHaveTextContent("Local");
    expect(within(shopRow).getByRole("button", { name: "Change default branch of shop" })).toHaveTextContent("main");
    expect(await within(shopRow).findByText("2 Projects")).toBeInTheDocument();
    expect(await within(shopRow).findByText("2 Tasks")).toBeInTheDocument();

    const docsRow = within(table).getByRole("row", { name: "docs" });
    expect(within(docsRow).queryByText("Default")).not.toBeInTheDocument();
    expect(within(docsRow).getByRole("combobox", { name: "Mode of docs" })).toHaveTextContent("Pull request");
    expect(within(docsRow).getByText("None")).toBeInTheDocument();
    // The ended Task naming docs is not open.
    expect(within(docsRow).getByText("1 Task")).toBeInTheDocument();
  });

  it("makes another Workspace this Project's default from its ⋯, and clears it", async () => {
    const user = userEvent.setup();
    const api = mockApi(workspaceRoutes());
    renderApp("/settings/projects/WEB/workspaces");
    const docsRow = await screen.findByRole("row", { name: "docs" });
    await user.click(within(docsRow).getByRole("button", { name: "More for docs" }));
    await user.click(await screen.findByRole("menuitem", { name: "Make the default of Web" }));
    await waitFor(() => expect(within(screen.getByRole("row", { name: "docs" })).getByText("Default")).toBeInTheDocument());

    await user.click(within(screen.getByRole("row", { name: "docs" })).getByRole("button", { name: "More for docs" }));
    await user.click(await screen.findByRole("menuitem", { name: "Stop being the default of Web" }));
    await waitFor(() => expect(writes(api.calls)).toHaveLength(2));
    expect(writes(api.calls).map((c) => [c.path, c.body])).toEqual([
      ["/v1/projects/WEB", { default_workspace: docs.id }],
      ["/v1/projects/WEB", { default_workspace: "" }],
    ]);
  });

  it("New Workspace sends the name, the path, the mode and the default branch", async () => {
    const user = userEvent.setup();
    const api = mockApi(workspaceRoutes({ "POST /v1/workspaces": json(201, { ...docs, id: "w-api", name: "api" }) }));
    renderApp("/settings/projects/WEB/workspaces");
    await user.click(await screen.findByRole("button", { name: "New Workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New Workspace" });
    expect(within(dialog).getByLabelText("Default branch")).toHaveValue("main");
    await user.type(within(dialog).getByLabelText("Name"), "api server");
    expect(within(dialog).getByText(/starting with a letter or digit/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create Workspace" })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "api");
    await user.type(within(dialog).getByLabelText("Path"), "/src/api");
    await user.click(within(dialog).getByRole("radio", { name: "Pull request" }));
    await user.clear(within(dialog).getByLabelText("Default branch"));
    await user.type(within(dialog).getByLabelText("Default branch"), "trunk");
    await user.click(within(dialog).getByRole("button", { name: "Create Workspace" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New Workspace" })).not.toBeInTheDocument());
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/v1/workspaces");
    expect(post?.body).toEqual({ name: "api", kind: "git", path: "/src/api", mode: "pull_request", default_branch: "trunk" });
  });

  it("edits the path, the mode and the default branch in place, one field per write", async () => {
    const user = userEvent.setup();
    const api = mockApi(workspaceRoutes({ "PATCH /v1/workspaces/:workspace": ({ params, body }) => ({ ...shop, id: params.workspace, ...(body as object) }) }));
    renderApp("/settings/projects/WEB/workspaces");
    const row = await screen.findByRole("row", { name: "shop" });

    await user.click(within(row).getByRole("button", { name: "Change path of shop" }));
    const path = within(row).getByRole("textbox", { name: "Path of shop" });
    await user.clear(path);
    await user.type(path, "/srv/shop{Enter}");
    await waitFor(() => expect(writes(api.calls)).toHaveLength(1));

    await user.click(within(row).getByRole("combobox", { name: "Mode of shop" }));
    await user.click(await screen.findByRole("option", { name: "Pull request" }));
    await waitFor(() => expect(writes(api.calls)).toHaveLength(2));

    await user.click(within(row).getByRole("button", { name: "Change default branch of shop" }));
    const branch = within(row).getByRole("textbox", { name: "Default branch of shop" });
    await user.clear(branch);
    await user.type(branch, "trunk{Enter}");
    await waitFor(() => expect(writes(api.calls)).toHaveLength(3));

    // Esc puts a field back and sends nothing.
    await user.click(within(row).getByRole("button", { name: "Change path of shop" }));
    await user.type(within(row).getByRole("textbox", { name: "Path of shop" }), "/elsewhere{Escape}");

    expect(writes(api.calls).map((c) => c.path)).toEqual(Array(3).fill("/v1/workspaces/w-shop"));
    expect(writes(api.calls).map((c) => c.body)).toEqual([{ path: "/srv/shop" }, { mode: "pull_request" }, { default_branch: "trunk" }]);
  });

  it("Remove asks first and says which Project defaults it clears", async () => {
    const user = userEvent.setup();
    const api = mockApi(workspaceRoutes({ "GET /v1/tasks": { items: [] }, "DELETE /v1/workspaces/:workspace": undefined }));
    renderApp("/settings/projects/WEB/workspaces");
    const row = await screen.findByRole("row", { name: "shop" });
    await user.click(within(row).getByRole("button", { name: "More for shop" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove shop?" });
    expect(confirm).toHaveTextContent(/Clearsthe default of 2 Projects.*Ops.*Web/);
    expect(writes(api.calls)).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/v1/workspaces/w-shop")).toBe(true));
  });

  it("says in words why a Workspace Tasks name stays, before asking the server, and the server's conflict when it refuses", async () => {
    const user = userEvent.setup();
    const api = mockApi(workspaceRoutes());
    const first = renderApp("/settings/projects/WEB/workspaces");
    await user.click(within(await screen.findByRole("row", { name: "docs" })).getByRole("button", { name: "More for docs" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove docs?" });
    // An ended Task counts: the record keeps where its work was done.
    expect(await within(confirm).findByRole("alert")).toHaveTextContent(
      "conflict 2 Tasks name docs (WEB-4, WEB-5); the record keeps where their work was done, so it cannot be removed.",
    );
    expect(within(confirm).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(writes(api.calls)).toEqual([]);
    first.unmount();

    mockApi(workspaceRoutes({ "GET /v1/tasks": { items: [] }, "DELETE /v1/workspaces/:workspace": refuse(409, "conflict", "1 Task names Workspace docs") }));
    renderApp("/settings/projects/WEB/workspaces");
    await user.click(within(await screen.findByRole("row", { name: "docs" })).getByRole("button", { name: "More for docs" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const again = await screen.findByRole("dialog", { name: "Remove docs?" });
    await user.click(within(again).getByRole("button", { name: "Remove" }));
    expect(await within(again).findByRole("alert")).toHaveTextContent("Tasks name docs; the record keeps where their work was done, so it cannot be removed.");
  });

  it("shows a Member who is not an admin the Workspaces as text", async () => {
    mockApi(workspaceRoutes({ "GET /v1/me": me(bob) }));
    renderApp("/settings/projects/WEB/workspaces");
    const row = await screen.findByRole("row", { name: "shop" });
    expect(row).toHaveTextContent("/src/shop");
    expect(within(row).getByText("Local")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Workspace" })).not.toBeInTheDocument();
  });

  it("says what a Workspace is when there is none", async () => {
    mockApi(routes(undefined, { "GET /v1/workspaces": { items: [] } }));
    renderApp("/settings/projects/WEB/workspaces");
    expect(await screen.findByRole("heading", { name: "No Workspaces yet" })).toBeInTheDocument();
  });
});
