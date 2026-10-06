import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Member, MemberDetail, Token } from "@/api/client";
import type { components } from "@/api/schema.gen";
import { json, mockApi } from "@/test/api";
import { ada, bob, build, builder, me, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import type { Session } from "./model";

type Status = components["schemas"]["Status"];

const at = "2026-10-01T09:00:00Z";
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const gone: Member = { id: "m-gone", name: "gone", kind: "agent", admin: false, created_at: at, deactivated_at: at };

function detail(member: Member, extra: Partial<MemberDetail> = {}): MemberDetail {
  return { member, teams: [web], skills: [build], reports: [], ...extra };
}

/** Every Member's record, as the Members table reads it. */
const details = { "GET /v1/members/:member": ({ params }: { params: Record<string, string> }) => detail([ada, bob, builder, gone].find((m) => m.id === params.member)!) };

describe("Members", () => {
  it("groups Humans and Agents, marks the caller and dims a deactivated Member with the reason", async () => {
    mockApi({ ...signedIn(), "GET /v1/members": { items: [ada, bob, builder, gone] }, ...details });
    renderApp("/admin/members");
    const table = await screen.findByRole("table", { name: "Members" });
    expect(within(table).getByRole("rowheader", { name: "Humans 2" })).toBeInTheDocument();
    expect(within(table).getByRole("rowheader", { name: "Agents 2" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row").map((r) => r.getAttribute("aria-label"));
    expect(rows.filter(Boolean)).toEqual(["ada", "bob", "builder", "gone"]);
    expect(within(within(table).getByRole("row", { name: "ada" })).getByText("you")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: "gone" })).getByText("Deactivated")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: /bob/ })).toHaveAttribute("href", "/admin/members/m-bob");
    // bob reports to ada; ada to no one.
    expect(within(within(table).getByRole("row", { name: "bob" })).getAllByText("ada")).not.toHaveLength(0);
    expect(within(within(table).getByRole("row", { name: "ada" })).getByText("No one")).toBeInTheDocument();
  });

  it("tells a Member who is not an admin that Admin is for admins", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/me": me(bob) });
    renderApp("/admin/members");
    expect(await screen.findByRole("heading", { name: "Admins only" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Members" })).not.toBeInTheDocument();
  });

  it("?new=1&kind=agent opens New Member as an Agent; creating it issues its first token and shows the secret once", async () => {
    const user = userEvent.setup();
    const created: Member = { id: "m-new", name: "builder-9", kind: "agent", admin: false, created_at: at };
    const api = mockApi({
      ...signedIn(),
      ...details,
      "POST /v1/members": json(201, created),
      "POST /v1/members/:member/tokens": json(201, { token: { id: "t-1", member_id: "m-new", name: "default", prefix: "dk_s3cr", created_at: at }, secret: "dk_s3cret-shown-once" }),
    });
    renderApp("/admin/members?new=1&kind=agent");
    const dialog = await screen.findByRole("dialog", { name: "New Member" });
    expect(within(dialog).getByRole("radio", { name: "Agent" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).queryByLabelText("Email")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "builder-9");
    await user.click(within(dialog).getByRole("button", { name: "Create Member" }));

    const once = await screen.findByRole("dialog", { name: "Token for builder-9" });
    expect(within(once).getByRole("textbox", { name: "Secret of default" })).toHaveValue("dk_s3cret-shown-once");
    expect(within(once).getByText("It will not be shown again.")).toBeInTheDocument();
    const writes = api.calls.filter((c) => c.method === "POST");
    expect(writes.map((c) => c.path)).toEqual(["/v1/members", "/v1/members/m-new/tokens"]);
    expect(writes[0].body).toEqual({ name: "builder-9", kind: "agent", admin: false });
    expect(writes[1].body).toEqual({ name: "default" });
  });
});

describe("a Member's page", () => {
  const tokens: Token[] = [
    { id: "t-live", member_id: builder.id, name: "seed", prefix: "dk_uxx9Yw", created_at: at, last_used_at: at },
    { id: "t-old", member_id: builder.id, name: "old", prefix: "dk_0ld", created_at: at, revoked_at: at },
  ];
  const sessions: Session[] = [{ id: "sess-builder-1", member_id: builder.id, kind: "token", token_id: "t-live", started_at: at, last_seen_at: at }];
  const held = task(3, "f-1", {
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
    renderApp("/admin/members/m-builder");
    expect(await screen.findByRole("heading", { name: "builder" })).toBeInTheDocument();
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
    expect(confirm).toHaveTextContent("Closes1 Sessionsess-builder-1");
    expect(confirm).toHaveTextContent("Ends1 ClaimWEB-3");
    expect(api.calls.some((c) => c.path.endsWith("/deactivate"))).toBe(false);

    await user.click(within(confirm).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === "/v1/members/m-builder/deactivate")).toBe(true));
  });

  it("a Member who holds nothing is deactivated with nothing listed", async () => {
    const user = userEvent.setup();
    mockApi({
      ...signedIn(),
      ...details,
      "GET /v1/members/:member/tokens": { items: [] },
      "GET /v1/members/:member/sessions": { items: [] },
    });
    renderApp("/admin/members/m-bob");
    await user.click(await screen.findByRole("button", { name: "More for bob" }));
    await user.click(await screen.findByRole("menuitem", { name: "Deactivate" }));
    expect(await screen.findByRole("dialog", { name: "Deactivate bob?" })).toHaveTextContent("Holds no token, Session or Claim.");
  });
});

describe("Workflow", () => {
  const statuses: Status[] = [
    { id: "st-backlog", name: "Backlog", kind: "backlog", position: 1 },
    { id: "st-todo", name: "Todo", kind: "todo", position: 2 },
    { id: "st-progress", name: "In progress", kind: "in_progress", position: 3 },
    { id: "st-review", name: "In review", kind: "in_progress", position: 4 },
    { id: "st-done", name: "Done", kind: "done", position: 5 },
    { id: "st-dropped", name: "Dropped", kind: "dropped", position: 6 },
  ];
  const tasks = [task(1, "f-1", { status_id: "st-review" }), task(2, "f-1", { status_id: "st-review" }), task(3, "f-1", { status_id: "st-todo" })];
  const routes = () => ({
    ...signedIn(),
    "GET /v1/statuses": { items: statuses },
    "GET /v1/tasks": { items: tasks },
    "PUT /v1/statuses": ({ body }: { body: unknown }) => ({ items: (body as { items: Status[] }).items.map((s, i) => ({ ...s, id: s.id ?? `st-${i}`, position: i + 1 })) }),
  });

  it("lists the Statuses in order with the Tasks in each", async () => {
    mockApi(routes());
    renderApp("/admin/workflow");
    const table = await screen.findByRole("table", { name: "Statuses" });
    const names = within(table).getAllByRole("row").map((r) => r.getAttribute("aria-label")).filter(Boolean);
    expect(names).toEqual(["Backlog", "Todo", "In progress", "In review", "Done", "Dropped"]);
    expect(await within(within(table).getByRole("row", { name: "In review" })).findByText("2 Tasks")).toBeInTheDocument();
    expect(within(within(table).getByRole("row", { name: "Backlog" })).getByText("0 Tasks")).toBeInTheDocument();
  });

  it("a rename is sent as the whole list", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());
    renderApp("/admin/workflow");
    await user.click(await screen.findByRole("button", { name: "Rename In review" }));
    const field = screen.getByRole("textbox", { name: "Name of In review" });
    await user.clear(field);
    await user.type(field, "Code review{Enter}");
    await waitFor(() => expect(api.calls.some((c) => c.method === "PUT")).toBe(true));
    const put = api.calls.find((c) => c.method === "PUT")!;
    expect((put.body as { items: { name: string }[] }).items.map((s) => s.name)).toEqual(["Backlog", "Todo", "In progress", "Code review", "Done", "Dropped"]);
    expect(put.body).not.toHaveProperty("moves");
  });

  it("refuses in words a kind change that leaves no Todo Status, and sends nothing", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());
    renderApp("/admin/workflow");
    await user.click(await screen.findByRole("combobox", { name: "Kind of Todo" }));
    await user.click(await screen.findByRole("option", { name: "Backlog" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid The list needs a Todo Status.");
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("deleting a Status Tasks are in asks which Status receives them, and sends that as moves", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());
    renderApp("/admin/workflow");
    await within(await screen.findByRole("row", { name: "In review" })).findByText("2 Tasks");
    await user.click(screen.getByRole("button", { name: "More for In review" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete In review?" });
    expect(dialog).toHaveTextContent("2 Tasks to");
    expect(within(dialog).getByRole("combobox", { name: "Status that receives them" })).toHaveTextContent("In progress");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "PUT")).toBe(true));
    const put = api.calls.find((c) => c.method === "PUT")!.body as { items: { id?: string }[]; moves: Record<string, string> };
    expect(put.items.map((s) => s.id)).toEqual(["st-backlog", "st-todo", "st-progress", "st-done", "st-dropped"]);
    expect(put.moves).toEqual({ "st-review": "st-progress" });
  });

  it("shows the server's refusal when it refuses anyway", async () => {
    const user = userEvent.setup();
    mockApi({ ...routes(), "PUT /v1/statuses": json(409, { code: "status_in_use", message: "2 Tasks are in In review; say in moves which Status they go to" }) });
    renderApp("/admin/workflow");
    await user.click(await screen.findByRole("button", { name: "Rename In review" }));
    await user.type(screen.getByRole("textbox", { name: "Name of In review" }), "!{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("status_in_use");
    // The saved list is back.
    expect(screen.getByRole("row", { name: "In review" })).toBeInTheDocument();
  });
});
