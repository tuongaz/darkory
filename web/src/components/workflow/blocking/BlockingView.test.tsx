import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import type { Task } from "@/api/client";
import { LiveActivity } from "@/api/live";
import { Providers } from "@/App";
import { MeContext } from "@/me";
import { newQueryClient } from "@/queryClient";
import { mockApi } from "@/test/api";
import { ada, bob, me, parentTask, signedIn, step, subtask, task, web } from "@/test/fixtures";
import { BlockingView } from "./index";

// WEB: Parent WEB-1 with Subtasks WEB-2 → WEB-3 and WEB-7; WEB-4, a question aimed at ada,
// blocks WEB-5, which WEB-3 blocks too; WEB-6 has no Blocking; OPS-9, in another Project, blocks
// WEB-7.
const parent = parentTask(1, { open: 3, working: 0, done: 0, dropped: 0 }, { title: "Checkout" });
const w2 = subtask(2, parent, { title: "Payment form" });
const w3 = subtask(3, parent, { title: "Receipt", blocked: true, open_blockers: [{ id: w2.id, key: w2.key, title: w2.title }] });
const w4 = task(4, { title: "Which card brands?", step_id: undefined, step_since: undefined, skill_id: undefined, aimed_at_id: ada.id });
const w5 = task(5, { title: "Card brands", blocked: true, open_blockers: [{ id: w3.id, key: w3.key, title: w3.title }, { id: w4.id, key: w4.key, title: w4.title }] });
const w6 = task(6, { title: "Basket icon", step_id: step.review });
const ops9: Task = { ...task(9, { title: "Rate limits" }), id: "o-9", key: "OPS-9", project_id: "p-ops" };
const w7 = subtask(7, parent, { title: "Card vault", blocked: true, open_blockers: [{ id: ops9.id, key: ops9.key, title: ops9.title }] });
const open = [parent, w2, w3, w7, w4, w5, w6, ops9];

function Where() {
  const l = useLocation();
  return <output aria-label="Address">{l.pathname + l.search}</output>;
}

function show(scope?: string) {
  mockApi({ ...signedIn(), "GET /v1/tasks": { items: open }, "GET /v1/tasks/takeable": { items: [w4] }, "GET /v1/runner/sessions": { items: [] } });
  const onShowOnLine = vi.fn();
  render(
    <Providers client={newQueryClient()} live={new LiveActivity()}>
      <MemoryRouter initialEntries={["/projects/WEB/workflow"]}>
        <MeContext.Provider value={me(ada)}>
          <BlockingView project={web} scope={scope} onShowOnLine={onShowOnLine} />
          <Where />
        </MeContext.Provider>
      </MemoryRouter>
    </Providers>,
  );
  return onShowOnLine;
}

describe("BlockingView", () => {
  it("draws the Project's Tasks with a Blocking, a band per Parent, and says what to do first", async () => {
    show();
    const graph = await screen.findByRole("region", { name: "Blocking, graph" });
    const nodes = within(graph).getAllByRole("button", { pressed: false }).map((b) => b.getAttribute("data-task"));
    expect(nodes.sort()).toEqual(["OPS-9", "WEB-2", "WEB-3", "WEB-4", "WEB-5", "WEB-7"]);
    expect(screen.getByText("Blockings").parentElement).toHaveTextContent("4 Blockings");
    expect(within(graph).getByText("Checkout")).toBeInTheDocument();
    // Our own Tasks with no Parent, and OPS-9 in its Project's.
    expect(within(graph).getAllByText("No Parent")).toHaveLength(2);
    expect(within(graph).getByText(/^In Ops/)).toBeInTheDocument();
    expect(within(graph).getByRole("button", { name: /^WEB-5 Card brands, at Build, blocked by WEB-3, WEB-4/ })).toHaveTextContent("by 2");
    const first = screen.getByRole("region", { name: "First for you" });
    // WEB-4 shares WEB-5 with WEB-3, so it unblocks nothing alone: it leads to one Task.
    expect(first).toHaveTextContent("Answer WEB-4 · leads to 1 Task");
    expect(screen.getByRole("region", { name: "No Blocking" })).toHaveTextContent("WEB-6");
    expect(screen.getByRole("region", { name: "Longest chain" })).toHaveTextContent("WEB-2 → WEB-3 → WEB-5");
  });

  it("selects a node's chain, and hands Show on line its id and Open its peek", async () => {
    const onShowOnLine = show();
    const graph = await screen.findByRole("region", { name: "Blocking, graph" });
    await userEvent.click(within(graph).getByRole("button", { name: /^WEB-5 / }));
    const card = within(graph).getByRole("dialog", { name: "WEB-5, its chain" });
    expect(card).toHaveTextContent("by WEB-3, WEB-4 · both");
    expect(card).toHaveTextContent("First: answer WEB-4");
    await userEvent.click(within(card).getByRole("button", { name: "Show on line" }));
    expect(onShowOnLine).toHaveBeenCalledWith(w5.id);
    await userEvent.click(within(card).getByRole("button", { name: "Open WEB-5" }));
    expect(screen.getByLabelText("Address")).toHaveTextContent("task=WEB-5");
  });

  it("scoped to a Parent, shows its Subtasks and the outside Tasks joined to them", async () => {
    show(parent.id);
    const graph = await screen.findByRole("region", { name: "Blocking, graph" });
    const nodes = within(graph).getAllByRole("button", { pressed: false }).map((b) => b.getAttribute("data-task"));
    expect(nodes.sort()).toEqual(["OPS-9", "WEB-2", "WEB-3", "WEB-5", "WEB-7"]);
    expect(within(graph).getAllByText(/^Outside|^In Ops/).length).toBe(2);
  });

  it("says when nothing blocks anything", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/tasks": { items: [w6] }, "GET /v1/tasks/takeable": { items: [] }, "GET /v1/runner/sessions": { items: [] } });
    render(
      <Providers client={newQueryClient()} live={new LiveActivity()}>
        <MemoryRouter>
          <MeContext.Provider value={me(bob)}>
            <BlockingView project={web} onShowOnLine={() => {}} />
          </MeContext.Provider>
        </MemoryRouter>
      </Providers>,
    );
    expect(await screen.findByText("No open Task here blocks another.")).toBeInTheDocument();
  });
});
