import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Skill, SkillProposal } from "@/api/client";
import { json, mockApi, refuse, type Handler } from "@/test/api";
import { ada, bob, builder, detail, engineer, memberDetail, review, signedIn, skills, skillVersion, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const at = "2026-10-01T09:00:00Z";
const webEngineer: Skill = { id: "s-web-engineer", name: "web-engineer", kind: "company", base_skill_id: engineer.id, project_id: web.id, builtin: false, current_version: 2, created_at: at };
/** A company Skill of the whole Organisation. */
const playbook: Skill = { id: "s-playbook", name: "playbook", kind: "company", base_skill_id: engineer.id, builtin: false, current_version: 1, created_at: at };
const proposal = (id: string, retroId: string, body: string, created_at: string, author = builder.id): SkillProposal => ({
  id,
  skill_id: webEngineer.id,
  task_id: retroId,
  based_on_version: 2,
  body,
  author_id: author,
  state: "pending",
  created_at,
});

const v1 = skillVersion(webEngineer, 1, "1. Reuse the cart component.\n");
const v2 = skillVersion(webEngineer, 2, "1. Reuse the cart component.\n2. Ship behind a flag.\n");

/** Two open Retrospectives, each proposing a change to web-engineer; the older one also a superseded one. */
const retro1 = task(7, { kind: "retrospective", title: "Retrospective: checkout", step_id: "st-retro" });
const retro2 = task(8, { kind: "retrospective", title: "Retrospective: search", step_id: "st-retro" });
const p1 = proposal("p-1", retro1.id, "1. Reuse the cart component.\n2. Ship behind a flag.\n3. Point e2e at Mailpit.\n", "2026-10-02T09:00:00Z");
const p2 = proposal("p-2", retro2.id, "1. Reuse the cart component.\n", "2026-10-03T09:00:00Z", ada.id);
const old: SkillProposal = { ...p1, id: "p-0", state: "superseded", body: "never mind" };

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  const all = [...skills, webEngineer, playbook];
  return {
    ...signedIn(),
    "GET /v1/skills": { items: all },
    "GET /v1/skills/:skill": ({ params }) => {
      const s = all.find((x) => x.name === params.skill) ?? { ...webEngineer, id: "s-ops", name: params.skill, current_version: 1 };
      return { skill: s, current: s.id === webEngineer.id ? v2 : skillVersion(s) };
    },
    "GET /v1/skills/:skill/versions": ({ params }) => ({ items: params.skill === webEngineer.name ? [v2, v1] : [] }),
    "GET /v1/members/:member": ({ params }) => {
      const m = [ada, bob, builder].find((x) => x.id === params.member)!;
      return memberDetail(m, { skills: m.id === bob.id ? [engineer] : [webEngineer, review] });
    },
    "GET /v1/tasks": ({ query }) => {
      const filters = query.getAll("filter");
      if (filters.includes("kind:is:retrospective")) return { items: [retro1, retro2] };
      if (filters.includes(`skill:is:${webEngineer.id}`)) return { items: [task(3, { skill_id: webEngineer.id })] };
      return { items: [] };
    },
    "GET /v1/tasks/:task": ({ params }) =>
      params.task === retro1.key
        ? detail(retro1, { proposals: [old, p1], notes: [{ id: "n-1", task_id: retro1.id, author_id: builder.id, body: "Mailpit caught the flake.", created_at: "2026-10-02T09:05:00Z" }] })
        : detail(retro2, { proposals: [p2] }),
    ...extra,
  };
}

describe("Settings › Skills", () => {
  it("lists every Skill with what it builds on, who holds it and how many proposals wait", async () => {
    mockApi(routes());
    renderApp("/settings/organisation/skills");
    const table = await screen.findByRole("table", { name: "Skills" });
    const row = within(table).getByRole("row", { name: "web-engineer" });
    expect(within(row).getByText("engineer")).toBeInTheDocument();
    expect(within(row).getByText("version 2")).toBeInTheDocument();
    expect(await within(row).findByText("2 proposals")).toBeInTheDocument();
    expect(await within(row).findByText("2 Members")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "web-engineer" })).toHaveAttribute("href", "/settings/organisation/skills/web-engineer");
    expect(within(within(table).getByRole("row", { name: "acceptance" })).getByText("Built in")).toBeInTheDocument();
  });

  it("says the Project a company Skill belongs to: its key, or Organisation; a generic Skill has none", async () => {
    mockApi(routes());
    renderApp("/settings/organisation/skills");
    const table = await screen.findByRole("table", { name: "Skills" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toContain("Project");
    const column = within(table)
      .getAllByRole("columnheader")
      .findIndex((h) => h.textContent === "Project");
    const cell = (name: string) => within(within(table).getByRole("row", { name })).getAllByRole("cell")[column];
    expect(await within(cell("web-engineer")).findByText("WEB")).toBeInTheDocument();
    expect(cell("playbook")).toHaveTextContent("Organisation");
    expect(cell("engineer")).toHaveTextContent("—");
  });

  it("an admin moves a company Skill to a Project from its page", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes({ "PATCH /v1/skills/:skill": { skill: { ...playbook, project_id: web.id }, current: skillVersion(playbook) } }));
    renderApp("/settings/organisation/skills/playbook");
    const about = await screen.findByRole("complementary", { name: "About the Skill" });
    const select = await within(about).findByRole("combobox", { name: "Project" });
    expect(select).toHaveTextContent("Organisation");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "WEB Web" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(api.calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/v1/skills/playbook", body: { project: web.id } });
  });

  it("a refusal to move a company Skill says why under its Project", async () => {
    const user = userEvent.setup();
    mockApi(routes({ "PATCH /v1/skills/:skill": refuse(400, "invalid", "WEB's Workflow carries web-engineer at Build") }));
    renderApp("/settings/organisation/skills/web-engineer");
    const about2 = await screen.findByRole("complementary", { name: "About the Skill" });
    const select2 = await within(about2).findByRole("combobox", { name: "Project" });
    await waitFor(() => expect(select2).toHaveTextContent("WEB"));
    await user.click(select2);
    await user.click(await screen.findByRole("option", { name: "Organisation" }));
    expect(await within(about2).findByText(/WEB's Workflow carries web-engineer at Build/)).toBeInTheDocument();
  });

  it("a generic Skill's page names no Project", async () => {
    mockApi(routes());
    renderApp("/settings/organisation/skills/engineer");
    const generic = await screen.findByRole("complementary", { name: "About the Skill" });
    expect(within(generic).queryByText("Project")).not.toBeInTheDocument();
  });

  it("a Skill's page shows each pending proposal, oldest first, against the version it was written on", async () => {
    mockApi(routes());
    renderApp("/settings/organisation/skills/web-engineer");
    expect(await screen.findByRole("heading", { name: "web-engineer" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Settings/Skills/web-engineer");
    expect(screen.getByRole("region", { name: "Current text" })).toHaveTextContent("2. Ship behind a flag.");

    const first = await screen.findByRole("region", { name: "Proposal from WEB-7" });
    const second = await screen.findByRole("region", { name: "Proposal from WEB-8" });
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(first).getByLabelText("Changes")).toHaveTextContent("Added: 3. Point e2e at Mailpit.");
    expect(within(first).getByText("Mailpit caught the flake.")).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: /Open Task/ })).toHaveAttribute("href", "/tasks/WEB-7");
    expect(within(second).getByLabelText("Changes")).toHaveTextContent("Removed: 2. Ship behind a flag.");
    // The superseded one is not waiting for anyone.
    expect(screen.queryByText("never mind")).not.toBeInTheDocument();

    const about = screen.getByRole("complementary", { name: "About the Skill" });
    expect(within(about).getByRole("link", { name: "engineer" })).toHaveAttribute("href", "/settings/organisation/skills/engineer");
    expect(await within(about).findByRole("link", { name: "WEB-3" })).toHaveAttribute("href", "/tasks/WEB-3");
    const versions = within(about).getByRole("list", { name: "Versions" });
    expect(within(versions).getAllByRole("listitem").map((l) => l.textContent?.slice(0, 9))).toEqual(["Version 2", "Version 1"]);
    expect(within(versions).getByText("Current")).toBeInTheDocument();
  });

  it("New Skill names a company Skill's generic one and publishes the text as version 1", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes({ "POST /v1/skills": json(201, { skill: { ...webEngineer, id: "s-ops", name: "ops-engineer", current_version: 1 }, current: v1 }) }));
    renderApp("/settings/organisation/skills");
    await user.click(await screen.findByRole("button", { name: "New Skill" }));
    const dialog = await screen.findByRole("dialog", { name: "New Skill" });
    await user.type(within(dialog).getByLabelText("Name"), "Ops Engineer");
    expect(within(dialog).getByText("Small letters, digits and dashes, as in web-qa.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "ops-engineer");
    await user.click(within(dialog).getByRole("radio", { name: "Company" }));
    await user.type(within(dialog).getByLabelText("Text"), "Run the playbook.");
    expect(within(dialog).getByRole("button", { name: "Create Skill" })).toBeDisabled();
    await user.click(within(dialog).getByRole("combobox", { name: "Builds on" }));
    await user.click(await screen.findByRole("option", { name: "engineer" }));
    await user.click(within(dialog).getByRole("button", { name: "Create Skill" }));

    await waitFor(() => expect(api.calls.some((c) => c.method === "POST")).toBe(true));
    expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({ name: "ops-engineer", kind: "company", base_skill: "engineer", body: "Run the playbook." });
    expect(await screen.findByRole("heading", { name: "ops-engineer" })).toBeInTheDocument();
  });

  it("New Skill asks a company Skill's Project, Organisation unless picked, and a generic one none", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes({ "POST /v1/skills": json(201, { skill: { ...webEngineer, id: "s-ops", name: "ops-engineer", current_version: 1 }, current: v1 }) }));
    renderApp("/settings/organisation/skills");
    await user.click(await screen.findByRole("button", { name: "New Skill" }));
    const dialog = await screen.findByRole("dialog", { name: "New Skill" });
    expect(within(dialog).queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "ops-engineer");
    await user.click(within(dialog).getByRole("radio", { name: "Company" }));
    await user.type(within(dialog).getByLabelText("Text"), "Run the playbook.");
    await user.click(within(dialog).getByRole("combobox", { name: "Builds on" }));
    await user.click(await screen.findByRole("option", { name: "engineer" }));
    const project = within(dialog).getByRole("combobox", { name: "Project" });
    expect(project).toHaveTextContent("Organisation");
    await user.click(project);
    await user.click(await screen.findByRole("option", { name: "WEB Web" }));
    await user.click(within(dialog).getByRole("button", { name: "Create Skill" }));

    await waitFor(() => expect(api.calls.some((c) => c.method === "POST")).toBe(true));
    expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({ name: "ops-engineer", kind: "company", base_skill: "engineer", project: web.id, body: "Run the playbook." });
  });
});
