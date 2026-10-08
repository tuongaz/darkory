import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { TaskDetail } from "@/api/client";
import { ada, bob, builder, engineer, ops, parentTask, step, subtask, task } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { awaitingComplete, lapsesOn, staleProposals, takeableNow } from "./derive";
import { claim, entry, minutes, recordApi } from "./testing";

const done = { open: 0, working: 0, done: 3, dropped: 0 };

describe("the Inbox's rules", () => {
  it("leaves out of Takeable what is already aimed at me", () => {
    const aimed = task(8, { aimed_at_id: ada.id, step_id: undefined });
    expect(takeableNow([aimed, task(2), task(3)], [aimed]).map((t) => t.key)).toEqual(["WEB-2", "WEB-3"]);
  });

  it("finds the Parents waiting on their Owner's Complete, and how their Acceptance ended", () => {
    const passed = parentTask(1, done);
    const failed = parentTask(2, done);
    const plain = parentTask(3, done);
    const going = parentTask(4, { open: 1, working: 1, done: 2, dropped: 0 });
    const details = new Map<string, TaskDetail>([
      [passed.id, { subtasks: [subtask(5, passed, { kind: "acceptance", state: "done" })] } as TaskDetail],
      [failed.id, { subtasks: [subtask(6, failed, { kind: "acceptance", state: "done" }), subtask(7, failed, { kind: "acceptance", state: "dropped" })] } as TaskDetail],
    ]);
    const out = awaitingComplete([passed, failed, plain, going, task(9)], details);
    expect(out.map((d) => [d.task.key, d.kind === "complete" && d.acceptance])).toEqual([
      ["WEB-1", "done"],
      ["WEB-2", "dropped"],
      ["WEB-3", undefined],
    ]);
  });

  it("finds pending proposals written against a version no longer current", () => {
    const retro = task(21, { kind: "retrospective", step_id: step.retro });
    const proposal = (id: string, based: number, state: "pending" | "superseded" = "pending") => ({
      id,
      skill_id: engineer.id,
      task_id: retro.id,
      based_on_version: based,
      body: "",
      author_id: builder.id,
      state,
      created_at: minutes(-5),
    });
    const d = { task: retro, proposals: [proposal("p-1", 1), proposal("p-2", 2), proposal("p-3", 1, "superseded")] } as TaskDetail;
    const out = staleProposals([d], new Map([[engineer.id, { ...engineer, current_version: 2 }]]));
    expect(out).toEqual([{ kind: "stale", task: retro, skill: "engineer", basedOn: 1, current: 2 }]);
  });

  it("keeps a lapse on my Task from the last day that nobody has taken up again", () => {
    const lapsed = task(3);
    const retaken = task(4, { claim: claim("k-4", bob.id) });
    const old = task(5);
    const entries = [
      entry(1, "task.lapsed", lapsed.id, { payload: { holder_id: builder.id }, at: minutes(-30) }),
      entry(2, "task.lapsed", retaken.id, { at: minutes(-20) }),
      entry(3, "task.lapsed", old.id, { at: minutes(-25 * 60) }),
      entry(4, "task.lapsed", "k-elsewhere", { at: minutes(-5) }),
    ];
    expect(lapsesOn([lapsed, retaken, old], entries, Date.now()).map((l) => [l.task.key, l.holderId])).toEqual([["WEB-3", builder.id]]);
  });
});

const section = (name: string) => screen.findByRole("region", { name });
const row = (region: HTMLElement, key: string) => region.querySelector<HTMLElement>(`[data-task="${key}"]`)!;

describe("the Inbox", () => {
  it("lists what needs me across Projects in Needs you's order and words, then what I can take", async () => {
    const blocked = task(3, { blocked: true, open_blockers: [{ id: "k-8", key: "WEB-8", title: "Which currency?" }] });
    const question = task(8, { aimed_at_id: ada.id, step_id: undefined, filed_by: builder.id, title: "Which currency?", created_at: minutes(-30) });
    const parent = parentTask(1, done, { title: "Checkout" });
    const lapsed = task(12, { title: "Payment form", owner_id: ada.id });
    const held = task(20, { step_id: step.backlog, skill_id: undefined, step_since: minutes(-120), title: "Search ignores accents" });
    const opsTask = task(30, { id: "k-ops-30", key: "OPS-30", project_id: ops.id, step_id: `ops-${step.build}`, title: "Rotate keys", owner_id: bob.id });
    const { calls } = recordApi({
      tasks: [blocked, question, parent, lapsed, held, opsTask],
      takeable: [question, opsTask, lapsed],
      details: { "WEB-1": { subtasks: [subtask(2, parent, { kind: "acceptance", state: "done" })] } },
      activity: [entry(1, "task.lapsed", lapsed.id, { payload: { holder_id: builder.id }, at: minutes(-10) })],
    });
    renderApp("/inbox");

    const needs = await section("Needs you");
    // What unblocks first (a question before a Complete), then the hold only I can move.
    await waitFor(() => expect([...needs.querySelectorAll("[data-task]")].map((r) => r.getAttribute("data-task"))).toEqual(["WEB-8", "WEB-1", "WEB-20"]));
    const q = row(needs, "WEB-8");
    expect(q).toHaveTextContent("Which currency?");
    expect(q).toHaveTextContent("unblocks WEB-3");
    expect(q).toHaveTextContent("Question from builder");
    expect(within(q).getByRole("button", { name: "Answer WEB-8" })).toBeInTheDocument();
    expect(row(needs, "WEB-1")).toHaveTextContent("Acceptance passed");
    expect(row(needs, "WEB-1")).toHaveTextContent("lands 3 Subtasks");
    expect(row(needs, "WEB-20")).toHaveTextContent("Held in Backlog");
    expect(within(row(needs, "WEB-20")).getByRole("button", { name: "Move on WEB-20" })).toBeInTheDocument();

    // The lapse on WEB-12 clears itself: builder can take it up, so it is only takeable.
    expect(row(needs, "WEB-12")).toBeNull();
    const take = await section("Takeable by you");
    expect([...take.querySelectorAll("[data-task]")].map((r) => r.getAttribute("data-task"))).toEqual(["OPS-30", "WEB-12"]);
    expect(row(take, "OPS-30")).toHaveTextContent("Build");
    expect(within(row(take, "OPS-30")).getByTitle("Ops")).toBeInTheDocument();

    // A decision made from the row: the Owner completes the Parent.
    await userEvent.click(within(row(needs, "WEB-1")).getByRole("button", { name: "Complete WEB-1" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/tasks/WEB-1/complete")).toBe(true));
  });

  it("lists a hold only where nobody else could move it", async () => {
    const held = task(20, { step_id: step.backlog, skill_id: undefined, step_since: minutes(-120) });
    const question = task(8, { aimed_at_id: ada.id, step_id: undefined });
    recordApi({
      tasks: [held, question],
      extra: { "GET /v1/projects/:project": ({ params }) => ({ project: params.project === "OPS" ? ops : { ...ops, id: "p-web", key: "WEB", name: "Web" }, members: [ada, bob] }) },
    });
    renderApp("/inbox");
    const needs = await section("Needs you");
    await waitFor(() => expect(row(needs, "WEB-8")).not.toBeNull());
    expect(row(needs, "WEB-20")).toBeNull();
  });

  it("says what a question unblocks when that Task is someone else's", async () => {
    const blocked = task(3, { owner_id: bob.id, blocked: true, open_blockers: [{ id: "k-8", key: "WEB-8", title: "Which currency?" }] });
    const question = task(8, { aimed_at_id: ada.id, owner_id: bob.id, step_id: undefined, filed_by: bob.id, title: "Which currency?" });
    recordApi({ tasks: [blocked, question] });
    renderApp("/inbox");
    const q = row(await section("Needs you"), "WEB-8");
    await waitFor(() => expect(q).toHaveTextContent("unblocks WEB-3"));
  });

  it("opens a row's peek over the Inbox", async () => {
    const t = task(4, { title: "Build the cart" });
    recordApi({ tasks: [t], takeable: [t], extra: { "GET /v1/tasks/:task": { task: t, subtasks: [], connectors: [], labels: [], workspaces: [], claims: [], notes: [], evidence: [], blockers: [], blocking: [], observations: [], proposals: [] } } });
    renderApp("/inbox");
    const take = await section("Takeable by you");
    expect(within(take).getByRole("link", { name: "Build the cart" })).toHaveAttribute("href", "/inbox?task=WEB-4");
  });

  it("says so when nothing needs me", async () => {
    recordApi({ tasks: [task(1, { owner_id: bob.id })] });
    renderApp("/inbox");
    expect(await screen.findByRole("heading", { name: "Nothing needs you" })).toBeInTheDocument();
  });
});
