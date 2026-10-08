import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AgentSettings, Member, MemberDetail } from "@/api/client";
import { json, mockApi, type Handler } from "@/test/api";
import { ada, bob, builder, engineer, signedIn, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { argsOf, envOf, envText, runnerNow } from "./agent";

const at = "2026-10-01T09:00:00Z";
const settings: AgentSettings = {
  command: "claude",
  args: ["--session-id", "{session_id}", "--model", "{model}"],
  model: "claude-sonnet-5-5",
  env: { HTTP_PROXY: "http://proxy:3128" },
  unattended: true,
  paused: false,
};
const runBuilder: Member = { ...builder, agent: settings };
const pausedReviewer: Member = { id: "m-reviewer", name: "reviewer", kind: "agent", admin: false, created_at: at, agent: { ...settings, model: "claude-opus-5-5", paused: true } };

function detail(member: Member): MemberDetail {
  return { member, projects: [web], skills: [engineer], reports: [] };
}

/** The Members as the server keeps them: a PATCH of an agent's settings changes what the next read returns. */
function routes(members: Member[], extra: Record<string, Handler> = {}): Record<string, Handler> {
  const byId = new Map(members.map((m) => [m.id, m]));
  return {
    ...signedIn(),
    "GET /v1/members": () => ({ items: [...byId.values()] }),
    "GET /v1/members/:member": ({ params }) => detail(byId.get(params.member)!),
    "GET /v1/members/:member/tokens": { items: [] },
    "GET /v1/members/:member/sessions": { items: [], open: 0, ended: 0 },
    "PATCH /v1/members/:member/agent": ({ params, body }) => {
      const m = byId.get(params.member)!;
      const next = { ...m, agent: { ...(m.agent ?? settings), ...(body as Partial<AgentSettings>) } };
      byId.set(m.id, next);
      return next;
    },
    "DELETE /v1/members/:member/agent": ({ params }) => {
      const m: Member = { ...byId.get(params.member)!, agent: undefined };
      byId.set(m.id, m);
      return m;
    },
    "PUT /v1/projects/:project/members/:member": undefined,
    ...extra,
  };
}

const patches = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "PATCH");

describe("an agent's settings", () => {
  it("reads one KEY = value per line, and says what /v1 would refuse", () => {
    expect(argsOf("--model\n{model}\n\n  --verbose  \n")).toEqual(["--model", "{model}", "--verbose"]);
    expect(envOf("A = 1\n\nB=two = 2\n")).toEqual({ env: { A: "1", B: "two = 2" } });
    expect(envOf("A = 1\nB")).toEqual({ problem: "Line 2 needs a value: KEY = value." });
    expect(envOf("1A = x")).toEqual({ problem: "Line 1: “1A” is not a variable's name." });
    expect(envOf("DARKORY_TOKEN = x")).toEqual({ problem: "Line 1: the Runner sets DARKORY_TOKEN itself." });
    expect(envOf("A = 1\nA = 2")).toEqual({ problem: "Line 2: A is named twice." });
    expect(envText({ A: "1", B: "2" })).toBe("A = 1\nB = 2");
  });

  it("says the Runner's state now apart from the setting, never that it starts the agent when nothing will", () => {
    expect(runnerNow({ runner: false, session: undefined, paused: false })).toMatch(/^Not running: no Runner runs beside this server/);
    expect(runnerNow({ runner: true, session: undefined, paused: true })).toMatch(/^Not running: paused/);
    expect(runnerNow({ runner: true, session: undefined, paused: false })).toBe("Not running now. The Runner beside this server starts this agent's command whenever it has a Task to take.");
    expect(runnerNow({ runner: undefined, session: undefined, paused: false })).toBe("");
  });

  // Typing without a pause between keys: these tests type whole command lines.
  const typist = () => userEvent.setup({ delay: null });

  it("shows the settings with the placeholders and the model ids it suggests", async () => {
    mockApi(routes([ada, bob, runBuilder]));
    renderApp("/settings/organisation/agents/m-builder");
    const card = await screen.findByRole("group", { name: "Agent settings of builder" });
    expect(within(card).getByLabelText("Command")).toHaveValue("claude");
    expect(within(card).getByLabelText("Arguments")).toHaveValue("--session-id\n{session_id}\n--model\n{model}");
    expect(within(card).getByLabelText("Model")).toHaveValue("claude-sonnet-5-5");
    expect(within(card).getByLabelText("Environment")).toHaveValue("HTTP_PROXY = http://proxy:3128");
    expect(within(card).getByLabelText("Progress file")).toHaveValue("");
    expect(within(card).getByRole("switch", { name: "Unattended" })).toBeChecked();
    // The Runner row says the setting, and whether a Runner runs it now: with none beside the
    // server, nothing starts it, as the Agents page's "Not running" says; ⓘ says more.
    expect(card).toHaveTextContent("In use");
    expect(card).toHaveTextContent("Not running: no Runner runs beside this server, so nothing starts this agent's command until one does.");
    expect(card).not.toHaveTextContent("whenever it has a Task to take");
    expect(within(card).getByRole("button", { name: "About the Runner" })).toBeInTheDocument();
    // The page in cards, the Agent's first and pausing and deactivating last, where Paused is.
    expect(screen.getAllByRole("region", { name: (n) => !n.startsWith("Notifications") }).map((r) => r.getAttribute("aria-label"))).toEqual(["Agent", "Work", "Access", "Profile", "Pause and deactivate"]);
    expect(screen.getByRole("region", { name: "Agent" })).toHaveTextContent("How the Runner starts this agent's Shifts.");
    const stop = screen.getByRole("region", { name: "Pause and deactivate" });
    expect(within(stop).getByRole("switch", { name: "Paused" })).not.toBeChecked();
    expect(within(stop).getByRole("button", { name: "Deactivate builder" })).toBeInTheDocument();
    for (const p of ["{session_id}", "{model}", "{prompt_file}", "{mcp_config}", "{workspace}", "{task}"]) {
      expect(within(card).getByText(p)).toBeInTheDocument();
    }
    expect(within(card).getByLabelText("Model")).toHaveAttribute("list", "agent-models");
    expect([...document.querySelectorAll("#agent-models option")].map((o) => o.getAttribute("value"))).toContain("claude-opus-5-5");
  });

  it("saves a one-line field on its own when it is left or on Enter", async () => {
    const user = typist();
    const api = mockApi(routes([ada, bob, runBuilder]));
    renderApp("/settings/organisation/agents/m-builder");
    const card = await screen.findByRole("group", { name: "Agent settings of builder" });

    const model = within(card).getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "claude-opus-5-5{Enter}");
    await waitFor(() => expect(patches(api.calls)).toHaveLength(1));

    const command = within(card).getByLabelText("Command");
    await user.clear(command);
    await user.type(command, "/usr/local/bin/my-agent");
    await user.tab();
    await waitFor(() => expect(patches(api.calls)).toHaveLength(2));

    await user.type(within(card).getByLabelText("Progress file"), "{{workspace}/progress.log{Enter}");
    await waitFor(() => expect(patches(api.calls)).toHaveLength(3));

    expect(patches(api.calls).map((c) => c.path)).toEqual(Array(3).fill("/v1/members/m-builder/agent"));
    expect(patches(api.calls).map((c) => c.body)).toEqual([
      { model: "claude-opus-5-5" },
      { command: "/usr/local/bin/my-agent" },
      { progress_file: "{workspace}/progress.log" },
    ]);
  });

  it("saves the arguments and the environment whole, one per line, when left", async () => {
    const user = typist();
    const api = mockApi(routes([ada, bob, runBuilder]));
    renderApp("/settings/organisation/agents/m-builder");
    const card = await screen.findByRole("group", { name: "Agent settings of builder" });

    const args = within(card).getByLabelText("Arguments");
    await user.clear(args);
    await user.type(args, "--task{Enter}{{task}{Enter}{Enter}--prompt{Enter}{{prompt_file}");
    await user.tab();
    await waitFor(() => expect(patches(api.calls)).toHaveLength(1));

    const env = within(card).getByLabelText("Environment");
    await user.type(env, "{Enter}LOG_LEVEL=debug");
    await user.tab();
    await waitFor(() => expect(patches(api.calls)).toHaveLength(2));

    expect(patches(api.calls).map((c) => c.body)).toEqual([
      { args: ["--task", "{task}", "--prompt", "{prompt_file}"] },
      { env: { HTTP_PROXY: "http://proxy:3128", LOG_LEVEL: "debug" } },
    ]);
  });

  it("pauses the agent and sets Unattended with their switches", async () => {
    const user = typist();
    const api = mockApi(routes([ada, bob, runBuilder]));
    renderApp("/settings/organisation/agents/m-builder");
    const card = await screen.findByRole("group", { name: "Agent settings of builder" });
    await user.click(within(screen.getByRole("region", { name: "Pause and deactivate" })).getByRole("switch", { name: "Paused" }));
    await waitFor(() => expect(patches(api.calls)).toHaveLength(1));
    await user.click(within(card).getByRole("switch", { name: "Unattended" }));
    await waitFor(() => expect(patches(api.calls)).toHaveLength(2));
    expect(patches(api.calls).map((c) => c.body)).toEqual([{ paused: true }, { unattended: false }]);
    // Paused shows on the page's head.
    expect(await screen.findByText("Paused", { selector: "[data-tone]" })).toBeInTheDocument();
  });

  it("sends nothing for a field left as it was, a blank command or a line /v1 would refuse", async () => {
    const user = typist();
    const api = mockApi(routes([ada, bob, runBuilder]));
    renderApp("/settings/organisation/agents/m-builder");
    const card = await screen.findByRole("group", { name: "Agent settings of builder" });
    await user.click(within(card).getByLabelText("Model"));
    await user.tab();
    await user.clear(within(card).getByLabelText("Command"));
    await user.tab();
    expect(within(card).getByLabelText("Command")).toHaveValue("claude");

    const env = within(card).getByLabelText("Environment");
    await user.type(env, "{Enter}DARKORY_URL = http://elsewhere");
    await user.tab();
    expect(await within(card).findByRole("alert")).toHaveTextContent("invalid Line 2: the Runner sets DARKORY_URL itself.");
    expect(env).toHaveAttribute("aria-invalid", "true");
    expect(patches(api.calls)).toHaveLength(0);
  });

  it("says whether a Runner runs the agent now: running, not running with one beside the server, or paused", async () => {
    const running = { task_id: "k-3", member_id: runBuilder.id, session_id: "s-1", host: "mac-mini", tmux: "dk-WEB-3", started_at: at, state: "running" as const, state_since: at, log_path: "/tmp/log" };
    mockApi(routes([ada, bob, runBuilder, pausedReviewer], { "GET /v1/runner/sessions": { items: [running], runner: true } }));
    renderApp("/settings/organisation/agents/m-builder");
    let card = await screen.findByRole("group", { name: "Agent settings of builder" });
    expect(await within(card).findByText("Its Shift is running now, on mac-mini.")).toBeInTheDocument();

    mockApi(routes([ada, bob, runBuilder, pausedReviewer], { "GET /v1/runner/sessions": { items: [], runner: true } }));
    renderApp("/settings/organisation/agents/m-reviewer");
    card = await screen.findByRole("group", { name: "Agent settings of reviewer" });
    expect(await within(card).findByText("Not running: paused, so the Runner starts no new Shift for it.")).toBeInTheDocument();
  });

  it("hands an agent with no settings to the Runner with the Install's defaults", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes([ada, bob, builder]));
    renderApp("/settings/organisation/agents/m-builder");
    const card = await screen.findByRole("group", { name: "Agent settings of builder" });
    expect(card).toHaveTextContent("the Runner does not start it");
    expect(card).toHaveTextContent("In use, the Runner beside this server starts the agent's command whenever it has a Task to take.");
    // No Paused until the Runner starts it.
    expect(screen.queryByRole("switch", { name: "Paused" })).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Use the Runner" }));
    expect(await screen.findByLabelText("Command")).toHaveValue("claude");
    expect(patches(api.calls).map((c) => c.body)).toEqual([{}]);
  });

  it("Stop using the Runner, behind ⋯, says what it clears, then clears the settings", async () => {
    const user = typist();
    const api = mockApi(routes([ada, bob, runBuilder]));
    renderApp("/settings/organisation/agents/m-builder");
    await screen.findByRole("group", { name: "Agent settings of builder" });
    await user.click(screen.getByRole("button", { name: "More for the Agent settings of builder" }));
    await user.click(await screen.findByRole("menuitem", { name: "Stop using the Runner" }));
    const confirm = await screen.findByRole("dialog", { name: "Stop using the Runner for builder?" });
    expect(confirm).toHaveTextContent("Clearsclaude4 argumentsclaude-sonnet-5-51 variable");
    expect(confirm).toHaveTextContent("The Runner starts no new Shift for builder, which works through its own tokens; one running carries on until its Claim ends.");
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(within(confirm).getByRole("button", { name: "Stop using the Runner" }));
    expect(await screen.findByRole("button", { name: "Use the Runner" })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/members/m-builder/agent"]);
    // Nothing left to stop.
    expect(screen.queryByRole("button", { name: "More for the Agent settings of builder" })).not.toBeInTheDocument();
  });

  it("a human has no Agent card", async () => {
    mockApi(routes([ada, bob, runBuilder]));
    renderApp("/settings/organisation/members/m-bob");
    expect(await screen.findByRole("heading", { name: "bob" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agent" })).not.toBeInTheDocument();
  });
});

describe("Members and agents", () => {
  it("shows an agent's model and marks a paused one", async () => {
    mockApi(routes([ada, bob, runBuilder, pausedReviewer]));
    renderApp("/settings/organisation/members");
    const table = await screen.findByRole("table", { name: "Members" });
    expect(within(table).getByRole("columnheader", { name: "Model" })).toBeInTheDocument();
    const b = within(table).getByRole("row", { name: "builder" });
    expect(within(b).getByText("claude-sonnet-5-5")).toBeInTheDocument();
    expect(within(b).queryByText("Paused")).not.toBeInTheDocument();
    const r = within(table).getByRole("row", { name: "reviewer" });
    expect(within(r).getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(within(r).getByText("Paused")).toBeInTheDocument();
  });

  it("New Member asks an agent's model and sets it after the token, on the default command", async () => {
    const user = userEvent.setup();
    const created: Member = { id: "m-new", name: "builder-9", kind: "agent", admin: false, created_at: at };
    const api = mockApi(
      routes([ada, bob, runBuilder, created], {
        "POST /v1/members": json(201, created),
        "POST /v1/members/:member/tokens": json(201, { token: { id: "t-1", member_id: "m-new", name: "default", prefix: "dk_s3cr", created_at: at }, secret: "dk_s3cret" }),
      }),
    );
    renderApp("/settings/organisation/members?new=1&kind=agent");
    const dialog = await screen.findByRole("dialog", { name: "New Member" });
    expect(within(dialog).getByRole("switch", { name: "Run with the Runner" })).toBeChecked();
    expect(within(dialog).getByText("The Runner starts its Shifts with the Install's default command.")).toBeInTheDocument();
    const model = within(dialog).getByLabelText("Model");
    expect(model).toHaveValue("claude-sonnet-5-5");
    await user.type(within(dialog).getByLabelText("Name"), "builder-9");
    await user.clear(model);
    await user.type(model, "claude-opus-5-5");
    await user.click(within(dialog).getByRole("button", { name: "Create Member" }));

    expect(await screen.findByRole("dialog", { name: "Token for builder-9" })).toBeInTheDocument();
    const writes = api.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/members",
      "POST /v1/members/m-new/tokens",
      "PATCH /v1/members/m-new/agent",
      // The Project the app is in, ticked to start with.
      "PUT /v1/projects/WEB/members/m-new",
    ]);
    expect(writes[2].body).toEqual({ model: "claude-opus-5-5" });
  });

  it("New Member with Run with the Runner off makes an agent with no settings, for one that brings its own session", async () => {
    const user = userEvent.setup();
    const created: Member = { id: "m-bot", name: "bot-1", kind: "agent", admin: false, created_at: at };
    const api = mockApi(
      routes([ada, bob, created], {
        "POST /v1/members": json(201, created),
        "POST /v1/members/:member/tokens": json(201, { token: { id: "t-2", member_id: "m-bot", name: "default", prefix: "dk_b0t", created_at: at }, secret: "dk_b0t" }),
      }),
    );
    renderApp("/settings/organisation/members?new=1&kind=agent");
    const dialog = await screen.findByRole("dialog", { name: "New Member" });
    await user.type(within(dialog).getByLabelText("Name"), "bot-1");
    await user.click(within(dialog).getByRole("switch", { name: "Run with the Runner" }));
    expect(within(dialog).queryByLabelText("Model")).not.toBeInTheDocument();
    expect(within(dialog).getByText("It works through its own token; the Runner does not start it.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Create Member" }));

    expect(await screen.findByRole("dialog", { name: "Token for bot-1" })).toBeInTheDocument();
    const writes = api.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/members", "POST /v1/members/m-bot/tokens", "PUT /v1/projects/WEB/members/m-bot"]);
  });

  it("New Member asks a human no model", async () => {
    mockApi(routes([ada, bob]));
    renderApp("/settings/organisation/members?new=1");
    const dialog = await screen.findByRole("dialog", { name: "New Member" });
    expect(within(dialog).queryByLabelText("Model")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("switch", { name: "Run with the Runner" })).not.toBeInTheDocument();
  });
});
