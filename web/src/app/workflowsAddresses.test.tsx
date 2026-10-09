import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { mockApi } from "@/test/api";
import type { Task, Workflows } from "@/api/client";
import { ada, signedIn, task, web, wfId, wfStep, workflow, workflowsFixture } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { newQueryClient } from "@/queryClient";
import { FromWorkflow } from "./routes";

// The Workflow's old addresses lead to the Workflows' (named-workflows-plan.md, Round 2): a
// `?workflow=` becomes the `:workflow` segment, a lone `?step=` names its Step's Workflow, and
// every other parameter is kept.

function Address() {
  const l = useLocation();
  return <output aria-label="Address">{l.pathname + l.search}</output>;
}

// WEB-2 is listed in Support; WEB-3 the server places in no Workflow.
const scoped: Task[] = [task(2, { workflow_id: wfId.support }), task(3, { workflow_id: undefined })];

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

  it("lead to Settings' list of the Workflows", async () => {
    expect(await address("/settings/projects/WEB/workflow")).toBe("/settings/projects/WEB/workflows");
  });

  it("carry ?workflow= into the address as the Workflow's own, and keep ?step= and ?scope=", async () => {
    expect(await address(`/projects/WEB/workflow?workflow=${wfId.bugs}&step=${wfStep.fix}&scope=k-2`)).toBe(`/projects/WEB/workflows/${wfId.bugs}?step=${wfStep.fix}&scope=k-2`);
  });

  it("carry ?workflow= into the editor's address, keeping ?step=", async () => {
    expect(await address(`/settings/projects/WEB/workflow?workflow=${wfId.support}&step=${wfStep.ops}`)).toBe(`/settings/projects/WEB/workflows/${wfId.support}?step=${wfStep.ops}`);
  });

  it("open a lone ?step= in its own Workflow's editor", async () => {
    expect(await address(`/settings/projects/WEB/workflow?step=${wfStep.sketch}`)).toBe(`/settings/projects/WEB/workflows/${wfId.prototypes}?step=${wfStep.sketch}`);
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

  it("lead a ?scope= of a Project of one to its page", async () => {
    expect(await address("/projects/WEB/workflow?scope=WEB-2", workflow())).toBe("/projects/WEB/workflows?scope=WEB-2");
  });

  it("keep ?view= on the way to the list", async () => {
    expect(await address("/projects/WEB/workflow?view=text")).toBe("/projects/WEB/workflows?view=text");
  });
});

describe("the word", () => {
  it("is Workflows in the sidebar, the page's crumb, Settings' nav and the Edit button", async () => {
    mockApi({ ...signedIn(ada), "GET /v1/tasks": { items: [] }, "GET /v1/activity": { items: [], last_seq: 0 }, "GET /v1/runner/sessions": { items: [], runner: false } });
    renderApp("/projects/WEB/workflows");
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByText("Workflows")).toBeInTheDocument());
    // A Project of one Workflow: Edit opens its editor.
    expect(screen.getByRole("link", { name: "Edit the Workflows" })).toHaveAttribute("href", expect.stringMatching(/^\/settings\/projects\/WEB\/workflows\/./));
    const sidebar = screen.getAllByRole("link", { name: "Workflows" });
    expect(sidebar.some((l) => l.getAttribute("href") === "/projects/WEB/workflows")).toBe(true);
  });
});
