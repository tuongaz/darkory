import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Activity, Project } from "@/api/client";
import { json, mockApi, refuse, type Call } from "@/test/api";
import { FakeEventSource } from "@/test/eventSource";
import { ada, bob, builder, detail, me, ops, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { sendIntent } from "./intents";

const sidebar = () => screen.getByRole("navigation", { name: "Main" }).closest<HTMLElement>("[data-slot=sidebar]")!;
const crumbs = () => screen.getByRole("navigation", { name: "Breadcrumb" });
const switcher = () => within(sidebar()).getByRole("button", { name: /^Project:/ });
const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const sweep = task(3, { key: "OPS-3", project_id: ops.id, title: "Sweep the logs" });

// The Project last shown is remembered by the browser, and Settings' Back by the tab; each test
// starts in a fresh one.
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

async function openSwitcher() {
  await userEvent.click(switcher());
  return screen.findByRole("menu");
}

describe("the shell", () => {
  it("opens on the Inbox and draws the switcher, the places, the current Project's places and the signed-in Member", async () => {
    mockApi(signedIn());
    renderApp("/");

    const main = await screen.findByRole("navigation", { name: "Main" });
    expect(within(main).getAllByRole("link").map((l) => l.textContent)).toEqual(["Inbox", "My work"]);
    await waitFor(() => expect(within(main).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page"));
    // The signed-in Member's first Project is current.
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Project: Web"));
    const project = within(sidebar()).getByRole("navigation", { name: "Project" });
    expect(within(project).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Tasks", "/projects/WEB/tasks"],
      ["Workflow", "/projects/WEB/workflow"],
      ["Agents", "/projects/WEB/agents"],
      ["Activity", "/projects/WEB/activity"],
      ["Settings", "/settings/projects/WEB/general"],
    ]);
    expect(within(sidebar()).getByRole("button", { name: "Account: ada" })).toBeInTheDocument();
    // No caption saying what the Member is.
    expect(within(sidebar()).queryByText("Admin")).not.toBeInTheDocument();
  });

  it("says Connected once the Activity stream opens", async () => {
    mockApi(signedIn());
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    const status = within(sidebar()).getByRole("status");
    expect(status).toHaveTextContent("Connecting");
    act(() => FakeEventSource.latest().open());
    expect(status).toHaveTextContent("Connected");
  });

  it("counts the agents holding a live Claim on the current Project's Tasks beside Agents", async () => {
    const claim = (id: string, taskId: string, expires: number) => ({
      id,
      task_id: taskId,
      holder_id: builder.id,
      session_id: `s-${id}`,
      started_at: inFuture(-5),
      expires_at: inFuture(expires),
      heartbeat_timeout_seconds: 900,
    });
    const held = task(3, { claim: claim("c-1", "k-3", 15) });
    const lapsed = task(4, { claim: claim("c-2", "k-4", -1) });
    const elsewhere = task(5, { key: "OPS-5", project_id: ops.id, claim: { ...claim("c-3", "k-5", 15), holder_id: "m-other" } });
    mockApi({ ...signedIn(), "GET /v1/tasks": { items: [held, lapsed, elsewhere] } });
    renderApp("/projects/WEB/tasks");
    const project = await within(await screen.findByRole("navigation", { name: "Project" })).findByText("1 live");
    expect(project).toBeInTheDocument();
  });

  it("adds a Project to the switcher when the stream says one was created, without reloading", async () => {
    const api = mockApi(signedIn());
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    act(() => FakeEventSource.latest().open());

    const platform: Project = { ...web, id: "p-api", key: "API", name: "Platform" };
    api.routes["GET /v1/projects"] = { items: [ops, platform, web] };
    const entry: Partial<Activity> = { seq: 7, kind: "project.created", subject_type: "project", subject_id: "p-api", at: web.created_at };
    act(() => FakeEventSource.latest().emit("activity", entry, 7));

    const menu = await openSwitcher();
    expect(await within(menu).findByRole("menuitem", { name: /Platform/ })).toBeInTheDocument();
  });
});

describe("the Project switcher", () => {
  it("heads with the Organisation, lists every Project with the current one ticked, and offers New Project to an admin", async () => {
    mockApi(signedIn());
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Project: Web"));

    const menu = await openSwitcher();
    expect(within(menu).getByRole("menuitem", { name: /Acme/ })).toHaveAttribute("href", "/settings/organisation");
    const projects = within(within(menu).getByRole("group", { name: "Projects" })).getAllByRole("menuitem");
    expect(projects.map((p) => [p.textContent, p.getAttribute("aria-current")])).toEqual([
      ["OOpsOPS", null],
      ["WWebWEB", "true"],
    ]);
    expect(within(menu).getByRole("menuitem", { name: "New Project" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Switch Organisation/ })).not.toBeInTheDocument();

    // A Project picked opens the same place in it.
    await userEvent.click(projects[0]);
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Workflow"));
    expect(switcher()).toHaveAccessibleName("Project: Ops");
  });

  it("shows a Member who is not an admin the Organisation's name and the Projects, and nothing to create", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/inbox");
    await screen.findByRole("button", { name: "Account: bob" });
    const menu = await openSwitcher();
    expect(within(menu).queryByRole("menuitem", { name: /Acme/ })).not.toBeInTheDocument();
    expect(within(menu).getByText("Acme")).toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["OOpsOPS", "WWebWEB"]);
  });

  it("shows Switch Organisation only when the sign-in reaches more than one, which Local never does", async () => {
    const acme = { id: "o-1", name: "Acme" };
    for (const [organisations, shown] of [
      [undefined, false],
      [[acme], false],
      [[acme, { id: "o-2", name: "Globex" }], true],
    ] as const) {
      mockApi({ ...signedIn(), "GET /v1/me": me(ada, organisations ? { organisations: [...organisations] } : {}) });
      const view = renderApp("/inbox");
      await screen.findByRole("navigation", { name: "Main" });
      const menu = await openSwitcher();
      const item = within(menu).queryByRole("menuitem", { name: /Switch Organisation/ });
      if (!shown) expect(item).not.toBeInTheDocument();
      else {
        item!.focus();
        await userEvent.keyboard("{ArrowRight}");
        await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(2));
        const sub = screen.getAllByRole("menu").find((m) => m !== menu)!;
        const orgs = within(sub).getAllByRole("menuitem");
        expect(orgs.map((i) => i.textContent)).toEqual(["AAcme", "GGlobex"]);
        // /v1 has no operation that switches: the others are listed, not opened.
        expect(orgs[1]).toHaveAttribute("aria-disabled", "true");
      }
      view.unmount();
    }
  });

  it("opens with G then P", async () => {
    mockApi(signedIn());
    renderApp("/my-work");
    await screen.findByRole("heading", { name: "My work" });
    await userEvent.keyboard("gp");
    expect(await screen.findByRole("menu")).toHaveTextContent("Acme");
  });

  it("says there is no Project yet when the Organisation has none", async () => {
    mockApi({ ...signedIn(), "GET /v1/projects": { items: [] }, "GET /v1/me": me(ada, { projects: [] }) });
    renderApp("/inbox");
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Project: none yet"));
    expect(within(sidebar()).queryByRole("navigation", { name: "Project" })).not.toBeInTheDocument();
  });
});

describe("the current Project", () => {
  const records = () => ({
    ...signedIn(),
    "GET /v1/tasks": { items: [sweep] },
    "GET /v1/tasks/:task": detail(sweep),
  });

  it("follows the address, and this browser remembers it", async () => {
    mockApi(records());
    const first = renderApp("/projects/OPS/activity");
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Project: Ops"));
    expect(crumbs()).toHaveTextContent("Ops/Activity");
    first.unmount();

    // A new page load: the Member's first Project is Web, but Ops was the last one shown.
    renderApp("/inbox");
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Project: Ops"));
  });

  it("follows the Task whose page is open, and marks its Tasks", async () => {
    mockApi(records());
    renderApp("/tasks/OPS-3");
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Project: Ops"));
    expect(await screen.findByRole("heading", { name: "Sweep the logs" })).toBeInTheDocument();
    expect(crumbs()).toHaveTextContent("Ops/Tasks/OPS-3");
    const tasks = within(within(sidebar()).getByRole("navigation", { name: "Project" })).getByRole("link", { name: "Tasks" });
    expect(tasks).toHaveAttribute("href", "/projects/OPS/tasks");
    expect(tasks).toHaveAttribute("data-active", "true");
  });

  it("follows a Task opened in the peek from a list across Projects, and stays there once it closes", async () => {
    mockApi(records());
    renderApp("/my-work?task=OPS-3");
    const peek = await screen.findByRole("dialog", { name: "Task OPS-3" });
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Project: Ops"));
    await userEvent.click(within(peek).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "My work" })).toBeInTheDocument();
    expect(switcher()).toHaveAccessibleName("Project: Ops");
  });

  it("finds a Project by its key in any case, and says so when no Project has it", async () => {
    mockApi(signedIn());
    const first = renderApp("/projects/ops/tasks");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Tasks"));
    first.unmount();

    renderApp("/projects/NOPE/tasks");
    expect(await screen.findByRole("heading", { name: "No such Project" })).toBeInTheDocument();
    expect(screen.getByText("No Project of Acme has the key NOPE.")).toBeInTheDocument();
  });
});

describe("the addresses before Projects", () => {
  it.each([
    ["/admin", "Settings/Members"],
    ["/admin/members", "Settings/Members"],
    ["/admin/members/m-bob", "Settings/Members/bob"],
    ["/admin/skills/engineer", "Settings/Skills/engineer"],
    ["/admin/teams/OPS", "Settings/Ops/General"],
    ["/admin/workflow", "Settings/Web/Workflow"],
    ["/admin/workspaces", "Settings/Web/Workspaces"],
    ["/account", "Settings/Profile"],
    ["/teams/OPS/features", "Ops/Tasks"],
    ["/agents", "Web/Agents"],
    ["/activity", "Web/Activity"],
  ])("%s leads to %s", async (from, to) => {
    mockApi(signedIn());
    renderApp(from);
    await waitFor(() => expect(crumbs()).toHaveTextContent(to));
  });

  it("/features/:key opens the Task with that key", async () => {
    const checkout = task(1, { title: "Checkout" });
    mockApi({ ...signedIn(), "GET /v1/tasks/:task": detail(checkout) });
    renderApp("/features/WEB-1");
    expect(await screen.findByRole("heading", { name: "Checkout" })).toBeInTheDocument();
    expect(crumbs()).toHaveTextContent("Web/Tasks/WEB-1");
  });
});

describe("the signed-in Member's menu", () => {
  it("opens Account and Organisation settings, and signs out", async () => {
    let signedOut = false;
    const api = mockApi({
      ...signedIn(),
      "GET /v1/me": () => (signedOut ? refuse(401, "unauthenticated", "Sign in") : me()),
      "POST /v1/logout": () => {
        signedOut = true;
        return undefined;
      },
    });
    renderApp("/inbox");
    await userEvent.click(await screen.findByRole("button", { name: "Account: ada" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Account" })).toHaveAttribute("href", "/settings/account");
    expect(within(menu).getByRole("menuitem", { name: "Organisation settings" })).toHaveAttribute("href", "/settings/organisation");

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to Darkory" })).toBeInTheDocument();
    expect(api.calls.some((c: Call) => c.method === "POST" && c.path === "/v1/logout")).toBe(true);
  });

  it("offers no Organisation settings to a Member who is not an admin", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/inbox");
    await userEvent.click(await screen.findByRole("button", { name: "Account: bob" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Account", "Sign out"]);
  });
});

describe("the Install checklist", () => {
  it("appears in the Inbox with no Project, and Create Project opens New Project", async () => {
    mockApi({ ...signedIn(), "GET /v1/projects": { items: [] }, "GET /v1/me": me(ada, { projects: [] }), "GET /v1/members": { items: [ada] } });
    renderApp("/inbox");

    const setup = await screen.findByRole("region", { name: "Set up Acme" });
    expect(within(setup).getByRole("button", { name: "Add Member" })).toBeDisabled();
    expect(within(setup).getByRole("button", { name: "File Task" })).toBeDisabled();
    await userEvent.click(within(setup).getByRole("button", { name: "Create Project" }));
    expect(await screen.findByRole("dialog", { name: "New Project" })).toBeInTheDocument();
  });

  it("marks steps done as the Organisation fills, files into the current Project, and gives way to the Inbox once a Task is filed", async () => {
    const api = mockApi(signedIn());
    renderApp("/inbox");

    const setup = await screen.findByRole("region", { name: "Set up Acme" });
    expect(within(setup).getByLabelText("Step 1, done")).toBeInTheDocument();
    expect(within(setup).getByLabelText("Step 2, done")).toBeInTheDocument();
    expect(within(setup).getByRole("link", { name: "Add Member" })).toHaveAttribute("href", "/settings/organisation/members?new=1");
    await userEvent.click(within(setup).getByRole("button", { name: "File Task" }));
    // The Tasks screen answers the intent; its placeholder dialog names the Project.
    expect(await screen.findByRole("dialog", { name: "File a Task" })).toHaveTextContent("In WEB.");
    await userEvent.keyboard("{Escape}");

    api.routes["GET /v1/tasks"] = { items: [task(1)] };
    act(() => FakeEventSource.latest().open());
    act(() => FakeEventSource.latest().emit("activity", { seq: 9, kind: "task.filed", subject_type: "task", subject_id: "k-1", at: web.created_at }, 9));
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Set up Acme" })).not.toBeInTheDocument();
  });
});

describe("New Project", () => {
  async function open(routes = signedIn()) {
    const projects = [ops, web];
    const api = mockApi({
      ...routes,
      "GET /v1/projects": () => ({ items: projects }),
      "POST /v1/projects": ({ body }) => {
        const b = body as { key: string; name: string };
        const made = { ...web, id: "p-new", key: b.key, name: b.name };
        projects.push(made);
        return json(201, { project: made, members: [ada] });
      },
    });
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    act(() => sendIntent({ kind: "new-project" }));
    const dialog = await screen.findByRole("dialog", { name: "New Project" });
    const created = () => api.calls.find((c) => c.method === "POST" && c.path === "/v1/projects")?.body;
    return { api, dialog, created };
  }

  it("suggests the key from the name, puts you in it, starts it on the default Workflow, and opens its Tasks", async () => {
    const { dialog, created } = await open();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Payments");
    expect(within(dialog).getByLabelText("Key")).toHaveValue("PAY");
    expect(within(dialog).getByRole("radio", { name: /Default/ })).toBeChecked();
    const members = within(dialog).getByRole("group", { name: "Members" });
    expect(within(members).getAllByRole("checkbox").map((c) => [c.getAttribute("aria-label"), c.getAttribute("aria-checked")])).toEqual([
      ["ada", "true"],
      ["bob", "false"],
      ["builder", "false"],
    ]);
    await userEvent.click(within(members).getByRole("checkbox", { name: "builder" }));
    // Without Workspaces on the Install, there is nothing to pick.
    expect(within(dialog).queryByRole("combobox", { name: "Workspace" })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Create Project" }));
    await waitFor(() => expect(crumbs()).toHaveTextContent("Payments/Tasks"));
    expect(created()).toEqual({ name: "Payments", key: "PAY", workflow: "default", members: [ada.id, builder.id] });
  });

  it("copies another Project's Workflow, or starts empty, and says when a key is taken", async () => {
    const { dialog, created } = await open();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Webshop");
    expect(within(dialog).getByLabelText("Key")).toHaveValue("WEB");
    expect(within(dialog).getByText("Web has the key WEB.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create Project" })).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText("Key"));
    await userEvent.type(within(dialog).getByLabelText("Key"), "shop");
    expect(within(dialog).getByLabelText("Key")).toHaveValue("SHOP");

    await userEvent.click(within(dialog).getByRole("radio", { name: /Copy from/ }));
    // It starts from the current Project's.
    expect(within(dialog).getByRole("combobox", { name: "Copy the Workflow of" })).toHaveTextContent("Web");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create Project" }));
    await waitFor(() => expect(created()).toMatchObject({ key: "SHOP", workflow: "copy", copy_from: "WEB" }));
  });

  it("names the Workspace its Tasks work in, when the Install has any", async () => {
    const workspace = { id: "w-1", name: "enably", kind: "git", path: "/src/enably", mode: "plain", default_branch: "main", created_at: web.created_at };
    const { dialog, created } = await open({ ...signedIn(), "GET /v1/workspaces": { items: [workspace] } });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Enably");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Empty/ }));
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Workspace" }));
    await userEvent.click(await screen.findByRole("option", { name: "enably" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create Project" }));
    await waitFor(() => expect(created()).toMatchObject({ key: "ENA", workflow: "empty", default_workspace: "w-1" }));
  });
});

describe("keys", () => {
  const records = () => ({
    ...signedIn(),
    "GET /v1/tasks": {
      items: [task(3, { title: "Build the cart page" }), task(6, { title: "Review the cart page" }), task(8, { title: "Stripe keys for staging?" }), sweep],
    },
    "GET /v1/tasks/:task": ({ params }: { params: Record<string, string> }) => detail(task(Number(params.task.split("-")[1]), { title: "Build the cart page" })),
  });

  it("⌘K opens search, which finds Tasks by key and by words", async () => {
    mockApi(records());
    renderApp("/my-work");
    await screen.findByRole("heading", { name: "My work" });

    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    const input = within(search).getByRole("combobox");

    await userEvent.type(input, "WEB-8");
    expect(await within(search).findByRole("option", { name: /WEB-8 Stripe keys for staging\?/ })).toBeInTheDocument();
    expect(within(search).queryByRole("option", { name: /WEB-3/ })).not.toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, "cart page");
    expect(await within(search).findByRole("option", { name: /WEB-3 Build the cart page/ })).toBeInTheDocument();
    expect(within(search).getByRole("option", { name: /WEB-6 Review the cart page/ })).toBeInTheDocument();

    await userEvent.click(within(search).getByRole("option", { name: /WEB-3 Build the cart page/ }));
    expect(await screen.findByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Web/Tasks/WEB-3");
  });

  it("the sidebar's Search opens the same palette: the actions, the Projects to switch to, and the places", async () => {
    mockApi(records());
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Project: Web"));
    await userEvent.click(within(sidebar()).getByRole("button", { name: /Search/ }));
    const search = await screen.findByRole("dialog", { name: "Search" });
    // Each entry's words, without the keys that press it.
    const names = (group: string) =>
      within(within(search).getByRole("group", { name: group }))
        .getAllByRole("option")
        .map((o) => o.textContent?.replace(/[A-Z]+$/, ""));
    expect(names("Actions")).toEqual(["File a Task", "New Project"]);
    const projects = within(within(search).getByRole("group", { name: "Projects" })).getAllByRole("option");
    expect(projects.map((o) => o.textContent)).toEqual(["OOpsOPS", "WWebWEBCurrent"]);
    expect(names("Go to")).toEqual([
      "Inbox",
      "My work",
      "Web › Tasks",
      "Web › Tasks board",
      "Web › Workflow",
      "Web › Agents",
      "Web › Activity",
      "Settings › Account",
      "Settings › Members",
      "Settings › Agents",
      "Settings › Skills",
      "Settings › Labels",
      "Settings › Install",
      "Settings › Web",
    ]);
  });

  it("⌘K switches Project by its key, put first above the Tasks whose keys start with it", async () => {
    mockApi(records());
    renderApp("/projects/WEB/workflow");
    await screen.findByRole("navigation", { name: "Main" });
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(search).getByRole("combobox"), "OPS");
    await within(search).findByRole("option", { name: /^OpsOPS/ });
    expect([...search.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent)).toEqual(["Projects", "Tasks"]);
    expect(within(search).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Workflow"));
  });

  it("⌘K offers no Organisation settings, no New Project and no human Members to a Member who is not an admin", async () => {
    mockApi({ ...records(), "GET /v1/me": me(bob) });
    renderApp("/inbox");
    await screen.findByRole("button", { name: "Account: bob" });
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    expect(within(search).queryByRole("option", { name: "New Project" })).not.toBeInTheDocument();
    await userEvent.type(within(search).getByRole("combobox"), "a");
    await within(search).findByRole("option", { name: /Agents/ });
    expect(within(search).queryByRole("option", { name: /Settings › Members/ })).not.toBeInTheDocument();
    expect(within(search).queryByRole("option", { name: /^ada/ })).not.toBeInTheDocument();
  });

  it("⌘K offers to file words that match nothing, as a Task's title", async () => {
    mockApi(records());
    renderApp("/my-work");
    await screen.findByRole("heading", { name: "My work" });

    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(search).getByRole("combobox"), "gift wrapping");
    await userEvent.click(await within(search).findByRole("option", { name: "File a Task “gift wrapping”" }));
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("gift wrapping");
  });

  it("C files a Task in the current Project, and not while typing", async () => {
    mockApi(records());
    renderApp("/projects/OPS/activity");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Activity"));

    await userEvent.keyboard("c");
    expect(await screen.findByRole("dialog", { name: "File a Task" })).toHaveTextContent("In OPS.");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await userEvent.keyboard("{Meta>}k{/Meta}");
    await userEvent.type(within(await screen.findByRole("dialog", { name: "Search" })).getByRole("combobox"), "c");
    expect(screen.queryByRole("dialog", { name: "File a Task" })).not.toBeInTheDocument();
  });

  it("G then T, B, W and A go to the current Project's places; G I and G M to the Inbox and My work; ? lists the keys", async () => {
    mockApi(records());
    renderApp("/projects/OPS/activity");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Activity"));

    for (const [keys, to] of [
      ["gt", "Ops/Tasks"],
      ["gw", "Ops/Workflow"],
      ["ga", "Ops/Agents"],
      ["gm", "My work"],
      ["gi", "Inbox"],
    ]) {
      await userEvent.keyboard(keys);
      await waitFor(() => expect(crumbs()).toHaveTextContent(to));
    }

    await userEvent.keyboard("?");
    const sheet = await screen.findByRole("dialog", { name: "Shortcuts" });
    expect(within(sheet).getAllByRole("term").map((t) => t.textContent)).toEqual([
      "Search",
      "File a Task",
      "Switch Project",
      "Go to Inbox",
      "Go to My work",
      "Go to Tasks",
      "Go to the board",
      "Go to Workflow",
      "Go to Agents",
      "Shortcuts",
      "Next Task",
      "Previous Task",
      "Open the Task",
      "Close the Task",
      "Filter",
      "Move the focused card to another Step",
      "Add the Note",
    ]);
    // While it is open the keys are its own.
    await userEvent.keyboard("c");
    expect(screen.queryByRole("dialog", { name: "File a Task" })).not.toBeInTheDocument();
  });
});

describe("Settings", () => {
  const nav = () => screen.getByRole("navigation", { name: "Settings pages" });

  it("has its own nav, which leads Back to the page you came from", async () => {
    mockApi(signedIn());
    renderApp("/projects/OPS/workflow");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Workflow"));
    await userEvent.click(within(sidebar()).getByRole("link", { name: "Settings" }));

    await waitFor(() => expect(crumbs()).toHaveTextContent("Settings/Ops/General"));
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Profile" })).toHaveAttribute("href", "/settings/account");
    const organisation = within(nav()).getByRole("list", { name: "Organisation" });
    expect(within(organisation).getAllByRole("link").map((l) => l.textContent)).toEqual(["Members", "Agents", "Skills", "Labels", "Install"]);
    expect(within(organisation).getByRole("link", { name: "Members" })).toHaveAttribute("href", "/settings/organisation/members");
    // The Project in the address is unfolded onto its pages.
    const ops = within(nav()).getByRole("list", { name: "Ops" });
    expect(within(ops).getAllByRole("link").map((l) => l.textContent)).toEqual(["General", "Workflow", "Members", "Labels", "Workspaces"]);
    expect(within(ops).getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
    expect(within(nav()).getByRole("button", { name: "New Project" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Workflow"));
  });

  it("shows a Member who is not an admin their Account and the Projects they are in, and refuses the Organisation's pages", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/settings");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Settings/Profile"));
    expect(within(nav()).queryByRole("list", { name: "Organisation" })).not.toBeInTheDocument();
    expect(within(within(nav()).getByRole("list", { name: "Projects" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["WWeb"]);
    expect(within(nav()).queryByRole("button", { name: "New Project" })).not.toBeInTheDocument();

    renderApp("/settings/organisation/members");
    expect(await screen.findByRole("heading", { name: "Admins only" })).toBeInTheDocument();
  });
});

describe("the Task peek", () => {
  it("opens over the page for ?task= and closes back to it", async () => {
    const cart = task(3, { title: "Build the cart page" });
    mockApi({ ...signedIn(), "GET /v1/tasks/:task": detail(cart) });
    renderApp("/projects/WEB/tasks?view=board&task=WEB-3");

    const peek = await screen.findByRole("dialog", { name: "Task WEB-3" });
    expect(within(peek).getByRole("link", { name: "WEB-3" })).toHaveAttribute("href", "/tasks/WEB-3");
    await userEvent.click(within(peek).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(crumbs()).toHaveTextContent("Web/Tasks");
  });
});
