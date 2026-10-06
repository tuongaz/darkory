import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Activity } from "@/api/client";
import { mockApi } from "@/test/api";
import { FakeEventSource } from "@/test/eventSource";
import { ada, bob, builder, feature, me, ops, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { sendIntent } from "./intents";

const sidebar = () => screen.getByRole("navigation", { name: "Main" }).closest<HTMLElement>("[data-slot=sidebar]")!;
const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

// The Team last shown is remembered by the browser; each test starts in a fresh one.
beforeEach(() => localStorage.clear());

describe("the shell", () => {
  it("opens on the Inbox and draws the sidebar's places, Teams and the signed-in Member", async () => {
    mockApi(signedIn());
    renderApp("/");

    const main = await screen.findByRole("navigation", { name: "Main" });
    for (const name of ["Inbox", "My work", "Agents", "Activity"]) expect(within(main).getByRole("link", { name })).toBeInTheDocument();
    await waitFor(() => expect(within(main).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page"));
    expect(await within(sidebar()).findByRole("button", { name: "Web" })).toBeInTheDocument();
    expect(within(sidebar()).getByRole("button", { name: "Ops" })).toBeInTheDocument();
    // The signed-in Member's first Team is unfolded.
    expect(within(sidebar()).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/teams/WEB/tasks");
    expect(within(sidebar()).getByRole("link", { name: "Features" })).toHaveAttribute("href", "/teams/WEB/features");
    expect(within(sidebar()).getByRole("link", { name: "Account, ada" })).toHaveAttribute("href", "/account");
  });

  it("shows Admin to an admin only", async () => {
    mockApi(signedIn());
    const first = renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    expect(within(sidebar()).getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
    first.unmount();

    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/inbox");
    await screen.findByRole("link", { name: "Account, bob" });
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("says Connected once the Activity stream opens", async () => {
    mockApi(signedIn());
    renderApp("/inbox");
    const status = await within(await screen.findByRole("link", { name: "Account, ada" })).findByRole("status");
    expect(status).toHaveTextContent("Connecting");
    act(() => FakeEventSource.latest().open());
    expect(status).toHaveTextContent("Connected");
  });

  it("counts the agents holding a live Claim beside Agents", async () => {
    const held = task(3, "f-1", { claim: { id: "c-1", task_id: "k-3", holder_id: builder.id, session_id: "s-1", started_at: inFuture(-1), expires_at: inFuture(15), heartbeat_timeout_seconds: 900 } });
    const lapsed = task(4, "f-1", { claim: { id: "c-2", task_id: "k-4", holder_id: builder.id, session_id: "s-2", started_at: inFuture(-5), expires_at: inFuture(-1), heartbeat_timeout_seconds: 2 } });
    mockApi({ ...signedIn(), "GET /v1/tasks": { items: [held, lapsed] } });
    renderApp("/inbox");
    expect(await within(await screen.findByRole("navigation", { name: "Main" })).findByText("1 live")).toBeInTheDocument();
  });

  it("adds a Team to the sidebar when the stream says one was created, without reloading", async () => {
    const api = mockApi({ ...signedIn(), "GET /v1/teams": { items: [web] } });
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    await within(sidebar()).findByRole("button", { name: "Web" });
    act(() => FakeEventSource.latest().open());

    api.routes["GET /v1/teams"] = { items: [web, { id: "t-api", key: "API", name: "Platform", created_at: web.created_at }] };
    const entry: Partial<Activity> = { seq: 7, kind: "team.created", subject_type: "team", subject_id: "t-api", at: web.created_at };
    act(() => FakeEventSource.latest().emit("activity", entry, 7));

    expect(await within(sidebar()).findByRole("button", { name: "Platform" })).toBeInTheDocument();
  });
});

describe("the sidebar on a record's page", () => {
  const chores = feature(4, 1, { key: "OPS-1", team_id: ops.id, title: "Chores" });
  const sweep = task(3, chores.id, { key: "OPS-3", title: "Sweep the logs" });
  const statuses = [{ id: "st-todo", name: "Todo", kind: "todo", position: 1 }];
  const records = () => ({
    ...signedIn(),
    "GET /v1/statuses": { items: statuses },
    "GET /v1/features": { items: [chores] },
    "GET /v1/tasks": { items: [sweep] },
    "GET /v1/tasks/takeable": { items: [] },
    "GET /v1/activity": { items: [], last_seq: 0 },
    "GET /v1/tasks/:task": { task: sweep, status: statuses[0], feature: chores, claims: [], notes: [], evidence: [], blockers: [], blocking: [], observations: [] },
    "GET /v1/features/:feature": { feature: chores, tasks: [sweep], evidence: [] },
    "GET /v1/teams/:team": { team: ops, members: [me().member] },
    "GET /v1/members/:member": { member: me().member, teams: [web], skills: [], reports: [] },
  });
  const subItem = (name: string) => within(sidebar()).getByRole("link", { name }).closest("[data-active]");

  it("opens the Task's Team, not the Member's first, and marks its Tasks", async () => {
    mockApi(records());
    renderApp("/tasks/OPS-3");
    expect(await screen.findByRole("heading", { name: "Sweep the logs", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(within(sidebar()).getByRole("button", { name: "Ops" })).toHaveAttribute("aria-expanded", "true"));
    expect(within(sidebar()).getByRole("button", { name: "Web" })).toHaveAttribute("aria-expanded", "false");
    expect(within(sidebar()).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/teams/OPS/tasks");
    expect(subItem("Tasks")).toHaveAttribute("data-active", "true");
    expect(subItem("Features")).toHaveAttribute("data-active", "false");
  });

  it("opens the Feature's Team and marks its Features", async () => {
    mockApi(records());
    renderApp("/features/OPS-1");
    await waitFor(() => expect(within(sidebar()).getByRole("button", { name: "Ops" })).toHaveAttribute("aria-expanded", "true"));
    expect(within(sidebar()).getByRole("link", { name: "Features" })).toHaveAttribute("href", "/teams/OPS/features");
    await waitFor(() => expect(subItem("Features")).toHaveAttribute("data-active", "true"));
    expect(subItem("Tasks")).toHaveAttribute("data-active", "false");
  });

  it("G B opens the board of the Team last visited in this browser", async () => {
    mockApi(records());
    const first = renderApp("/tasks/OPS-3");
    await screen.findByRole("heading", { name: "Sweep the logs", level: 1 });
    await waitFor(() => expect(within(sidebar()).getByRole("button", { name: "Ops" })).toHaveAttribute("aria-expanded", "true"));
    first.unmount();

    // A new page load: the Member's first Team is Web, but Ops was the last one shown.
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    await userEvent.keyboard("gb");
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Ops/Tasks"));
    expect(screen.getByRole("heading", { name: "Tasks, board" })).toBeInTheDocument();
  });
});

describe("the Install checklist", () => {
  it("appears in the Inbox when there are no Teams, with the first step to do", async () => {
    mockApi({ ...signedIn(), "GET /v1/teams": { items: [] }, "GET /v1/members": { items: [me().member] } });
    renderApp("/inbox");

    const setup = await screen.findByRole("region", { name: "Set up Acme" });
    expect(within(setup).getByRole("link", { name: "Create Team" })).toHaveAttribute("href", "/admin/teams?new=1");
    expect(within(setup).getByRole("button", { name: "Add Member" })).toBeDisabled();
    expect(within(setup).getByRole("button", { name: "File Feature" })).toBeDisabled();
    // The sidebar offers the same first step in place of the Teams.
    expect(within(sidebar()).getByRole("link", { name: "Create a Team" })).toHaveAttribute("href", "/admin/teams?new=1");
  });

  it("marks steps done as the Organisation fills, and gives way to the Inbox once a Feature is filed", async () => {
    const api = mockApi(signedIn());
    renderApp("/inbox");

    const setup = await screen.findByRole("region", { name: "Set up Acme" });
    expect(within(setup).getByLabelText("Step 1, done")).toBeInTheDocument();
    expect(within(setup).getByLabelText("Step 2, done")).toBeInTheDocument();
    await userEvent.click(within(setup).getByRole("button", { name: "File Feature" }));
    // The Board screen answers the intent; its placeholder dialog says so.
    expect(await screen.findByRole("dialog", { name: "File a Feature" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    api.routes["GET /v1/features"] = { items: [feature(1, 1)] };
    act(() => FakeEventSource.latest().open());
    act(() => FakeEventSource.latest().emit("activity", { seq: 9, kind: "feature.filed", subject_type: "feature", subject_id: "f-1", at: web.created_at }, 9));
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Set up Acme" })).not.toBeInTheDocument();
  });
});

describe("keys", () => {
  const records = () => ({
    ...signedIn(),
    "GET /v1/tasks": { items: [task(3, "f-1", { title: "Build the cart page" }), task(6, "f-1", { title: "Review the cart page" }), task(8, "f-1", { title: "Stripe keys for staging?" })] },
    "GET /v1/features": { items: [feature(1, 1, { title: "Checkout flow" })] },
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
    expect(await screen.findByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("WEB-3");
  });

  it("the sidebar's Search opens the same palette, with the actions", async () => {
    mockApi(records());
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    await userEvent.click(within(sidebar()).getByRole("button", { name: /Search/ }));
    const search = await screen.findByRole("dialog", { name: "Search" });
    expect(within(search).getByRole("option", { name: /File a Task/ })).toBeInTheDocument();
    const goTo = within(search).getByRole("group", { name: "Go to" });
    const places = within(goTo).getAllByRole("option").map((o) => o.textContent?.replace(/[GIMAB]+$/, ""));
    expect(places).toEqual([
      "Inbox",
      "My work",
      "Agents",
      "Activity",
      "Ops › Tasks",
      "Ops › Features",
      "Web › Tasks",
      "Web › Tasks board",
      "Web › Features",
      "Admin › Members",
      "Admin › Teams",
      "Admin › Skills",
      "Admin › Workflow",
      "Account",
    ]);
  });

  it("⌘K puts the record whose key is typed whole first, whichever group holds it", async () => {
    const checkout = feature(1, 1, { title: "Checkout" });
    mockApi({
      ...records(),
      "GET /v1/features": { items: [checkout] },
      "GET /v1/tasks": { items: [10, 11, 12].map((n) => task(n, checkout.id, { title: `Polish ${n}` })) },
    });
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(search).getByRole("combobox"), "WEB-1");
    await within(search).findByRole("option", { name: /WEB-1 Checkout/ });

    expect([...search.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent)).toEqual(["Features", "Tasks"]);
    const options = within(search).getAllByRole("option");
    expect(options[0]).toHaveTextContent(/^WEB-1\s*Checkout/);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options.slice(1).map((o) => /WEB-\d+/.exec(o.textContent ?? "")?.[0])).toEqual(["WEB-10", "WEB-11", "WEB-12"]);
  });

  it("⌘K finds Members: an agent opens its peek on Agents, a human their Member page for an admin", async () => {
    mockApi({
      ...records(),
      "GET /v1/members/:member": ({ params }: { params: Record<string, string> }) => ({
        member: [ada, bob, builder].find((m) => m.id === params.member || m.name === params.member),
        teams: [web],
        skills: [],
        reports: [],
      }),
      "GET /v1/members/:member/tokens": { items: [] },
      "GET /v1/members/:member/sessions": { items: [] },
      "GET /v1/activity": { items: [], last_seq: 0 },
    });
    renderApp("/inbox");
    await screen.findByRole("navigation", { name: "Main" });

    await userEvent.keyboard("{Meta>}k{/Meta}");
    let search = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(search).getByRole("combobox"), "builder");
    await userEvent.click(await within(search).findByRole("option", { name: /builder.*Agent/ }));
    expect(await screen.findByRole("dialog", { name: "Agent builder" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();

    await userEvent.keyboard("{Meta>}k{/Meta}");
    search = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(search).getByRole("combobox"), "bob");
    await userEvent.click(await within(search).findByRole("option", { name: /bob.*Human/ }));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(/Admin.*Members.*bob/));
  });

  it("⌘K offers no Admin pages and no human Members to a Member who is not an admin", async () => {
    mockApi({ ...records(), "GET /v1/me": me(bob) });
    renderApp("/inbox");
    await screen.findByRole("link", { name: "Account, bob" });
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(search).getByRole("combobox"), "a");
    await within(search).findByRole("option", { name: /Agents/ });
    expect(within(search).queryByRole("option", { name: /Admin ›/ })).not.toBeInTheDocument();
    expect(within(search).queryByRole("option", { name: /ada/ })).not.toBeInTheDocument();
  });

  it("C opens File Task, and not while typing", async () => {
    mockApi(records());
    renderApp("/my-work");
    await screen.findByRole("heading", { name: "My work" });

    await userEvent.keyboard("c");
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    // It files into the current Team, whose chip heads it.
    expect(dialog).toHaveTextContent(/^W?Web\s*File a Task/);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await userEvent.keyboard("{Meta>}k{/Meta}");
    await userEvent.type(within(await screen.findByRole("dialog", { name: "Search" })).getByRole("combobox"), "c");
    expect(screen.queryByRole("dialog", { name: "File a Task" })).not.toBeInTheDocument();
  });

  it("G then B opens the current Team's board", async () => {
    mockApi(records());
    renderApp("/activity");
    await screen.findByRole("heading", { name: "Activity" });

    await userEvent.keyboard("gb");
    expect(await screen.findByRole("heading", { name: "Tasks, board" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Web/Tasks");
  });
});

describe("walking the Tasks with the keys", () => {
  const statuses = [
    { id: "st-todo", name: "Todo", kind: "todo", position: 1 },
    { id: "st-done", name: "Done", kind: "done", position: 2 },
  ];
  const checkout = feature(1, 1, { title: "Checkout flow" });
  const tasks = [3, 6, 8].map((n, i) => task(n, checkout.id, { title: `Task ${n}`, waiting_since: `2026-10-01T09:0${i}:00Z` }));
  const records = () => ({
    ...signedIn(),
    "GET /v1/statuses": { items: statuses },
    "GET /v1/features": { items: [checkout] },
    "GET /v1/tasks": { items: tasks },
    "GET /v1/tasks/takeable": { items: [] },
    "GET /v1/activity": { items: [], last_seq: 0 },
    "GET /v1/tasks/:task": ({ params }: { params: Record<string, string> }) => {
      const t = tasks.find((x) => x.key === params.task)!;
      return { task: t, status: statuses[0], feature: checkout, claims: [], notes: [], evidence: [], blockers: [], blocking: [], observations: [] };
    },
    "GET /v1/teams/:team": { team: web, members: [me().member] },
    "GET /v1/members/:member": { member: me().member, teams: [web], skills: [], reports: [] },
  });
  const rows = () => [...document.querySelectorAll<HTMLElement>("#main [data-task]")];
  const ringed = () => rows().filter((r) => r.dataset.selected === "true").map((r) => r.dataset.task);

  it("J, K and the arrows move a ring along the list; Enter opens the peek, which leaves the list working; Esc returns to the row", async () => {
    mockApi(records());
    renderApp("/teams/WEB/tasks?view=list");
    await screen.findByRole("link", { name: /WEB-8 Task 8/ });
    const [first, second, third] = rows().map((r) => r.dataset.task!);
    expect(ringed()).toEqual([]);

    await userEvent.keyboard("j");
    expect(ringed()).toEqual([first]);
    expect(rows()[0]).toHaveClass("ring-2", "ring-ring");
    expect(rows()[0]).toHaveFocus();
    await userEvent.keyboard("j");
    expect(ringed()).toEqual([second]);
    await userEvent.keyboard("k");
    expect(ringed()).toEqual([first]);
    await userEvent.keyboard("{ArrowDown}");
    expect(ringed()).toEqual([second]);

    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: `Task ${second}` })).toBeInTheDocument();
    // No scrim: the row under the peek keeps its ring, and the list stays clickable.
    expect(document.querySelector("[data-slot=sheet-overlay]")).toBeNull();
    expect(ringed()).toEqual([second]);
    await userEvent.click(rows()[2]);
    expect(await screen.findByRole("dialog", { name: `Task ${third}` })).toBeInTheDocument();
    expect(ringed()).toEqual([third]);

    // Inside the peek, K and J step it along the list behind it.
    await userEvent.keyboard("k");
    expect(await screen.findByRole("dialog", { name: `Task ${second}` })).toBeInTheDocument();
    expect(ringed()).toEqual([second]);
    await userEvent.keyboard("k");
    expect(await screen.findByRole("dialog", { name: `Task ${first}` })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(rows()[0]).toHaveFocus());
    expect(ringed()).toEqual([first]);
  });

  it("leaves J and K to a Status select that has the focus", async () => {
    mockApi(records());
    renderApp("/teams/WEB/tasks?view=list&task=WEB-6");
    const peek = await screen.findByRole("dialog", { name: "Task WEB-6" });
    const status = await within(peek).findByRole("combobox", { name: "Status: Todo" });
    status.focus();
    await userEvent.keyboard("j");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("dialog", { name: "Task WEB-6" })).toBeInTheDocument();
  });

  it("G I, G M and G A go to the Inbox, My work and Agents; ? lists the keys", async () => {
    mockApi(records());
    renderApp("/activity");
    await screen.findByRole("heading", { name: "Activity" });

    await userEvent.keyboard("gm");
    expect(await screen.findByRole("heading", { name: "My work" })).toBeInTheDocument();
    await userEvent.keyboard("ga");
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
    await userEvent.keyboard("gi");
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();

    await userEvent.keyboard("?");
    const sheet = await screen.findByRole("dialog", { name: "Shortcuts" });
    const listed = within(sheet).getAllByRole("term").map((t) => t.textContent);
    expect(listed).toEqual([
      "Search",
      "File a Task",
      "Go to Inbox",
      "Go to My work",
      "Go to Agents",
      "Go to the board",
      "Shortcuts",
      "Next Task",
      "Previous Task",
      "Open the Task",
      "Close the Task",
    ]);
    // While it is open the keys are its own.
    await userEvent.keyboard("c");
    expect(screen.queryByRole("dialog", { name: "File a Task" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("the Task peek", () => {
  it("opens over the page for ?task= and closes back to it", async () => {
    mockApi(signedIn());
    renderApp("/teams/WEB/tasks?view=board&task=WEB-3");

    const peek = await screen.findByRole("dialog", { name: "Task WEB-3" });
    // The header is the key, the primary, ⋯ and ×; the page is in ⋯ (F-T4).
    expect(within(peek).queryByRole("link", { name: /Open/ })).not.toBeInTheDocument();
    await userEvent.click(within(peek).getByRole("button", { name: "More" }));
    const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("Open as page");
    expect(items[0]).toHaveAttribute("href", "/tasks/WEB-3");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await userEvent.click(within(peek).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The board underneath kept its view.
    expect(screen.getByRole("heading", { name: "Tasks, board" })).toBeInTheDocument();
  });
});

describe("screens share one query cache", () => {
  it("a Task opened from ⌘K after the Inbox renders, and G B still opens the board", async () => {
    const checkout = feature(1, 1, { title: "Checkout flow" });
    const cart = task(3, checkout.id, { title: "Build the cart page", status_id: "st-todo" });
    const statuses = [
      { id: "st-todo", name: "Todo", kind: "todo", position: 1 },
      { id: "st-done", name: "Done", kind: "done", position: 2 },
    ];
    mockApi({
      ...signedIn(),
      "GET /v1/statuses": { items: statuses },
      "GET /v1/features": { items: [checkout] },
      "GET /v1/tasks": { items: [cart] },
      // The Inbox and the Task page both read what the caller can take.
      "GET /v1/tasks/takeable": { items: [cart] },
      "GET /v1/tasks/:task": { task: cart, status: statuses[0], feature: checkout, claims: [], notes: [], evidence: [], blockers: [], blocking: [], observations: [] },
      "GET /v1/teams/:team": { team: web, members: [me().member] },
      "GET /v1/members/:member": { member: me().member, teams: [web], skills: [], reports: [] },
    });
    renderApp("/inbox");
    await screen.findByRole("heading", { name: "Inbox" });
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument());

    await userEvent.keyboard("{Meta>}k{/Meta}");
    const search = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(search).getByRole("combobox"), "WEB-3");
    await userEvent.click(await within(search).findByRole("option", { name: /WEB-3 Build the cart page/ }));
    expect(await screen.findByRole("heading", { name: "Build the cart page", level: 1 })).toBeInTheDocument();

    await userEvent.keyboard("gb");
    expect(await screen.findByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Web/Tasks");
  });
});

describe("the file-task intent", () => {
  it("opens File Task in the Status and the Feature it names", async () => {
    const checkout = feature(1, 1, { title: "Checkout flow" });
    const statuses = [
      { id: "st-backlog", name: "Backlog", kind: "backlog", position: 1 },
      { id: "st-todo", name: "Todo", kind: "todo", position: 2 },
      { id: "st-done", name: "Done", kind: "done", position: 3 },
    ];
    mockApi({ ...signedIn(), "GET /v1/statuses": { items: statuses }, "GET /v1/features": { items: [checkout] } });
    renderApp("/my-work");
    await screen.findByRole("navigation", { name: "Main" });

    act(() => sendIntent({ kind: "file-task", team: "WEB", status: "st-backlog", feature: "WEB-1" }));
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Status" })).toHaveTextContent("Backlog"));
    expect(within(dialog).getByRole("combobox", { name: "Feature" })).toHaveTextContent("Checkout flow");
  });
});
