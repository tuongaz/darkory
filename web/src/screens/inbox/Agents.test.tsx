import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Activity, AgentSettings, Claim, Member, RunnerSession } from "@/api/client";
import { mockApi } from "@/test/api";
import { ada, bob, build, builder, feature, me, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { FakeWebSocket } from "@/test/webSocket";
import { agentRows, claimsSince, lapsesIn24h, lastClaimEntry } from "./derive";
import { statuses } from "./testing";

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const agent = (name: string, extra: Partial<Member> = {}): Member => ({
  id: `m-${name}`,
  name,
  kind: "agent",
  admin: false,
  manager_id: ada.id,
  created_at: minutes(-600),
  ...extra,
});

function claim(n: number, holder: string, expiresIn?: number): Claim {
  return {
    id: `c-${n}`,
    task_id: `k-${n}`,
    holder_id: holder,
    session_id: `sess-${holder}`,
    skill_id: build.id,
    model_label: "claude-opus-5-5",
    started_at: minutes(-1),
    ...(expiresIn === undefined ? {} : { expires_at: minutes(expiresIn), heartbeat_timeout_seconds: 900 }),
  };
}

let seq = 0;
function entry(kind: Activity["kind"], subject: string, payload: Record<string, unknown>, actor?: string, at = minutes(-1)): Activity {
  seq += 1;
  return { seq, at, kind, actor_id: actor, subject_type: "task", subject_id: subject, payload };
}

describe("the Agents rules", () => {
  it("puts the agents holding a live Claim first, the soonest Heartbeat first, Member-bound after timed, then idle, then deactivated", () => {
    const planner = agent("planner");
    const one = agent("builder-1");
    const two = agent("builder-2");
    const reviewer = agent("reviewer");
    const qa = agent("qa-bot");
    const gone = agent("old-bot", { deactivated_at: minutes(-60) });
    const tasks = [
      task(10, "f-1", { claim: claim(10, planner.id, 10) }),
      task(3, "f-1", { claim: claim(3, one.id, 15) }),
      task(4, "f-1", { claim: claim(4, two.id) }),
      // A Claim past its expiry is not live: qa-bot is idle.
      task(5, "f-1", { claim: claim(5, qa.id, -1) }),
    ];
    const rows = agentRows([ada, gone, qa, reviewer, two, one, planner], tasks, Date.now());
    expect(rows.map((r) => r.agent.name)).toEqual(["planner", "builder-1", "builder-2", "qa-bot", "reviewer", "old-bot"]);
    expect(rows[0].held.map((t) => t.key)).toEqual(["WEB-10"]);
    expect(rows[3].held).toEqual([]);
  });

  it("puts an agent whose runner session is Stalled first, then one Waiting, whatever their Heartbeats", () => {
    const one = agent("builder-1");
    const two = agent("builder-2");
    const three = agent("builder-3");
    const idle = agent("idle-bot");
    const tasks = [task(3, "f-1", { claim: claim(3, one.id, 5) }), task(4, "f-1", { claim: claim(4, two.id, 10) }), task(5, "f-1", { claim: claim(5, three.id, 15) })];
    const states: Record<string, RunnerSession["state"]> = { [three.id]: "stalled", [two.id]: "waiting", [one.id]: "running" };
    const rows = agentRows([idle, one, two, three], tasks, Date.now(), (id) => states[id]);
    expect(rows.map((r) => r.agent.name)).toEqual(["builder-3", "builder-2", "builder-1", "idle-bot"]);
  });

  it("counts an agent's lapses in the last 24 hours, by the holder the lapse names", () => {
    const entries = [
      entry("task.lapsed", "k-5", { holder_id: builder.id, claim_id: "c-5" }),
      entry("task.lapsed", "k-6", { holder_id: builder.id, claim_id: "c-6" }, undefined, minutes(-25 * 60)),
      entry("task.lapsed", "k-7", { holder_id: "m-other", claim_id: "c-7" }),
      entry("task.completed", "k-8", { claim_id: "c-8" }, builder.id),
    ];
    expect(lapsesIn24h(entries, builder.id, Date.now()).map((e) => e.subject_id)).toEqual(["k-5"]);
  });

  it("follows each of today's Claims to the entry that ended it", () => {
    const entries = [
      entry("task.claimed", "k-4", { claim_id: "c-4", skill_id: build.id }, builder.id),
      entry("task.completed", "k-4", { claim_id: "c-4" }, builder.id),
      entry("task.claimed", "k-5", { claim_id: "c-5", heartbeat_timeout_seconds: 2 }, builder.id),
      entry("task.lapsed", "k-5", { claim_id: "c-5", holder_id: builder.id }),
      entry("task.claimed", "k-9", { claim_id: "c-9" }, bob.id),
      entry("task.claimed", "k-3", { claim_id: "c-3" }, builder.id),
    ];
    const claims = claimsSince(entries, builder.id, Date.now() - 60 * 60_000);
    expect(claims.map((c) => [c.taskId, c.end?.kind])).toEqual([
      ["k-4", "task.completed"],
      ["k-5", "task.lapsed"],
      ["k-3", undefined],
    ]);
    expect(claims[1].timeoutSeconds).toBe(2);
    // A take-back by someone else ends the agent's Claim; the taker did not hold it.
    const taken = entry("task.taken_back", "k-3", { claim_id: "c-3", holder_id: builder.id }, ada.id);
    expect(lastClaimEntry([...entries, taken], builder.id)?.kind).toBe("task.taken_back");
    expect(lastClaimEntry([...entries, taken], ada.id)).toBeUndefined();
  });
});

describe("the Agents page", () => {
  const planner = agent("planner");
  const lapser = agent("lapser");
  const checkout = feature(1, 1);
  const held = task(10, checkout.id, { title: "Break down: Search", claim: claim(10, planner.id, 10) });
  const dropped = task(5, checkout.id, { title: "Discount codes" });

  function agentsApi(caller: Member = ada) {
    const lapse = entry("task.lapsed", dropped.id, { claim_id: "c-5", holder_id: lapser.id });
    return mockApi({
      ...signedIn(caller),
      "GET /v1/me": me(caller),
      "GET /v1/members": { items: [ada, bob, builder, planner, lapser] },
      "GET /v1/statuses": statuses,
      "GET /v1/features": { items: [checkout] },
      "GET /v1/tasks": ({ query }) => ({ items: query.get("state") === "open" ? [held, dropped] : [held, dropped] }),
      "GET /v1/members/:member": ({ params }) => ({ member: { id: params.member }, teams: [web], skills: [build], reports: [] }),
      "GET /v1/members/:member/sessions": ({ params }) => ({
        items: params.member === planner.id ? [{ id: "sess-planner-1", member_id: planner.id, kind: "token", started_at: minutes(-5), last_seen_at: minutes(-1) }] : [],
      }),
      "GET /v1/members/:member/tokens": { items: [{ id: "tok-1", member_id: planner.id, name: "seed", prefix: "dk_abc", created_at: minutes(-30) }] },
      "GET /v1/activity": ({ query }) => {
        const kinds = query.getAll("kind");
        const all = [entry("task.claimed", held.id, { claim_id: "c-10", skill_id: build.id }, planner.id), lapse];
        return { items: all.filter((e) => kinds.length === 0 || kinds.includes(e.kind)).filter((e) => !query.get("member") || e.actor_id === query.get("member") || e.payload.holder_id === query.get("member")), last_seq: seq };
      },
    });
  }

  it("shows what each agent holds, its Heartbeat and Session, and a lapse on the idle one", async () => {
    agentsApi();
    renderApp("/agents");
    const rows = await screen.findAllByRole("row");
    const body = rows.slice(1);
    // builder has no Session and holds nothing; the lapser's last Claim lapsed.
    expect(body.map((r) => within(r).getAllByRole("link")[0].textContent)).toEqual(["planner", "builder", "lapser"]);
    expect(within(body[0]).getByText("Break down: Search")).toBeInTheDocument();
    // A Session id by its last 8 characters, the whole id on hover.
    expect(within(body[0]).getByText("…-planner")).toHaveAttribute("title", "sess-m-planner");
    expect(within(body[0]).getByRole("meter")).toBeInTheDocument();
    expect(await within(body[2]).findByText("Lapsed")).toBeInTheDocument();
    const lapses = within(body[2]).getAllByRole("cell")[6];
    expect(lapses).toHaveTextContent("1WEB-5");
    expect(await within(body[1]).findByText("No Session")).toBeInTheDocument();
    // Each dimmed row says why it is idle, once, under "Nothing held": no Session, or the lapse and when.
    const holds = (row: HTMLElement) => within(row).getAllByRole("cell")[2];
    const session = (row: HTMLElement) => within(row).getAllByRole("cell")[4];
    expect(holds(body[1])).toHaveTextContent(/^Nothing heldNo Session$/);
    expect(session(body[1])).toHaveTextContent(/^$/);
    expect(holds(body[2])).toHaveTextContent(/^Nothing heldWEB-5Lapsed \d\d:\d\d$/);
    expect(session(body[2])).toHaveTextContent("No Session");
    expect(screen.getByRole("link", { name: "New agent" })).toHaveAttribute("href", "/admin/members?new=1&kind=agent");
  });

  it("opens an agent's peek with today's Claims, its tokens and a link to its Activity", async () => {
    agentsApi();
    renderApp("/agents?agent=planner");
    const peek = await screen.findByRole("dialog", { name: "Agent planner" });
    expect(await within(peek).findByText("…lanner-1")).toHaveAttribute("title", "sess-planner-1");
    expect(within(peek).getByText("claude-opus-5-5")).toBeInTheDocument();
    // Who it reports to is said here, not on every row.
    expect(within(peek).getByText("Reports to")).toBeInTheDocument();
    expect(screen.queryByText(/reports to/)).not.toBeInTheDocument();
    const claims = within(peek).getByRole("region", { name: "Claims today" });
    expect(within(claims).getByText("Claims today · 1")).toBeInTheDocument();
    expect(within(claims).getByRole("link", { name: "WEB-10" })).toHaveAttribute("href", "/agents?task=WEB-10");
    expect(await within(peek).findByText("seed")).toBeInTheDocument();
    expect(within(peek).getByRole("link", { name: /Activity · 1 entry/ })).toHaveAttribute("href", "/activity?member=planner");

    // ada directs planner: she may take back its Task, and as an admin close its Session.
    await userEvent.click(within(peek).getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Take back WEB-10", "Close Session", "Revoke token", "Deactivate"]);
  });

  it("shows no New agent, Sessions or tokens to a Member who is not an admin", async () => {
    const api = agentsApi(bob);
    renderApp("/agents?agent=planner");
    const peek = await screen.findByRole("dialog", { name: "Agent planner" });
    expect(within(peek).queryByRole("region", { name: "Tokens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New agent" })).not.toBeInTheDocument();
    // The Session comes from the live Claim, not from the admin-only list.
    expect(within(peek).getByText("…-planner")).toBeInTheDocument();
    expect(api.calls.some((c) => c.path.startsWith("/v1/members/") && (c.path.endsWith("/sessions") || c.path.endsWith("/tokens")))).toBe(false);
    expect(within(peek).queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });
});

describe("the Agents page with the Runner", () => {
  const settings = (extra: Partial<AgentSettings> = {}): AgentSettings => ({
    command: "claude",
    args: [],
    model: "claude-sonnet-5-5",
    env: {},
    unattended: true,
    paused: false,
    ...extra,
  });
  const checkout = feature(1, 1);
  const held = task(10, checkout.id, { title: "Break down: Search", claim: claim(10, "m-planner", 10) });
  const session: RunnerSession = {
    task_id: held.id,
    member_id: "m-planner",
    session_id: "sess-m-planner",
    host: "mac-mini",
    tmux: "dk-WEB-10",
    started_at: new Date(2026, 9, 7, 4, 25).toISOString(),
    state: "running",
    log_path: "/data/sessions/WEB-10/pane.log",
  };

  /** `live` changes the planner's session: its state, and when its Claim lapses without a Heartbeat. */
  function runnerAgentsApi(caller: Member = ada, live: { state?: RunnerSession["state"]; expiresIn?: number } = {}) {
    const now = live.expiresIn === undefined ? held : { ...held, claim: claim(10, "m-planner", live.expiresIn) };
    let planner = agent("planner", { agent: settings() });
    const reviewer = agent("reviewer", { agent: settings({ model: "claude-opus-5-5" }) });
    const api = mockApi({
      ...signedIn(caller),
      "GET /v1/me": me(caller),
      "GET /v1/members": () => ({ items: [ada, bob, planner, reviewer] }),
      "GET /v1/statuses": statuses,
      "GET /v1/features": { items: [checkout] },
      "GET /v1/tasks": { items: [now] },
      "GET /v1/tasks/takeable": { items: [] },
      "GET /v1/tasks/:task": {
        task: now,
        status: statuses.items[2],
        feature: checkout,
        workspaces: [],
        claims: [now.claim],
        notes: [],
        evidence: [],
        blockers: [],
        blocking: [],
        observations: [],
      },
      "GET /v1/teams/:team": { team: web, members: [ada, bob, planner, reviewer] },
      "GET /v1/members/:member": ({ params }) => ({ member: { id: params.member }, teams: [web], skills: [build], reports: [] }),
      "GET /v1/members/:member/sessions": { items: [] },
      "GET /v1/members/:member/tokens": { items: [] },
      "GET /v1/activity": { items: [], last_seq: 0 },
      "GET /v1/runner/sessions": { items: [{ ...session, state: live.state ?? session.state }], runner: true },
      "PATCH /v1/members/:member/agent": ({ body }) => {
        planner = { ...planner, agent: settings(body as Partial<AgentSettings>) };
        return planner;
      },
    });
    return api;
  }

  it("shows the Runner's session and the model, and View opens the Task at its Session panel", async () => {
    runnerAgentsApi();
    renderApp("/agents");
    const rows = await screen.findAllByRole("row");
    const [planner, reviewer] = rows.slice(1);
    const state = (row: HTMLElement) => within(row).getAllByRole("cell")[1];
    const session = (row: HTMLElement) => within(row).getAllByRole("cell")[4];
    await waitFor(() => expect(state(planner)).toHaveTextContent(/^Running$/));
    expect(session(planner)).toHaveTextContent(/^started 04:25 · mac-miniViewclaude-opus-5-5$/);
    expect(state(reviewer)).toHaveTextContent(/^$/);
    expect(within(planner).getByRole("link", { name: "View" })).toHaveAttribute("href", "/agents?task=WEB-10#session");
    // Idle, the model is the agent settings'.
    expect(session(reviewer)).toHaveTextContent("claude-opus-5-5");
    expect(within(reviewer).queryByRole("link", { name: "View" })).not.toBeInTheDocument();
  });

  it("says a session whose progress went stale is Stalled, its Heartbeat meter emptying, and one whose turn ended Waiting", async () => {
    runnerAgentsApi(ada, { state: "stalled", expiresIn: 3 });
    const { unmount } = renderApp("/agents");
    let planner = (await screen.findAllByRole("row"))[1];
    await waitFor(() => expect(within(planner).getAllByRole("cell")[1]).toHaveTextContent(/^Stalled$/));
    expect(within(planner).getByText("Stalled").closest("[data-tone]")).toHaveAttribute("data-tone", "blocked");
    // No more Heartbeats: three minutes of the fifteen are left.
    expect(within(planner).getByRole("meter", { name: "Time left before the Claim lapses" })).toHaveAttribute("aria-valuenow", "20");
    unmount();

    runnerAgentsApi(ada, { state: "waiting" });
    renderApp("/agents");
    planner = (await screen.findAllByRole("row"))[1];
    await waitFor(() => expect(within(planner).getAllByRole("cell")[1]).toHaveTextContent(/^Waiting$/));
    expect(within(planner).getByText("Waiting").closest("[data-tone]")).toHaveAttribute("data-tone", "claimed");
  });

  it("pauses and resumes an agent for an admin, and the row says Paused", async () => {
    const api = runnerAgentsApi();
    renderApp("/agents");
    const rows = await screen.findAllByRole("row");
    const planner = rows[1];
    expect(within(planner).queryByText("Paused")).not.toBeInTheDocument();

    await userEvent.click(within(planner).getByRole("button", { name: "More for planner" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    expect(api.calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/v1/members/m-planner/agent", body: { paused: true } });
    expect(await within(planner).findByText("Paused")).toBeInTheDocument();

    await userEvent.click(within(planner).getByRole("button", { name: "More for planner" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Resume" }));
    expect(api.calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({ paused: false });
    await waitFor(() => expect(within(planner).queryByText("Paused")).not.toBeInTheDocument());
  });

  it("offers no Pause to a Member who is not an admin", async () => {
    runnerAgentsApi(bob);
    renderApp("/agents?agent=planner");
    const peek = await screen.findByRole("dialog", { name: "Agent planner" });
    expect(await within(peek).findByRole("region", { name: "Runner session" })).toBeInTheDocument();
    expect(within(peek).queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
    expect(within(peek).queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  it("shows the session's facts in the agent's peek, and Join opens the Task's terminal joined", async () => {
    runnerAgentsApi();
    renderApp("/agents?agent=planner");
    const peek = await screen.findByRole("dialog", { name: "Agent planner" });
    const now = await within(peek).findByRole("region", { name: "Runner session" });
    expect(now).toHaveTextContent(/planner·started 04:25·Running·mac-mini·tmux dk-WEB-10/);
    // One Model: the live Claim's, then the agent settings' when they name another.
    expect(within(peek).getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(within(peek).getByText("· set to claude-sonnet-5-5")).toBeInTheDocument();
    expect(within(peek).queryByText("Model label")).not.toBeInTheDocument();
    expect(within(now).getByRole("link", { name: "View" })).toHaveAttribute("href", "/agents?task=WEB-10#session");

    await userEvent.click(within(now).getByRole("button", { name: "Join" }));
    const taskPeek = await screen.findByRole("dialog", { name: "Task WEB-10" });
    expect(await within(taskPeek).findByRole("region", { name: "Session" })).toBeInTheDocument();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.latest().url).toBe("ws://localhost:3000/v1/runner/sessions/WEB-10/terminal");
  });
});
