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
  it("lists what needs me across Projects, section by section, each row with its Project", async () => {
    const blocked = task(3, { blocked: true, open_blockers: [{ id: "k-8", key: "WEB-8", title: "Which currency?" }] });
    const question = task(8, { aimed_at_id: ada.id, step_id: undefined, filed_by: builder.id, title: "Which currency?" });
    const parent = parentTask(1, done, { title: "Checkout" });
    const lapsed = task(12, { title: "Payment form", owner_id: ada.id });
    const opsTask = task(30, { id: "k-ops-30", key: "OPS-30", project_id: ops.id, step_id: `ops-${step.build}`, title: "Rotate keys", owner_id: bob.id });
    const { calls } = recordApi({
      tasks: [blocked, question, parent, lapsed, opsTask],
      takeable: [question, opsTask, lapsed],
      details: { "WEB-1": { subtasks: [subtask(2, parent, { kind: "acceptance", state: "done" })] } },
      activity: [entry(1, "task.lapsed", lapsed.id, { payload: { holder_id: builder.id }, at: minutes(-10) })],
    });
    renderApp("/inbox");

    const aimed = await section("Aimed at you");
    const q = row(aimed, "WEB-8");
    expect(q).toHaveTextContent("Which currency?");
    expect(q).toHaveTextContent("blocks WEB-3");
    expect(q).toHaveTextContent(/from .*builder/);
    expect(within(q).getByRole("button", { name: "Answer WEB-8" })).toBeInTheDocument();

    const decide = await section("Your decision");
    expect(row(decide, "WEB-1")).toHaveTextContent("Acceptance passed");
    expect(row(decide, "WEB-1")).toHaveTextContent("3/3");

    const lapses = await section("Lapsed on your Tasks");
    expect(row(lapses, "WEB-12")).toHaveTextContent(/Lapsed \d\d:\d\d/);
    expect(row(lapses, "WEB-12")).toHaveTextContent(/held by .*builder/);
    // Takeable again, it is Claimed from its lapse and not listed twice.
    expect(within(row(lapses, "WEB-12")).getByRole("button", { name: "Claim WEB-12" })).toBeInTheDocument();

    // The question and the lapsed Task are listed once each; OPS-30 carries its own Project and Step.
    const take = await section("Takeable by you");
    expect(take.querySelectorAll("[data-task]")).toHaveLength(1);
    expect(row(take, "OPS-30")).toHaveTextContent("Build");
    expect(row(take, "OPS-30").getAttribute("data-task")).toBe("OPS-30");
    expect(within(row(take, "OPS-30")).getByTitle("Ops")).toBeInTheDocument();

    // A decision made from the row: the Owner completes the Parent.
    await userEvent.click(within(row(decide, "WEB-1")).getByRole("button", { name: "Complete WEB-1" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/tasks/WEB-1/complete")).toBe(true));
    // Reading what I own asks /v1 with my own token.
    expect(calls.some((c) => c.query.getAll("filter").includes(`owner:is:${ada.id}`))).toBe(true);
  });

  it("says what a question blocks when that Task is someone else's", async () => {
    const blocked = task(3, { owner_id: bob.id, blocked: true, open_blockers: [{ id: "k-8", key: "WEB-8", title: "Which currency?" }] });
    const question = task(8, { aimed_at_id: ada.id, owner_id: bob.id, step_id: undefined, filed_by: bob.id, title: "Which currency?" });
    recordApi({ tasks: [blocked, question] });
    renderApp("/inbox");
    const q = row(await section("Aimed at you"), "WEB-8");
    await waitFor(() => expect(q).toHaveTextContent("blocks WEB-3"));
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
