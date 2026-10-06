import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AgentSettings, Member, MemberDetail } from "@/api/client";
import { json, mockApi, type Handler } from "@/test/api";
import { ada, bob, build, builder, signedIn, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { argsOf, envOf, envText } from "./agent";

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
  return { member, teams: [web], skills: [build], reports: [] };
}

/** The Members as the server keeps them: a PATCH of an agent's settings changes what the next read returns. */
function routes(members: Member[], extra: Record<string, Handler> = {}): Record<string, Handler> {
  const byId = new Map(members.map((m) => [m.id, m]));
  return {
    ...signedIn(),
    "GET /v1/members": () => ({ items: [...byId.values()] }),
    "GET /v1/members/:member": ({ params }) => detail(byId.get(params.member)!),
    "GET /v1/members/:member/tokens": { items: [] },
    "GET /v1/members/:member/sessions": { items: [] },
    "PATCH /v1/members/:member/agent": ({ params, body }) => {
      const m = byId.get(params.member)!;
      const next = { ...m, agent: { ...(m.agent ?? settings), ...(body as Partial<AgentSettings>) } };
      byId.set(m.id, next);
      return next;
    },
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

  it("shows the settings, and saves each field on its own when it is left", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes([ada, bob, runBuilder]));
    renderApp("/admin/members/m-builder");
    const card = await screen.findByRole("group", { name: "Agent settings of builder" });
    expect(within(card).getByLabelText("Command")).toHaveValue("claude");
    expect(within(card).getByLabelText("Arguments")).toHaveValue("--session-id\n{session_id}\n--model\n{model}");
    expect(within(card).getByLabelText("Model")).toHaveValue("claude-sonnet-5-5");
    expect(within(card).getByLabelText("Environment")).toHaveValue("HTTP_PROXY = http://proxy:3128");
    expect(within(card).getByLabelText("Progress file")).toHaveValue("");
    for (const p of ["{session_id}", "{model}", "{prompt_file}", "{mcp_config}", "{workspace}", "{task}"]) {
      expect(within(card).getByText(p)).toBeInTheDocument();
    }
    // The model field suggests the known ids.
    expect(within(card).getByLabelText("Model")).toHaveAttribute("list", "agent-models");
    expect([...document.querySelectorAll("#agent-models option")].map((o) => o.getAttribute("value"))).toContain("claude-opus-5-5");

    const model = within(card).getByLabelText("Model");
    await user.clear(model);
    await user.type(model, "claude-opus-5-5{Enter}");
    await waitFor(() => expect(patches(api.calls)).toHaveLength(1));

    const command = within(card).getByLabelText("Command");
    await user.clear(command);
    await user.type(command, "/usr/local/bin/my-agent");
    await user.tab();
    await waitFor(() => expect(patches(api.calls)).toHaveLength(2));

    const args = within(card).getByLabelText("Arguments");
    await user.clear(args);
    await user.type(args, "--task{Enter}{{task}{Enter}{Enter}--prompt{Enter}{{prompt_file}");
    await user.tab();
    await waitFor(() => expect(patches(api.calls)).toHaveLength(3));

    const env = within(card).getByLabelText("Environment");
    await user.clear(env);
    await user.type(env, "HTTP_PROXY = http://proxy:3128{Enter}LOG_LEVEL=debug");
    await user.tab();
    await waitFor(() => expect(patches(api.calls)).toHaveLength(4));

    const progress = within(card).getByLabelText("Progress file");
    await user.type(progress, "{{workspace}/progress.log{Enter}");
    await waitFor(() => expect(patches(api.calls)).toHaveLength(5));

    await user.click(within(card).getByRole("switch", { name: "Paused" }));
    await waitFor(() => expect(patches(api.calls)).toHaveLength(6));
    await user.click(within(card).getByRole("switch", { name: "Unattended" }));
    await waitFor(() => expect(patches(api.calls)).toHaveLength(7));

    expect(patches(api.calls).map((c) => c.path)).toEqual(Array(7).fill("/v1/members/m-builder/agent"));
    expect(patches(api.calls).map((c) => c.body)).toEqual([
      { model: "claude-opus-5-5" },
      { command: "/usr/local/bin/my-agent" },
      { args: ["--task", "{task}", "--prompt", "{prompt_file}"] },
      { env: { HTTP_PROXY: "http://proxy:3128", LOG_LEVEL: "debug" } },
      { progress_file: "{workspace}/progress.log" },
      { paused: true },
      { unattended: false },
    ]);
    // Paused shows on the page's head.
    expect(await screen.findByText("Paused", { selector: "[data-tone]" })).toBeInTheDocument();
  });

  it("sends nothing for a field left as it was, a blank command or a line /v1 would refuse", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes([ada, bob, runBuilder]));
    renderApp("/admin/members/m-builder");
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

  it("hands an agent with no settings to the Runner with the Install's defaults", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes([ada, bob, builder]));
    renderApp("/admin/members/m-builder");
    const card = await screen.findByRole("group", { name: "Agent settings of builder" });
    expect(card).toHaveTextContent("the Runner does not start it");
    await user.click(within(card).getByRole("button", { name: "Use the Runner" }));
    expect(await screen.findByLabelText("Command")).toHaveValue("claude");
    expect(patches(api.calls).map((c) => c.body)).toEqual([{}]);
  });

  it("a human has no Agent card", async () => {
    mockApi(routes([ada, bob, runBuilder]));
    renderApp("/admin/members/m-bob");
    expect(await screen.findByRole("heading", { name: "bob" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agent" })).not.toBeInTheDocument();
  });
});

describe("Members and agents", () => {
  it("shows an agent's model and marks a paused one", async () => {
    mockApi(routes([ada, bob, runBuilder, pausedReviewer]));
    renderApp("/admin/members");
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
    renderApp("/admin/members?new=1&kind=agent");
    const dialog = await screen.findByRole("dialog", { name: "New Member" });
    const model = within(dialog).getByLabelText("Model");
    expect(model).toHaveValue("claude-sonnet-5-5");
    expect(within(dialog).getByText("The Runner starts it with the Install's default command.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "builder-9");
    await user.clear(model);
    await user.type(model, "claude-opus-5-5");
    await user.click(within(dialog).getByRole("button", { name: "Create Member" }));

    expect(await screen.findByRole("dialog", { name: "Token for builder-9" })).toBeInTheDocument();
    const writes = api.calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/members", "POST /v1/members/m-new/tokens", "PATCH /v1/members/m-new/agent"]);
    expect(writes[2].body).toEqual({ model: "claude-opus-5-5" });
  });

  it("New Member asks a human no model", async () => {
    mockApi(routes([ada, bob]));
    renderApp("/admin/members?new=1");
    const dialog = await screen.findByRole("dialog", { name: "New Member" });
    expect(within(dialog).queryByLabelText("Model")).not.toBeInTheDocument();
  });
});
