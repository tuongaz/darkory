import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Activity } from "@/api/client";
import { mockApi } from "@/test/api";
import { FakeEventSource } from "@/test/eventSource";
import { bob, builder, feature, me, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const sidebar = () => screen.getByRole("navigation", { name: "Main" }).closest<HTMLElement>("[data-slot=sidebar]")!;
const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

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
    expect(within(search).getByRole("option", { name: /Go to Web › Tasks board/ })).toBeInTheDocument();
  });

  it("C opens File Task, and not while typing", async () => {
    mockApi(records());
    renderApp("/my-work");
    await screen.findByRole("heading", { name: "My work" });

    await userEvent.keyboard("c");
    const dialog = await screen.findByRole("dialog", { name: "File a Task" });
    expect(dialog).toHaveTextContent("Team WEB");
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

describe("the Task peek", () => {
  it("opens over the page for ?task= and closes back to it", async () => {
    mockApi(signedIn());
    renderApp("/teams/WEB/tasks?view=board&task=WEB-3");

    const peek = await screen.findByRole("dialog", { name: "Task WEB-3" });
    expect(within(peek).getByRole("link", { name: "Open page" })).toHaveAttribute("href", "/tasks/WEB-3");
    await userEvent.click(within(peek).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The board underneath kept its view.
    expect(screen.getByRole("heading", { name: "Tasks, board" })).toBeInTheDocument();
  });
});
