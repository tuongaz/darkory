import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { LiveActivity } from "@/api/live";
import { Providers, Root } from "@/App";
import { mockApi } from "@/test/api";
import type { Task, Workflows } from "@/api/client";
import { ada, signedIn, task, web, wfId, wfStep, workflow, workflowsFixture } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { newQueryClient } from "@/queryClient";
import { RouteProjectContext } from "./currentProject";
import { FromWorkflow, ToProjectWorkflows } from "./routes";

// The Workflow's old addresses lead to the Workflows' (named-workflows-plan.md, Round 2): a
// `?workflow=` becomes the `:workflow` segment, a lone `?step=` names its Step's Workflow, and
// every other parameter is kept. Settings' Workflows pages lead into the app
// (shell-navigation-plan.md, Task 3): the list to the Project's list, one Workflow to its editor.

function Address() {
  const l = useLocation();
  return <output aria-label="Address">{l.pathname + l.search}</output>;
}

// WEB-2 is listed in Support; WEB-3 the server places in no Workflow; WEB-4 in Work, the one
// Workflow of a Project of one.
const scoped: Task[] = [task(2, { workflow_id: wfId.support }), task(3, { workflow_id: undefined }), task(4, { workflow_id: "wf-work" })];

function at(path: string, record: Workflows = workflowsFixture(web)) {
  mockApi({
    ...signedIn(ada),
    "GET /v1/projects/:project/workflow": record,
    "GET /v1/tasks/:task": ({ params }: { params: Record<string, string> }) => {
      const t = scoped.find((x) => x.key === params.task || x.id === params.task);
      return t ? { task: t, subtasks: [] } : new Response(JSON.stringify({ title: "not found" }), { status: 404 });
    },
  });
  render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects/:key/workflow" element={<FromWorkflow />} />
          <Route path="/settings/projects/:key/workflow" element={<FromWorkflow settings />} />
          {/* ProjectScope's part: the Project the key names, as the app gives it. */}
          <Route
            path="/settings/projects/:key"
            element={
              <RouteProjectContext value={web}>
                <Outlet />
              </RouteProjectContext>
            }
          >
            <Route path="workflows" element={<ToProjectWorkflows />} />
            <Route path="workflows/:workflow" element={<ToProjectWorkflows edit />} />
          </Route>
          <Route path="*" element={<Address />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Where the app lands from `path`. */
async function address(path: string, record?: Workflows) {
  at(path, record);
  return (await screen.findByLabelText("Address")).textContent;
}

describe("the Workflow's old addresses", () => {
  it("lead to the Workflows' list, live and in Settings", async () => {
    expect(await address("/projects/WEB/workflow")).toBe("/projects/WEB/workflows");
  });

  it("lead Settings' old address to the Project's list", async () => {
    expect(await address("/settings/projects/WEB/workflow")).toBe("/projects/WEB/workflows");
  });

  it("carry ?workflow= into the address as the Workflow's own, and keep ?step= and ?scope=", async () => {
    expect(await address(`/projects/WEB/workflow?workflow=${wfId.bugs}&step=${wfStep.fix}&scope=k-2`)).toBe(`/projects/WEB/workflows/${wfId.bugs}?step=${wfStep.fix}&scope=k-2`);
  });

  it("carry ?workflow= into the editor's address, keeping ?step=", async () => {
    expect(await address(`/settings/projects/WEB/workflow?workflow=${wfId.support}&step=${wfStep.ops}`)).toBe(`/projects/WEB/workflows/${wfId.support}/edit?step=${wfStep.ops}`);
  });

  it("open a lone ?step= in its own Workflow's editor", async () => {
    expect(await address(`/settings/projects/WEB/workflow?step=${wfStep.sketch}`)).toBe(`/projects/WEB/workflows/${wfId.prototypes}/edit?step=${wfStep.sketch}`);
  });

  it("open a lone ?step= on the live page in its own Workflow's page", async () => {
    expect(await address(`/projects/WEB/workflow?step=${wfStep.fix}`)).toBe(`/projects/WEB/workflows/${wfId.bugs}?step=${wfStep.fix}`);
  });

  it("open a lone ?scope= of a Project of several in the Workflow its Task is listed in, else the list", async () => {
    expect(await address("/projects/WEB/workflow?scope=WEB-2")).toBe(`/projects/WEB/workflows/${wfId.support}?scope=WEB-2`);
  });

  it("lead a ?scope= whose Task is in no Workflow to the list", async () => {
    expect(await address("/projects/WEB/workflow?scope=WEB-3")).toBe("/projects/WEB/workflows?scope=WEB-3");
  });

  it("lead a ?scope= of a Project of one to its one Workflow's page", async () => {
    expect(await address("/projects/WEB/workflow?scope=WEB-4", workflow())).toBe("/projects/WEB/workflows/wf-work?scope=WEB-4");
  });

  it("keep ?view= on the way to the list", async () => {
    expect(await address("/projects/WEB/workflow?view=text")).toBe("/projects/WEB/workflows?view=text");
  });

  it("lead the line's ?view= of a Project of one to its one Workflow's page", async () => {
    expect(await address("/projects/WEB/workflow?view=text", workflow())).toBe("/projects/WEB/workflows/wf-work?view=text");
  });

  it("lead a Filter of a Project of one to its one Workflow's page", async () => {
    expect(await address("/projects/WEB/workflow?filter.tasks=title%3Acontains%3Ax", workflow())).toBe("/projects/WEB/workflows/wf-work?filter.tasks=title%3Acontains%3Ax");
  });

  it("land Settings' old address of a Project of one with ?view= on the Workflow's page, through the list, not the editor", async () => {
    // The redirect itself goes to the list (line parameters mean nothing in the editor) ...
    expect(await address("/settings/projects/WEB/workflow?view=text", workflow())).toBe("/projects/WEB/workflows?view=text");
    cleanup();
    // ... and the list, in the app, sends it on to its one Workflow's page.
    appAt("/settings/projects/WEB/workflow?view=text", workflow());
    await waitFor(() => expect(here()).toBe("/projects/WEB/workflows/wf-work?view=text"));
    expect(screen.queryByRole("table", { name: "Workflows" })).toBeNull();
  });
});

/** The whole app at `path`, WEB's Workflows `record`, with where it is now read out beside it. */
function appAt(path: string, record: Workflows) {
  mockApi({
    ...signedIn(ada),
    "GET /v1/projects/:project/workflow": record,
    "GET /v1/tasks": { items: [] },
    "GET /v1/activity": { items: [], last_seq: 0 },
    "GET /v1/runner/sessions": { items: [], runner: false },
  });
  render(
    <Providers client={newQueryClient()} live={new LiveActivity()}>
      <MemoryRouter initialEntries={[path]}>
        <Root />
        <Address />
      </MemoryRouter>
    </Providers>,
  );
}
const here = () => screen.getByLabelText("Address").textContent;

describe("the Workflows list's address of round 2", () => {
  it("is the one Workflow's page of a Project of one when it says the line's ?view=", async () => {
    appAt("/projects/WEB/workflows?view=text", workflow());
    await waitFor(() => expect(here()).toBe("/projects/WEB/workflows/wf-work?view=text"));
    expect(screen.queryByRole("table", { name: "Workflows" })).toBeNull();
  });

  it("is the one Workflow's page of a Project of one when it says the filter's older ?skill=", async () => {
    appAt("/projects/WEB/workflows?skill=s-engineer", workflow());
    await waitFor(() => expect(here()).toBe("/projects/WEB/workflows/wf-work?skill=s-engineer"));
    expect(screen.queryByRole("table", { name: "Workflows" })).toBeNull();
  });

  it("stays the list of a Project of several, ?view= and all", async () => {
    appAt("/projects/WEB/workflows?view=text", workflowsFixture(web));
    expect(await screen.findByRole("table", { name: "Workflows" })).toBeInTheDocument();
    expect(here()).toBe("/projects/WEB/workflows?view=text");
  });

  it("stays the list of a Project of one when it says nothing of the line", async () => {
    appAt("/projects/WEB/workflows", workflow());
    expect(await screen.findByRole("table", { name: "Workflows" })).toBeInTheDocument();
    expect(here()).toBe("/projects/WEB/workflows");
  });
});

describe("Settings' Workflows pages", () => {
  it("lead the list to the Project's list", async () => {
    expect(await address("/settings/projects/WEB/workflows")).toBe("/projects/WEB/workflows");
  });

  it("lead one Workflow to its editor in the app, keeping ?step=", async () => {
    expect(await address(`/settings/projects/WEB/workflows/${wfId.bugs}?step=${wfStep.fix}`)).toBe(`/projects/WEB/workflows/${wfId.bugs}/edit?step=${wfStep.fix}`);
  });

  it("lead /admin/workflow to the current Project's list", async () => {
    mockApi({ ...signedIn(ada), "GET /v1/activity": { items: [], last_seq: 0 } });
    renderApp("/admin/workflow");
    expect(await screen.findByRole("table", { name: "Workflows" })).toBeInTheDocument();
  });
});

describe("the word", () => {
  it("is Workflows in the sidebar, the page's crumb and the list; the Edit button names the Workflow", async () => {
    mockApi({ ...signedIn(ada), "GET /v1/tasks": { items: [] }, "GET /v1/activity": { items: [], last_seq: 0 }, "GET /v1/runner/sessions": { items: [], runner: false } });
    const first = renderApp("/projects/WEB/workflows");
    expect(await screen.findByRole("table", { name: "Workflows" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Workflows")).toBeInTheDocument();
    const sidebar = screen.getAllByRole("link", { name: "Workflows" });
    expect(sidebar.some((l) => l.getAttribute("href") === "/projects/WEB/workflows")).toBe(true);
    first.unmount();
    // One Workflow's page: Edit names it and opens its editor in the app.
    renderApp("/projects/WEB/workflows/wf-work");
    expect(await screen.findByRole("link", { name: "Edit Work" })).toHaveAttribute("href", "/projects/WEB/workflows/wf-work/edit");
  });

  it("is no page of a Project's settings", async () => {
    mockApi(signedIn(ada));
    renderApp("/projects/WEB/settings/general");
    const tabs = await screen.findByRole("navigation", { name: "Project settings" });
    expect(within(tabs).getAllByRole("link").map((l) => l.textContent)).toEqual(["General", "Members", "Labels", "Workspaces"]);
  });
});
