import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Activity, Project } from "@/api/client";
import { json, mockApi, refuse, type Call } from "@/test/api";
import { FakeEventSource } from "@/test/eventSource";
import { ada, bob, builder, detail, me, ops, signedIn, task, web, wfId, workflowsFixture, workflowsSkills } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { sendIntent } from "./intents";

const sidebar = () => screen.getByRole("navigation", { name: "Main" }).closest<HTMLElement>("[data-slot=sidebar]")!;
const crumbs = () => screen.getByRole("navigation", { name: "Breadcrumb" });
const projectsNav = () => within(sidebar()).getByRole("navigation", { name: "Projects" });
// The current Project is the one unfolded in the sidebar's Projects (each test starts with nothing folded by hand).
const current = () => within(projectsNav()).getByRole("button", { expanded: true });
const places = (name: string) => within(within(projectsNav()).getByRole("list", { name })).getAllByRole("link");
const organisation = () => within(sidebar()).getByRole("button", { name: "Acme" });
const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const sweep = task(3, { key: "OPS-3", project_id: ops.id, title: "Sweep the logs" });

// The Project last shown and the Projects folded are remembered by the browser, and Settings' Back
// by the tab; each test starts in a fresh one.
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

async function openOrganisationMenu() {
  await userEvent.click(await screen.findByRole("button", { name: "Acme" }));
  return screen.findByRole("menu");
}

/** Opens Switch Organisation from the keyboard and returns the submenu. */
async function openSwitch(menu: HTMLElement) {
  within(menu).getByRole("menuitem", { name: /Switch Organisation/ }).focus();
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(2));
  return screen.getAllByRole("menu").find((m) => m !== menu)!;
}

describe("the shell", () => {
  it("opens on the Inbox and draws the top row, the places, and the Projects with the current one unfolded, and no footer", async () => {
    mockApi(signedIn());
    renderApp("/");

    const main = await screen.findByRole("navigation", { name: "Main" });
    expect(within(main).getAllByRole("link").map((l) => l.textContent)).toEqual(["Inbox", "My work"]);
    await waitFor(() => expect(within(main).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page"));
    // The top row: the Organisation, then Search and File a Task, as Linear's search and compose.
    expect(organisation()).toHaveAttribute("aria-haspopup", "menu");
    expect(within(sidebar()).getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(within(sidebar()).getByRole("button", { name: "File a Task" })).toBeInTheDocument();
    expect(within(sidebar()).queryByRole("button", { name: /Project:/ })).not.toBeInTheDocument();
    // The signed-in Member's first Project is current, unfolded onto its places.
    await waitFor(() => expect(current()).toHaveAccessibleName("Web"));
    expect(places("Web").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Tasks", "/projects/WEB/tasks"],
      ["Workflows", "/projects/WEB/workflows"],
      ["Agents", "/projects/WEB/agents"],
      ["Activity", "/projects/WEB/activity"],
      ["Settings", "/settings/projects/WEB/general"],
    ]);
    expect(within(projectsNav()).getByRole("button", { name: "New Project" })).toBeInTheDocument();
    // Nothing at the foot: no Member row, no caption saying what the Member is.
    expect(within(sidebar()).queryByRole("button", { name: /Account/ })).not.toBeInTheDocument();
    expect(within(sidebar()).queryByText("ada")).not.toBeInTheDocument();
    expect(within(sidebar()).queryByText("Admin")).not.toBeInTheDocument();
  });

  it("says whether live updates arrive, as a dot beside the Organisation", async () => {
    mockApi(signedIn());
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    const status = within(sidebar()).getByRole("status");
    expect(status).toHaveTextContent("Connecting…");
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
    const agents = await within(await screen.findByRole("list", { name: "Web" })).findByRole("link", { name: /Agents/ });
    await waitFor(() => expect(agents).toHaveTextContent("Agents1 live"));
  });

  it("adds a Project to the Projects when the stream says one was created with the Member in it, without reloading", async () => {
    const api = mockApi(signedIn());
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    act(() => FakeEventSource.latest().open());
    await waitFor(() => expect(current()).toHaveAccessibleName("Web"));

    const platform: Project = { ...web, id: "p-api", key: "API", name: "Platform" };
    api.routes["GET /v1/projects"] = { items: [ops, platform, web] };
    api.routes["GET /v1/me"] = me(ada, { projects: [platform, web] });
    const entry: Partial<Activity> = { seq: 7, kind: "project.created", subject_type: "project", subject_id: "p-api", at: web.created_at };
    act(() => FakeEventSource.latest().emit("activity", entry, 7));

    expect(await within(projectsNav()).findByRole("button", { name: "Platform" })).toBeInTheDocument();
  });
});

describe("the Projects", () => {
  it("lists the Projects the Member is in, by name, and the current one when the Member is not in it", async () => {
    mockApi({ ...signedIn(), "GET /v1/me": me(ada, { projects: [web] }) });
    const first = renderApp("/inbox");
    await waitFor(() => expect(current()).toHaveAccessibleName("Web"));
    expect(within(projectsNav()).getAllByRole("button").map((b) => b.textContent)).toEqual(["WWeb", "New Project"]);
    first.unmount();

    // An admin may open a Project they are not in: it shows while it is current.
    renderApp("/projects/OPS/workflows");
    await waitFor(() => expect(current()).toHaveAccessibleName("Ops"));
    expect(within(projectsNav()).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-expanded")])).toEqual([
      ["OOps", "true"],
      ["WWeb", "false"],
      ["New Project", null],
    ]);
  });

  it("unfolds and folds a Project, and this browser remembers it; becoming current unfolds one", async () => {
    mockApi({ ...signedIn(), "GET /v1/me": me(ada, { projects: [ops, web] }) });
    const first = renderApp("/projects/WEB/tasks");
    await waitFor(() => expect(current()).toHaveAccessibleName("Web"));
    const opsRow = within(projectsNav()).getByRole("button", { name: "Ops" });
    expect(opsRow).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(opsRow);
    expect(opsRow).toHaveAttribute("aria-expanded", "true");
    expect(places("Ops").map((l) => l.textContent)).toEqual(["Tasks", "Workflows", "Agents", "Activity", "Settings"]);
    // The current one folds too.
    await userEvent.click(within(projectsNav()).getByRole("button", { name: "Web" }));
    expect(within(projectsNav()).queryByRole("list", { name: "Web" })).not.toBeInTheDocument();
    first.unmount();

    // A new page load: Ops as it was left.
    const second = renderApp("/projects/OPS/tasks");
    await waitFor(() => expect(within(projectsNav()).getByRole("button", { name: "Ops" })).toHaveAttribute("aria-expanded", "true"));
    expect(within(projectsNav()).getByRole("button", { name: "Web" })).toHaveAttribute("aria-expanded", "false");
    second.unmount();

    // Going to a folded Project unfolds it.
    renderApp("/projects/WEB/tasks");
    await waitFor(() => expect(within(projectsNav()).getByRole("button", { name: "Web" })).toHaveAttribute("aria-expanded", "true"));
  });

  it("gives a Member who is not an admin their Projects and nothing to create", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/inbox");
    await waitFor(() => expect(current()).toHaveAccessibleName("Web"));
    expect(within(projectsNav()).queryByRole("button", { name: "New Project" })).not.toBeInTheDocument();
  });

  it("New Project opens the dialog", async () => {
    mockApi(signedIn());
    renderApp("/inbox");
    await userEvent.click(await within(await screen.findByRole("navigation", { name: "Projects" })).findByRole("button", { name: "New Project" }));
    expect(await screen.findByRole("dialog", { name: "New Project" })).toBeInTheDocument();
  });

  it("G then P focuses the current Project's row", async () => {
    mockApi(signedIn());
    renderApp("/my-work");
    await screen.findByRole("heading", { name: "My work" });
    await waitFor(() => expect(current()).toHaveAccessibleName("Web"));
    await userEvent.keyboard("gp");
    await waitFor(() => expect(current()).toHaveFocus());
  });

  it("says there is no Project yet when the Member has none", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/projects": { items: [] }, "GET /v1/me": me(bob, { projects: [] }) });
    renderApp("/inbox");
    expect(await within(await screen.findByRole("navigation", { name: "Projects" })).findByText("No Projects yet")).toBeInTheDocument();
    expect(within(projectsNav()).queryAllByRole("button")).toEqual([]);
  });
});

describe("the Organisation menu", () => {
  it("offers Settings, Invite and manage Members, Switch Organisation and Log out, with their keys", async () => {
    mockApi(signedIn());
    renderApp("/inbox");
    const menu = await openOrganisationMenu();
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "SettingsG then S",
      "Invite and manage Members",
      "Switch OrganisationO then W",
      expect.stringMatching(/^Log out(⌥⇧Q|Alt Shift Q)$/),
    ]);
    // An admin's Settings opens on the Organisation.
    expect(within(menu).getByRole("menuitem", { name: /^Settings/ })).toHaveAttribute("href", "/settings/organisation/members");
    expect(within(menu).getByRole("menuitem", { name: "Invite and manage Members" })).toHaveAttribute("href", "/settings/organisation/members");
    await userEvent.click(within(menu).getByRole("menuitem", { name: /^Settings/ }));
    await waitFor(() => expect(crumbs()).toHaveTextContent("Settings/Members"));
  });

  it("Switch Organisation names the sign-in, lists the one Organisation on Local ticked, and leads to Account settings", async () => {
    mockApi({ ...signedIn(), "GET /v1/me": me({ ...ada, email: "ada@acme.example" }) });
    renderApp("/inbox");
    const sub = await openSwitch(await openOrganisationMenu());
    expect(sub).toHaveTextContent(/^ada@acme\.exampleAAcmeAccount settings$/);
    const [acme, account] = within(sub).getAllByRole("menuitem");
    expect(acme).toHaveAttribute("aria-current", "true");
    expect(acme).not.toHaveAttribute("aria-disabled");
    expect(account).toHaveAttribute("href", "/settings/account");
    await userEvent.click(account);
    await waitFor(() => expect(crumbs()).toHaveTextContent("Settings/Account"));
  });

  it("lists every Organisation the sign-in reaches, the others not opened, since /v1 cannot switch", async () => {
    mockApi({ ...signedIn(), "GET /v1/me": me(ada, { organisations: [{ id: "o-1", name: "Acme" }, { id: "o-2", name: "Globex" }] }) });
    renderApp("/inbox");
    const sub = await openSwitch(await openOrganisationMenu());
    const orgs = within(sub).getAllByRole("menuitem").slice(0, 2);
    expect(orgs.map((i) => [i.textContent, i.getAttribute("aria-disabled")])).toEqual([
      ["AAcme", null],
      ["GGlobex", "true"],
    ]);
  });

  it("O then W opens it on Switch Organisation", async () => {
    mockApi(signedIn());
    renderApp("/my-work");
    await screen.findByRole("heading", { name: "My work" });
    await userEvent.keyboard("ow");
    await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(2));
    expect(screen.getAllByRole("menu")[1]).toHaveTextContent("Account settings");
  });

  it("gives a Member who is not an admin no Invite, and Settings on their Account", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/inbox");
    const menu = await openOrganisationMenu();
    expect(within(menu).getByRole("menuitem", { name: /^Settings/ })).toHaveAttribute("href", "/settings/account");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.replace(/(G then S|O then W|⌥⇧Q|Alt Shift Q)$/, ""))).toEqual([
      "Settings",
      "Switch Organisation",
      "Log out",
    ]);
  });

  it("logs out from the menu, and with ⌥⇧Q", async () => {
    for (const how of ["menu", "keys"] as const) {
      let signedOut = false;
      const api = mockApi({
        ...signedIn(),
        "GET /v1/me": () => (signedOut ? refuse(401, "unauthenticated", "Sign in") : me()),
        "POST /v1/logout": () => {
          signedOut = true;
          return undefined;
        },
      });
      const view = renderApp("/inbox");
      if (how === "menu") await userEvent.click(within(await openOrganisationMenu()).getByRole("menuitem", { name: /^Log out/ }));
      else {
        await screen.findByRole("navigation", { name: "Main" });
        await userEvent.keyboard("{Alt>}{Shift>}Q{/Shift}{/Alt}");
      }
      expect(await screen.findByRole("heading", { name: "Sign in to Darkory" })).toBeInTheDocument();
      expect(api.calls.some((c: Call) => c.method === "POST" && c.path === "/v1/logout")).toBe(true);
      view.unmount();
    }
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
    await waitFor(() => expect(current()).toHaveAccessibleName("Ops"));
    expect(crumbs()).toHaveTextContent("Ops/Activity");
    first.unmount();

    // A new page load: the Member's first Project is Web, but Ops was the last one shown.
    renderApp("/inbox");
    await waitFor(() => expect(current()).toHaveAccessibleName("Ops"));
  });

  it("follows the Task whose page is open, and marks its Tasks", async () => {
    mockApi(records());
    renderApp("/tasks/OPS-3");
    await waitFor(() => expect(current()).toHaveAccessibleName("Ops"));
    expect(await screen.findByRole("heading", { name: "Sweep the logs" })).toBeInTheDocument();
    expect(crumbs()).toHaveTextContent("Ops/Tasks/OPS-3");
    const tasks = places("Ops").find((l) => l.textContent === "Tasks")!;
    expect(tasks).toHaveAttribute("href", "/projects/OPS/tasks");
    expect(tasks).toHaveAttribute("data-active", "true");
  });

  it("follows a Task opened in the peek from a list across Projects, and stays there once it closes", async () => {
    mockApi(records());
    renderApp("/my-work?task=OPS-3");
    const peek = await screen.findByRole("dialog", { name: "Task OPS-3" });
    await waitFor(() => expect(current()).toHaveAccessibleName("Ops"));
    await userEvent.click(within(peek).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "My work" })).toBeInTheDocument();
    expect(current()).toHaveAccessibleName("Ops");
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
    ["/account", "Settings/Account"],
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

describe("the Install checklist", () => {
  it("appears in the Inbox with no Project, and its New Project opens the dialog", async () => {
    mockApi({ ...signedIn(), "GET /v1/projects": { items: [] }, "GET /v1/me": me(ada, { projects: [] }), "GET /v1/members": { items: [ada] } });
    renderApp("/inbox");

    const setup = await screen.findByRole("region", { name: "Set up Acme" });
    expect(within(setup).getByRole("button", { name: "Add Member" })).toBeDisabled();
    expect(within(setup).getByRole("button", { name: "File Task" })).toBeDisabled();
    await userEvent.click(within(setup).getByRole("button", { name: "New Project" }));
    expect(await screen.findByRole("dialog", { name: "New Project" })).toBeInTheDocument();
  });

  it("marks steps done as the Organisation fills, files into the current Project, and gives way to the Inbox once a Task is filed", async () => {
    const api = mockApi(signedIn());
    renderApp("/inbox");

    const setup = await screen.findByRole("region", { name: "Set up Acme" });
    expect(within(setup).getByLabelText("1 of 3, done")).toBeInTheDocument();
    expect(within(setup).getByLabelText("2 of 3, done")).toBeInTheDocument();
    // The Project there is named, done; New Project makes another. Its items are not "steps":
    // Step is a Workflow's word, which only item 3's help uses, for one.
    expect(setup).toHaveTextContent("Project: Web");
    expect(within(setup).getByRole("button", { name: "New Project" })).toBeInTheDocument();
    expect(within(setup).queryByRole("button", { name: "Create Project" })).not.toBeInTheDocument();
    expect(setup).not.toHaveTextContent(/\bsteps\b|step \d/i);
    expect(within(setup).queryAllByLabelText(/step/i)).toEqual([]);
    expect(within(setup).getByRole("link", { name: "Add Member" })).toHaveAttribute("href", "/settings/organisation/members?new=1");
    await userEvent.click(within(setup).getByRole("button", { name: "File Task" }));
    // The Tasks screen answers the intent; its placeholder dialog names the Project.
    expect(within(await screen.findByRole("dialog", { name: "File a Task" })).getByRole("combobox", { name: "Project" })).toHaveTextContent("Web");
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
    await waitFor(() => expect(current()).toHaveAccessibleName("Web"));
    await userEvent.click(within(sidebar()).getByRole("button", { name: "Search" }));
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
      "Web › Workflows",
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
    renderApp("/projects/WEB/workflows");
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

  it("⌘K goes to each Workflow's board of a Project of several", async () => {
    mockApi({ ...records(), "GET /v1/projects/:project/workflow": workflowsFixture(), "GET /v1/skills": { items: workflowsSkills } });
    renderApp("/projects/WEB/tasks");
    await screen.findByRole("navigation", { name: "Main" });
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    const goTo = () =>
      within(within(search).getByRole("group", { name: "Go to" }))
        .getAllByRole("option")
        .map((o) => o.textContent?.replace(/[A-Z]+$/, ""));
    await waitFor(() => expect(goTo()).toContain("Web › Bugs board"));
    expect(goTo().filter((n) => n?.endsWith("board"))).toEqual(["Web › Triage board", "Web › Bugs board", "Web › Features board", "Web › Prototypes board", "Web › Support board"]);
    await userEvent.click(within(search).getByRole("option", { name: "Web › Bugs board" }));
    expect(await screen.findByRole("button", { name: "Workflow: Bugs" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Investigate" })).toBeInTheDocument();
  });

  it("⌘K shows G B on the board of the Workflow this browser last picked", async () => {
    localStorage.setItem("darkory.workflow.WEB", wfId.support);
    mockApi({ ...records(), "GET /v1/projects/:project/workflow": workflowsFixture(), "GET /v1/skills": { items: workflowsSkills } });
    renderApp("/projects/WEB/tasks");
    await screen.findByRole("navigation", { name: "Main" });
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    const entry = (name: string) => within(search).getByRole("option", { name: new RegExp(`^${name}`) });
    await waitFor(() => expect(entry("Web › Support board")).toBeInTheDocument());
    expect(entry("Web › Support board").textContent).toMatch(/GB$/);
    expect(entry("Web › Triage board").textContent).toBe("Web › Triage board");
  });

  it("⌘K opens the Workflows with G W, and each Workflow's page by its name when there are two or more", async () => {
    mockApi({ ...records(), "GET /v1/projects/:project/workflow": workflowsFixture(), "GET /v1/skills": { items: workflowsSkills } });
    renderApp("/projects/WEB/tasks");
    await screen.findByRole("navigation", { name: "Main" });
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    const entry = (name: string) => within(search).getByRole("option", { name: new RegExp(`^${name}(G.)?$`) });
    await waitFor(() => expect(entry("Web › Bugs")).toBeInTheDocument());
    expect(entry("Web › Workflows").textContent).toMatch(/GW$/);
    expect(within(search).getAllByRole("option", { name: /^Web › (Triage|Bugs|Features|Prototypes|Support)$/ }).map((o) => o.textContent)).toEqual([
      "Web › Triage",
      "Web › Bugs",
      "Web › Features",
      "Web › Prototypes",
      "Web › Support",
    ]);
    await userEvent.click(entry("Web › Bugs"));
    expect(await screen.findByRole("button", { name: "Workflow: Bugs" })).toBeInTheDocument();
  });

  it("⌘K offers no Organisation settings, no New Project and no human Members to a Member who is not an admin", async () => {
    mockApi({ ...records(), "GET /v1/me": me(bob) });
    renderApp("/inbox");
    await waitFor(() => expect(current()).toHaveAccessibleName("Web"));
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

  it("the sidebar's File a Task files one in the current Project", async () => {
    mockApi(records());
    renderApp("/projects/OPS/activity");
    await waitFor(() => expect(current()).toHaveAccessibleName("Ops"));
    await userEvent.click(within(sidebar()).getByRole("button", { name: "File a Task" }));
    expect(within(await screen.findByRole("dialog", { name: "File a Task" })).getByRole("combobox", { name: "Project" })).toHaveTextContent("Ops");
  });

  it("C files a Task in the current Project, and not while typing", async () => {
    mockApi(records());
    renderApp("/projects/OPS/activity");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Activity"));

    await userEvent.keyboard("c");
    expect(within(await screen.findByRole("dialog", { name: "File a Task" })).getByRole("combobox", { name: "Project" })).toHaveTextContent("Ops");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await userEvent.keyboard("{Meta>}k{/Meta}");
    await userEvent.type(within(await screen.findByRole("dialog", { name: "Search" })).getByRole("combobox"), "c");
    expect(screen.queryByRole("dialog", { name: "File a Task" })).not.toBeInTheDocument();
  });

  it("G then T, B, W and A go to the current Project's places; G I, G M and G S to the Inbox, My work and Settings; ? lists the keys", async () => {
    mockApi(records());
    renderApp("/projects/OPS/activity");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Activity"));

    for (const [keys, to] of [
      ["gt", "Ops/Tasks"],
      ["gw", "Ops/Workflow"],
      ["ga", "Ops/Agents"],
      ["gm", "My work"],
      ["gi", "Inbox"],
      ["gs", "Settings/Members"],
    ]) {
      await userEvent.keyboard(keys);
      await waitFor(() => expect(crumbs()).toHaveTextContent(to));
    }

    await userEvent.keyboard("?");
    const sheet = await screen.findByRole("dialog", { name: "Shortcuts" });
    expect(within(sheet).getAllByRole("term").map((t) => t.textContent)).toEqual([
      "Search",
      "File a Task",
      "Go to the Projects in the sidebar",
      "Go to Inbox",
      "Go to My work",
      "Go to Tasks",
      "Go to the board",
      "Go to Workflows",
      "Go to Agents",
      "Go to Settings",
      "Switch Organisation",
      "Log out",
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
    renderApp("/projects/OPS/workflows");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Workflow"));
    await userEvent.click(within(sidebar()).getByRole("link", { name: "Settings" }));

    await waitFor(() => expect(crumbs()).toHaveTextContent("Settings/Ops/General"));
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Account" })).toHaveAttribute("href", "/settings/account");
    const organisation = within(nav()).getByRole("list", { name: "Organisation" });
    expect(within(organisation).getAllByRole("link").map((l) => l.textContent)).toEqual(["Members", "Agents", "Skills", "Labels", "Install"]);
    expect(within(organisation).getByRole("link", { name: "Members" })).toHaveAttribute("href", "/settings/organisation/members");
    // The Project in the address is unfolded onto its pages.
    const ops = within(nav()).getByRole("list", { name: "Ops" });
    expect(within(ops).getAllByRole("link").map((l) => l.textContent)).toEqual(["General", "Workflows", "Members", "Labels", "Workspaces"]);
    expect(within(ops).getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
    expect(within(nav()).getByRole("button", { name: "New Project" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(crumbs()).toHaveTextContent("Ops/Workflow"));
  });

  it("shows a Member who is not an admin their Account and the Projects they are in, and refuses the Organisation's pages", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/settings");
    await waitFor(() => expect(crumbs()).toHaveTextContent("Settings/Account"));
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
