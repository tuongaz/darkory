import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Task, Team, Workspace } from "@/api/client";
import { json, mockApi, refuse, type Handler } from "@/test/api";
import { ada, bob, builder, ops, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const at = "2026-10-01T09:00:00Z";
const shop: Workspace = { id: "w-shop", name: "shop", kind: "git", path: "/src/shop", mode: "plain", default_branch: "main", created_at: at };
const docs: Workspace = { id: "w-docs", name: "docs", kind: "git", path: "/src/docs", mode: "pull_request", default_branch: "trunk", created_at: at };
const webShop: Team = { ...web, default_workspace_id: shop.id };
const opsShop: Team = { ...ops, default_workspace_id: shop.id };

/** Two open Tasks name shop, one ended Task names docs. */
const tasks: Task[] = [
  task(3, "f-1", { workspace_ids: [shop.id] }),
  task(4, "f-1", { workspace_ids: [shop.id, docs.id] }),
  task(5, "f-1", { workspace_ids: [docs.id], state: "done", status_id: "st-done" }),
];

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...signedIn(),
    "GET /v1/teams": { items: [opsShop, webShop] },
    "GET /v1/workspaces": { items: [docs, shop] },
    "GET /v1/tasks": ({ query }) => ({ items: query.get("state") === "open" ? tasks.filter((t) => t.state === "open") : tasks }),
    ...extra,
  };
}

describe("Admin › Workspaces", () => {
  it("lists each Workspace with how work lands, the Teams it is the default of and the open Tasks naming it", async () => {
    mockApi(routes());
    renderApp("/admin/workspaces");
    const table = await screen.findByRole("table", { name: "Workspaces" });
    expect(within(table).getAllByRole("row").map((r) => r.getAttribute("aria-label")).filter(Boolean)).toEqual(["docs", "shop"]);

    const shopRow = within(table).getByRole("row", { name: "shop" });
    expect(within(shopRow).getByRole("button", { name: "Change path of shop" })).toHaveTextContent("/src/shop");
    expect(within(shopRow).getByRole("combobox", { name: "Mode of shop" })).toHaveTextContent("Local");
    expect(within(shopRow).getByRole("button", { name: "Change default branch of shop" })).toHaveTextContent("main");
    expect(await within(shopRow).findByText("2 Teams")).toBeInTheDocument();
    expect(await within(shopRow).findByText("2 Tasks")).toBeInTheDocument();

    const docsRow = within(table).getByRole("row", { name: "docs" });
    expect(within(docsRow).getByRole("combobox", { name: "Mode of docs" })).toHaveTextContent("Pull request");
    expect(within(docsRow).getByText("None")).toBeInTheDocument();
    // The ended Task naming docs is not open.
    expect(within(docsRow).getByText("1 Task")).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Admin" })).getByRole("link", { name: /Workspaces/ })).toHaveTextContent("Workspaces2");
  });

  it("says what a Workspace is when there is none", async () => {
    mockApi(routes({ "GET /v1/workspaces": { items: [] } }));
    renderApp("/admin/workspaces");
    expect(await screen.findByRole("heading", { name: "No Workspaces yet" })).toBeInTheDocument();
  });

  it("New Workspace sends the name, the path, the mode and the default branch", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes({ "POST /v1/workspaces": json(201, { ...docs, id: "w-api", name: "api" }) }));
    renderApp("/admin/workspaces");
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
    const api = mockApi(routes({ "PATCH /v1/workspaces/:workspace": ({ params, body }) => ({ ...shop, id: params.workspace, ...(body as object) }) }));
    renderApp("/admin/workspaces");
    const row = await screen.findByRole("row", { name: "shop" });

    await user.click(within(row).getByRole("button", { name: "Change path of shop" }));
    const path = within(row).getByRole("textbox", { name: "Path of shop" });
    await user.clear(path);
    await user.type(path, "/srv/shop{Enter}");
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(1));

    await user.click(within(row).getByRole("combobox", { name: "Mode of shop" }));
    await user.click(await screen.findByRole("option", { name: "Pull request" }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(2));

    await user.click(within(row).getByRole("button", { name: "Change default branch of shop" }));
    const branch = within(row).getByRole("textbox", { name: "Default branch of shop" });
    await user.clear(branch);
    await user.type(branch, "trunk{Enter}");
    await waitFor(() => expect(api.calls.filter((c) => c.method === "PATCH")).toHaveLength(3));

    // Esc puts a field back and sends nothing.
    await user.click(within(row).getByRole("button", { name: "Change path of shop" }));
    await user.type(within(row).getByRole("textbox", { name: "Path of shop" }), "/elsewhere{Escape}");

    const patches = api.calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.path)).toEqual(Array(3).fill("/v1/workspaces/w-shop"));
    expect(patches.map((c) => c.body)).toEqual([{ path: "/srv/shop" }, { mode: "pull_request" }, { default_branch: "trunk" }]);
  });

  it("Remove asks first and says which Team defaults it clears", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes({ "GET /v1/tasks": { items: [] }, "DELETE /v1/workspaces/:workspace": undefined }));
    renderApp("/admin/workspaces");
    const row = await screen.findByRole("row", { name: "shop" });
    await user.click(within(row).getByRole("button", { name: "More for shop" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove shop?" });
    expect(confirm).toHaveTextContent(/Clearsthe default of 2 Teams.*Ops.*Web/);
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/v1/workspaces/w-shop")).toBe(true));
  });

  it("says in words why a Workspace Tasks name stays, before asking the server", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());
    renderApp("/admin/workspaces");
    const row = await screen.findByRole("row", { name: "docs" });
    await user.click(within(row).getByRole("button", { name: "More for docs" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove docs?" });
    // An ended Task counts: the record keeps where its work was done.
    expect(await within(confirm).findByRole("alert")).toHaveTextContent(
      "conflict 2 Tasks name docs (WEB-4, WEB-5); the record keeps where their work was done, so it cannot be removed.",
    );
    expect(within(confirm).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("shows the server's conflict in words when it refuses", async () => {
    const user = userEvent.setup();
    mockApi(
      routes({
        "GET /v1/tasks": { items: [] },
        "DELETE /v1/workspaces/:workspace": refuse(409, "conflict", "1 Task names Workspace docs; the record keeps where their work was done"),
      }),
    );
    renderApp("/admin/workspaces");
    const row = await screen.findByRole("row", { name: "docs" });
    await user.click(within(row).getByRole("button", { name: "More for docs" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove docs?" });
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(await within(confirm).findByRole("alert")).toHaveTextContent("Tasks name docs; the record keeps where their work was done, so it cannot be removed.");
  });
});

describe("a Team's defaults", () => {
  const detail = (team: Team) => ({ team, members: [ada, bob] });

  it("sets and clears the default Workspace, and the Ship-when-done default", async () => {
    const user = userEvent.setup();
    // The Team as the server keeps it: each PATCH changes what the next read returns.
    let current: Team = web;
    const api = mockApi(
      routes({
        "GET /v1/teams/:team": () => detail(current),
        "GET /v1/members/:member": ({ params }) => ({ member: [ada, bob, builder].find((m) => m.id === params.member), teams: [web], skills: [], reports: [] }),
        "PATCH /v1/teams/:team": ({ body }) => {
          const { default_workspace, ship_when_done } = body as { default_workspace?: string; ship_when_done?: boolean };
          if (default_workspace !== undefined) current = { ...current, default_workspace_id: default_workspace || undefined };
          if (ship_when_done !== undefined) current = { ...current, ship_when_done };
          return current;
        },
      }),
    );
    renderApp("/admin/teams/WEB");
    const settings = await screen.findByRole("group", { name: "Defaults of Web" });
    const select = within(settings).getByRole("combobox", { name: "Default Workspace" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent("None");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /shop/ }));
    await waitFor(() => expect(select).toHaveTextContent("shop"));

    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "None" }));
    await waitFor(() => expect(select).toHaveTextContent("None"));

    await user.click(within(settings).getByRole("switch", { name: "Ship when done" }));
    await waitFor(() => expect(within(settings).getByRole("switch", { name: "Ship when done" })).toBeChecked());

    const patches = api.calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.path)).toEqual(Array(3).fill("/v1/teams/WEB"));
    expect(patches.map((c) => c.body)).toEqual([{ default_workspace: shop.id }, { default_workspace: "" }, { ship_when_done: true }]);
  });

  it("points to Workspaces when the Install has none", async () => {
    mockApi({
      ...signedIn(),
      "GET /v1/teams/:team": detail(web),
      "GET /v1/members/:member": ({ params }) => ({ member: [ada, bob, builder].find((m) => m.id === params.member), teams: [web], skills: [], reports: [] }),
    });
    renderApp("/admin/teams/WEB");
    const settings = await screen.findByRole("group", { name: "Defaults of Web" });
    expect(await within(settings).findByRole("link", { name: "add one in Workspaces" })).toHaveAttribute("href", "/admin/workspaces");
  });
});
