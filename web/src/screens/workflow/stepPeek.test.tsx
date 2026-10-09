import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { LiveActivity } from "@/api/live";
import { Providers } from "@/App";
import type { Step, Workflow } from "@/components/workflow/model";
import { MeContext } from "@/me";
import { newQueryClient } from "@/queryClient";
import { mockApi } from "@/test/api";
import { ada, me, signedIn, web } from "@/test/fixtures";
import { StepPeek, stepParam } from "./StepPeek";

// A Step's peek over the live line: for an admin, Edit opens the same Step in its Workflow's editor.

const build: Step = { id: "st-build", workflow_id: "wf-work", name: "Build", position: 3, x: 0, y: 0, takers: [], tasks: 0, working: 0 };
const graph: Workflow = { workflows: [{ id: "wf-work", name: "Work", position: 1 }], steps: [build], connectors: [] };

describe("a Step's peek", () => {
  it("names the Step its Edit opens in the Workflow's editor", async () => {
    mockApi({ ...signedIn(ada), "GET /v1/tasks": { items: [] }, "GET /v1/runner/sessions": { items: [], runner: false } });
    render(
      <Providers client={newQueryClient()} live={new LiveActivity()}>
        <MeContext.Provider value={me(ada)}>
          <MemoryRouter initialEntries={["/projects/WEB/workflows/wf-work"]}>
            <StepPeek project={web} workflow={graph} step={build} onClose={() => {}} />
          </MemoryRouter>
        </MeContext.Provider>
      </Providers>,
    );
    const edit = await screen.findByRole("link", { name: "Edit Build" });
    expect(edit).toHaveAttribute("href", `/projects/WEB/workflows/wf-work/edit?${stepParam}=st-build`);
    expect(edit).toHaveTextContent("Edit");
  });
});
