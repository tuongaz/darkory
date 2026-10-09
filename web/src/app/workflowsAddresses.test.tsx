import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { mockApi } from "@/test/api";
import { ada, signedIn, web, wfId, wfStep, workflowsFixture } from "@/test/fixtures";
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

function at(path: string) {
  mockApi({ ...signedIn(ada), "GET /v1/projects/:project/workflow": workflowsFixture(web) });
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
async function address(path: string) {
  at(path);
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
