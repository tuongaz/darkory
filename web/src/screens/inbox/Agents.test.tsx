import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { FakeEventSource } from "@/test/eventSource";
import type { Member, RunnerSession } from "@/api/client";
import { ada, bob, builder, engineer, ops, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { agentRows, claimHolder, claimsSince } from "./derive";
import { claim, entry, memberDetail, minutes, recordApi } from "./testing";

const planner: Member = { id: "m-planner", name: "planner", kind: "agent", admin: false, created_at: minutes(-1000) };
const agentBuilder: Member = { ...builder, agent: { command: "claude", args: [], model: "claude-sonnet-5-5", env: [], unattended: true, paused: false } as unknown as Member["agent"] };

function session(state: RunnerSession["state"], extra: Partial<RunnerSession> = {}): RunnerSession {
  return { task_id: "k-3", member_id: builder.id, session_id: "sess-1", host: "mac-mini", tmux: "dk-WEB-3", started_at: minutes(-20), state, state_since: minutes(-20), log_path: "/tmp/log", ...extra };
}

function agentsApi({ sessions = [], member = ada }: { sessions?: RunnerSession[]; member?: Member } = {}) {
  const held = task(3, { title: "Payment form", claim: claim("k-3", builder.id, { expires_at: minutes(10), heartbeat_timeout_seconds: 600, skill_id: engineer.id }) });
  return recordApi({
    tasks: [held, task(4, { title: "Cart" })],
    activity: [
      entry(1, "task.claimed", "k-3", { actor_id: builder.id, payload: { claim_id: "c-k-3", skill_id: engineer.id } }),
      entry(2, "task.advanced", "k-4", { actor_id: builder.id, payload: { claim_id: "c-x", from: "st-build", to: "st-review", outcome: "pass" }, at: minutes(-1) }),
    ],
    extra: {
      "GET /v1/me": { organisation: { id: "o-1", name: "Acme", created_at: minutes(-1) }, member, projects: [web], skills: [] },
      "GET /v1/members": { items: [ada, bob, agentBuilder, planner] },
      "GET /v1/projects/:project": ({ params }) => (params.project === "OPS" ? { project: ops, members: [ada, planner] } : { project: web, members: [ada, builder] }),
      "GET /v1/members/:member": ({ params }) =>
        params.member === planner.id || params.member === planner.name ? { member: planner, projects: [ops], skills: [], reports: [] } : memberDetail(params.member),
      "GET /v1/runner/sessions": { items: sessions, runner: true },
      "POST /v1/runner/sessions/:task/nudge": undefined,
      "POST /v1/runner/sessions/:task/stop": undefined,
    },
  });
}

describe("the Agents' rules", () => {
  it("puts a stalled session first, then the Heartbeat due soonest, then the idle", () => {
    const a = (name: string): Member => ({ ...builder, id: `m-${name}`, name });
    const tasks = [task(1, { claim: claim("k-1", "m-b", { expires_at: minutes(5) }) }), task(2, { claim: claim("k-2", "m-c", { expires_at: minutes(1) }) })];
    const rows = agentRows([a("a"), a("b"), a("c"), a("d")], tasks, Date.now(), (id) => (id === "m-d" ? "stalled" : undefined));
    expect(rows.map((r) => r.agent.name)).toEqual(["d", "c", "b", "a"]);
  });

  it("reads a Claim's end from the v2 kinds: advanced and split end the holder's Claim", () => {
    expect(claimHolder(entry(1, "task.advanced", "k-1", { actor_id: "m-x", payload: { claim_id: "c" } }))).toBe("m-x");
    expect(claimHolder(entry(1, "task.split", "k-1", { actor_id: "m-x", payload: { claim_id: "c", holder_id: "m-x" } }))).toBe("m-x");
    // A Parent completed by its Owner ends no Claim.
    expect(claimHolder(entry(1, "task.completed", "k-1", { actor_id: "m-x", payload: {} }))).toBeUndefined();
    const records = claimsSince(
      [entry(1, "task.claimed", "k-1", { actor_id: "m-x", payload: { claim_id: "c" }, at: minutes(-5) }), entry(2, "task.advanced", "k-1", { actor_id: "m-x", payload: { claim_id: "c" } })],
      "m-x",
      0,
    );
    expect(records[0].end?.kind).toBe("task.advanced");
  });
});

const tableRow = (name: string) => screen.getByRole("link", { name }).closest("tr")!;

describe("a Project's Agents", () => {
  it("shows each agent of the Project: its turning mark, what it holds at which Step, its session, Skills and Steps, last here", async () => {
    agentsApi({ sessions: [session("running")] });
    renderApp("/projects/WEB/agents");
    const row = await waitFor(() => tableRow("builder"));
    expect(within(row).getByRole("img", { name: "builder (agent), working" })).toHaveAttribute("data-working", "running");
    expect(row).toHaveTextContent("WEB-3");
    expect(row).toHaveTextContent("Payment form");
    expect(row).toHaveTextContent("Build");
    expect(within(row).getByText("Running")).toBeInTheDocument();
    expect(row).toHaveTextContent("mac-mini");
    expect(row).toHaveTextContent("dk-WEB-3");
    await waitFor(() => expect(row).toHaveTextContent("engineer"));
    expect(row).toHaveTextContent("advanced WEB-4 Cart along pass to Review");
    // A lapse arriving on the stream counts at once.
    act(() => FakeEventSource.latest().emit("activity", entry(9, "task.lapsed", "k-4", { payload: { holder_id: builder.id, claim_id: "c-9" }, at: minutes(0) }), 9));
    await waitFor(() => expect(row).toHaveTextContent("1 lapse in 24 h"));
    // ada is a human: not listed.
    expect(screen.queryByRole("link", { name: "ada" })).not.toBeInTheDocument();
  });

  it("stops the mark in the session's colour while its session is stalled", async () => {
    agentsApi({ sessions: [session("stalled")] });
    renderApp("/projects/WEB/agents");
    expect(await screen.findByRole("img", { name: "builder (agent), working, its session stalled" })).toHaveAttribute("data-working", "stalled");
  });

  it("lists the Organisation's other agents, muted, with their Projects", async () => {
    agentsApi();
    renderApp("/projects/WEB/agents");
    const others = await screen.findByRole("region", { name: "Also in other Projects" });
    expect(within(others).getByText("planner")).toBeInTheDocument();
    expect(await within(others).findByRole("link", { name: "Ops" })).toHaveAttribute("href", "/projects/OPS/agents");
  });

  it("opens an agent's peek: what it holds, its session, the Steps it takes here; an admin nudges and stops it", async () => {
    const { calls } = agentsApi({ sessions: [session("waiting")] });
    renderApp("/projects/WEB/agents?agent=builder");
    const peek = await screen.findByRole("dialog", { name: "Agent builder" });
    await waitFor(() => expect(within(peek).getByRole("region", { name: "Runner session" })).toHaveTextContent("dk-WEB-3"));
    expect(within(peek).getByText("Steps in Web").nextSibling).toHaveTextContent("Build");
    expect(within(peek).getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/settings/organisation/agents/builder");

    await userEvent.click(within(peek).getByRole("button", { name: "Nudge" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/runner/sessions/WEB-3/nudge")).toBe(true));

    await userEvent.click(within(peek).getByRole("button", { name: "Stop" }));
    const confirm = await screen.findByRole("dialog", { name: "Stop builder's session on WEB-3?" });
    expect(calls.some((c) => c.path.endsWith("/stop"))).toBe(false);
    await userEvent.click(within(confirm).getByRole("button", { name: "Stop session" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/runner/sessions/WEB-3/stop")).toBe(true));
  });

  it("pauses an agent from its ⋯ menu", async () => {
    const { calls, routes } = agentsApi();
    routes["PATCH /v1/members/:member/agent"] = { ...agentBuilder, agent: { ...agentBuilder.agent, paused: true } };
    renderApp("/projects/WEB/agents?agent=builder");
    const peek = await screen.findByRole("dialog", { name: "Agent builder" });
    await userEvent.click(within(peek).getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ paused: true }));
  });

  it("offers a Member no Nudge, Stop or Settings", async () => {
    agentsApi({ sessions: [session("running")], member: bob });
    renderApp("/projects/WEB/agents?agent=builder");
    const peek = await screen.findByRole("dialog", { name: "Agent builder" });
    await waitFor(() => expect(within(peek).getByRole("region", { name: "Runner session" })).toBeInTheDocument());
    expect(within(peek).queryByRole("button", { name: "Nudge" })).not.toBeInTheDocument();
    expect(within(peek).queryByRole("link", { name: /Settings/ })).not.toBeInTheDocument();
  });
});
