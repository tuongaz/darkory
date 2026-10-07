import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import type { Claim, Member, RunnerSession, TaskDetail } from "@/api/client";
import { mockApi } from "@/test/api";
import { ada, bob, build, builder, feature, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { FakeWebSocket } from "@/test/webSocket";

// jsdom lays nothing out, so a fit there proposes no size; this one sizes the terminal as a
// 100 × 30 panel would.
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    private terminal?: Terminal;
    activate(t: Terminal) {
      this.terminal = t;
    }
    dispose() {}
    fit() {
      this.terminal?.resize(100, 30);
    }
  },
}));

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const statuses = [
  { id: "st-todo", name: "Todo", kind: "todo", position: 1 },
  { id: "st-ip", name: "In progress", kind: "in_progress", position: 2 },
  { id: "st-done", name: "Done", kind: "done", position: 3 },
] as const;

// The Runner starts sessions only for agents with agent settings.
const agent: Member = { ...builder, agent: { command: "claude", args: [], model: "claude-sonnet-5-5", env: {}, unattended: true, paused: false } };
const claim: Claim = { id: "c-1", task_id: "k-3", holder_id: agent.id, session_id: "sess-builder", skill_id: build.id, started_at: minutes(-5), expires_at: minutes(5), heartbeat_timeout_seconds: 300 };
const session: RunnerSession = {
  task_id: "k-3",
  member_id: agent.id,
  session_id: "sess-builder",
  host: "mac-mini",
  tmux: "dk-WEB-3",
  started_at: minutes(-5),
  state: "running",
  log_path: "/data/sessions/WEB-3/pane.log",
};

function detail(): TaskDetail {
  return {
    task: task(3, "f-1", { title: "Build the cart page", status_id: "st-ip", claim }),
    status: statuses[1],
    feature: feature(1, 1, { title: "Checkout flow" }),
    workspaces: [],
    claims: [claim],
    notes: [],
    evidence: [],
    blockers: [],
    blocking: [],
    observations: [],
  };
}

function runnerApi(caller: Member, sessions: () => object = () => ({ items: [session], runner: true })) {
  return mockApi({
    ...signedIn(caller),
    "GET /v1/members": { items: [ada, bob, agent] },
    "GET /v1/tasks/takeable": { items: [] },
    "GET /v1/tasks/:task": detail(),
    "GET /v1/statuses": { items: statuses },
    "GET /v1/teams/:team": { team: web, members: [ada, bob, agent] },
    "GET /v1/runner/sessions": sessions,
    "POST /v1/runner/sessions/:task/nudge": undefined,
    "POST /v1/runner/sessions/:task/stop": undefined,
  });
}

/** The terminal's socket once the panel has loaded xterm and connected, accepted by the server. */
async function connected(n = 1): Promise<FakeWebSocket> {
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(n));
  const ws = FakeWebSocket.latest();
  act(() => ws.open());
  return ws;
}

function rows(panel: HTMLElement) {
  return panel.querySelector(".xterm-rows")!;
}

describe("the Session panel", () => {
  it("is absent while the Runner runs no session on the Task, and when no Runner is attached", async () => {
    const api = runnerApi(ada, () => ({ items: [], runner: true }));
    const { unmount } = renderApp("/tasks/WEB-3");
    expect(await screen.findByRole("heading", { name: "Build the cart page", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(api.calls.some((c) => c.path === "/v1/runner/sessions")).toBe(true));
    expect(screen.queryByRole("region", { name: "Session" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "Take back" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Nudge" })).not.toBeInTheDocument();
    unmount();

    runnerApi(ada, () => ({ items: [], runner: false }));
    renderApp("/tasks/WEB-3");
    expect(await screen.findByRole("heading", { name: "Build the cart page", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Session" })).not.toBeInTheDocument();
    expect(FakeWebSocket.instances).toEqual([]);
  });

  it("says when the session stalled or waits on its agent", async () => {
    runnerApi(bob, () => ({ items: [{ ...session, state: "stalled" }], runner: true }));
    const { unmount } = renderApp("/tasks/WEB-3");
    let panel = await screen.findByRole("region", { name: "Session" });
    expect(panel).toHaveTextContent(/builder·started \d\d:\d\d·Stalled·mac-mini·tmux dk-WEB-3/);
    expect(within(panel).getByText("Stalled")).toHaveAttribute("data-tone", "blocked");
    unmount();

    runnerApi(bob, () => ({ items: [{ ...session, state: "waiting" }], runner: true }));
    renderApp("/tasks/WEB-3");
    panel = await screen.findByRole("region", { name: "Session" });
    expect(panel).toHaveTextContent(/builder·started \d\d:\d\d·Waiting·mac-mini·tmux dk-WEB-3/);
  });

  it("lets a Member who is not an admin watch, read-only, with the facts and the shell line", async () => {
    runnerApi(bob);
    renderApp("/tasks/WEB-3");
    const panel = await screen.findByRole("region", { name: "Session" });
    expect(panel).toHaveTextContent(/builder·started \d\d:\d\d·Running·mac-mini·tmux dk-WEB-3/);
    expect(within(panel).getByText("darkory join WEB-3")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Join" })).not.toBeInTheDocument();

    const ws = await connected();
    expect(ws.url).toBe("ws://localhost:3000/v1/runner/sessions/WEB-3/terminal?readonly=1");
    expect(ws.binaryType).toBe("arraybuffer");
    expect(within(panel).getByRole("status")).toHaveTextContent("Read-only · admins can join");

    act(() => ws.receive(new TextEncoder().encode("\x1b[1mbuilder\x1b[0m is running the tests")));
    await waitFor(() => expect(rows(panel)).toHaveTextContent("builder is running the tests"));
    // Watching, keys typed into the terminal go nowhere.
    await userEvent.click(within(panel).getByRole("group", { name: "Terminal of WEB-3" }).querySelector("textarea")!);
    await userEvent.keyboard("ls{Enter}");
    expect(ws.typed()).toBe("");
  });

  it("joins for an admin: the keyboard goes to the session until Leave", async () => {
    runnerApi(ada);
    renderApp("/tasks/WEB-3");
    const panel = await screen.findByRole("region", { name: "Session" });
    const watching = await connected();
    expect(within(panel).getByRole("status")).toHaveTextContent("Read-only · Join to type");

    await userEvent.click(within(panel).getByRole("button", { name: "Join" }));
    expect(watching.readyState).toBe(FakeWebSocket.CLOSED);
    const joined = await connected(2);
    expect(joined.url).toBe("ws://localhost:3000/v1/runner/sessions/WEB-3/terminal");
    expect(within(panel).getByRole("status")).toHaveTextContent("Joined · your keys go to the session");
    // The terminal has the focus: what is typed is sent, as bytes.
    expect(document.activeElement?.closest("[data-owns-keys]")).not.toBeNull();
    await userEvent.keyboard("ls{Enter}");
    expect(joined.typed()).toBe("ls\r");

    await userEvent.click(within(panel).getByRole("button", { name: "Leave" }));
    expect(joined.readyState).toBe(FakeWebSocket.CLOSED);
    const again = await connected(3);
    expect(again.url).toMatch(/\?readonly=1$/);
    expect(within(panel).getByRole("button", { name: "Join" })).toBeInTheDocument();
  });

  it("says when the terminal closes, and Reconnect opens it again", async () => {
    runnerApi(bob);
    renderApp("/tasks/WEB-3");
    const panel = await screen.findByRole("region", { name: "Session" });
    const ws = await connected();
    act(() => ws.serverClose());
    expect(within(panel).getByRole("status")).toHaveTextContent("The terminal closed");
    await userEvent.click(within(panel).getByRole("button", { name: "Reconnect" }));
    const again = await connected(2);
    expect(again.url).toMatch(/\?readonly=1$/);
    expect(within(panel).getByRole("status")).toHaveTextContent("Read-only · admins can join");
    expect(within(panel).queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("sends the view's size as a text frame on connecting and after each fit", async () => {
    runnerApi(bob);
    renderApp("/tasks/WEB-3");
    await screen.findByRole("region", { name: "Session" });
    const ws = await connected();
    // jsdom's panel has no width, so nothing is fitted: xterm's 80 × 24.
    expect(ws.textFrames()).toEqual([{ cols: 80, rows: 24 }]);

    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(560);
    act(() => ws.serverClose());
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    const again = await connected(2);
    expect(again.textFrames().at(-1)).toEqual({ cols: 100, rows: 30 });
    expect(again.sent.every((d) => typeof d === "string")).toBe(true);
  });

  it("says a session without tmux cannot be joined, and opens no terminal", async () => {
    runnerApi(ada, () => ({ items: [{ ...session, tmux: undefined }], runner: true }));
    renderApp("/tasks/WEB-3");
    const panel = await screen.findByRole("region", { name: "Session" });
    expect(panel).toHaveTextContent("no tmux");
    expect(panel).toHaveTextContent("This session runs without tmux and cannot be joined");
    expect(within(panel).queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
    expect(within(panel).queryByText("darkory join WEB-3")).not.toBeInTheDocument();
    expect(FakeWebSocket.instances).toEqual([]);
  });

  it("copies the shell line, or selects it where the clipboard is refused", async () => {
    runnerApi(bob);
    renderApp("/tasks/WEB-3");
    const panel = await screen.findByRole("region", { name: "Session" });
    const writeText = vi.fn().mockRejectedValueOnce(new Error("not allowed")).mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await userEvent.click(within(panel).getByRole("button", { name: "Copy darkory join WEB-3" }));
    expect(await within(panel).findByText(/^Selected · press/)).toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe("darkory join WEB-3");

    await userEvent.click(within(panel).getByRole("button", { name: "Copy darkory join WEB-3" }));
    expect(writeText).toHaveBeenLastCalledWith("darkory join WEB-3");
    expect(await within(panel).findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});

describe("the peek's keys beside a terminal", () => {
  it("work while the terminal is not focused and stop while it is; Esc in a joined terminal is the session's", async () => {
    runnerApi(ada);
    renderApp("/account?task=WEB-3");
    const peek = await screen.findByRole("dialog", { name: "Task WEB-3" });
    const panel = await within(peek).findByRole("region", { name: "Session" });
    await connected();
    const input = within(panel).getByRole("group", { name: "Terminal of WEB-3" }).querySelector("textarea")!;

    // Watching: ? is the app's until the terminal has the focus; there Esc gives it back.
    await userEvent.click(input);
    await userEvent.keyboard("?");
    expect(screen.queryByRole("dialog", { name: /Shortcuts/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Task WEB-3" })).toBeInTheDocument();
    expect(document.activeElement).not.toBe(input);

    // Joined: Esc goes to the session, and the peek stays.
    await userEvent.click(within(panel).getByRole("button", { name: "Join" }));
    const joined = await connected(2);
    // xterm reads Escape by its keyCode, which user-event leaves 0; a browser sends 27.
    fireEvent.keyDown(document.activeElement!, { key: "Escape", code: "Escape", keyCode: 27 });
    expect(joined.typed()).toBe("\x1b");
    expect(screen.getByRole("dialog", { name: "Task WEB-3" })).toBeInTheDocument();

    // Away from the terminal, Esc closes the peek.
    act(() => (document.activeElement as HTMLElement).blur());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task WEB-3" })).not.toBeInTheDocument());
    expect(joined.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("offers an admin Nudge and Stop session in the ⋯ menu; Stop asks first and says it releases the Claim", async () => {
    const api = runnerApi(ada);
    renderApp("/account?task=WEB-3");
    const peek = await screen.findByRole("dialog", { name: "Task WEB-3" });
    await within(peek).findByRole("region", { name: "Session" });

    await userEvent.click(within(peek).getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Nudge" }));
    expect(await screen.findByText("builder nudged on WEB-3")).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/v1/runner/sessions/k-3/nudge")).toBe(true);

    await userEvent.click(within(peek).getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Stop session" }));
    const confirm = await screen.findByRole("dialog", { name: "Stop the session on WEB-3?" });
    expect(confirm).toHaveTextContent("builder's session ends now");
    expect(confirm).toHaveTextContent("Its Claim is released, with a Note saying so");
    expect(confirm).toHaveTextContent("Status → Todo");
    expect(confirm).toHaveTextContent("The session's log is attached as Evidence");
    expect(api.calls.some((c) => c.path.endsWith("/stop"))).toBe(false);
    await userEvent.click(within(confirm).getByRole("button", { name: "Stop session" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === "/v1/runner/sessions/k-3/stop")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stop the session on WEB-3?" })).not.toBeInTheDocument());
  });

  it("offers no Nudge or Stop to a Member who is not an admin", async () => {
    runnerApi(bob);
    renderApp("/account?task=WEB-3");
    const peek = await screen.findByRole("dialog", { name: "Task WEB-3" });
    await within(peek).findByRole("region", { name: "Session" });
    await userEvent.click(within(peek).getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "Open as page" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Nudge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Stop session" })).not.toBeInTheDocument();
  });
});
