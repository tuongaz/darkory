import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { Activity } from "@/api/client";
import { ada, bob, builder, bug, engineer, ops, parentTask, step, task, web } from "@/test/fixtures";
import { FakeEventSource } from "@/test/eventSource";
import { renderApp } from "@/test/render";
import { aboutProject, groupByDay, matchesFilter } from "./derive";
import { entry, minutes, recordApi } from "./testing";
import { describe as say, sentenceText, type Lookup } from "./wording";

const cart = task(3, { title: "Build the cart" });
const checkout = parentTask(1, { open: 1, working: 0, done: 0, dropped: 0 }, { title: "Checkout" });

const lookup: Lookup = {
  members: new Map([ada, bob, builder].map((m) => [m.id, m])),
  skills: new Map([[engineer.id, engineer]]),
  tasks: new Map([cart, checkout].map((t) => [t.id, t])),
  stepName: (id) => ({ [step.build]: "Build", [step.review]: "Review", [step.backlog]: "Backlog" })[id],
  projects: new Map([[web.id, web]]),
  labels: new Map([[bug.id, bug]]),
  claims: new Map(),
};
const words = (e: Activity) => sentenceText(say(e, lookup)!);

describe("what an entry says", () => {
  it("words the v2 kinds in the glossary's voice", () => {
    expect(words(entry(1, "task.advanced", cart.id, { actor_id: builder.id, payload: { from: step.build, to: step.review, outcome: "pass" } }))).toBe(
      "builder advanced WEB-3 Build the cart along pass to Review · from Build",
    );
    expect(words(entry(1, "task.moved", cart.id, { actor_id: ada.id, payload: { from: step.backlog, to: step.build } }))).toBe(
      "ada moved WEB-3 Build the cart to Build · from Backlog",
    );
    expect(words(entry(1, "task.completed", cart.id, { actor_id: builder.id, payload: { from: step.review, outcome: "pass" } }))).toBe(
      "builder completed WEB-3 Build the cart along pass · from Review",
    );
    expect(words(entry(1, "task.split", checkout.id, { actor_id: builder.id, payload: { holder_id: builder.id } }))).toBe(
      "builder split WEB-1 Checkout into Subtasks · its Claim ended",
    );
    expect(words(entry(1, "task.became_parent", checkout.id, { actor_id: ada.id, payload: { from: step.build } }))).toBe(
      "ada made WEB-1 Checkout a Parent · off Build",
    );
    expect(words(entry(1, "task.labels_set", cart.id, { actor_id: ada.id, payload: { added: [bug.id], removed: [] } }))).toBe(
      "ada set the Labels of WEB-3 Build the cart · +bug",
    );
    expect(words(entry(1, "workflow.changed", web.id, { actor_id: ada.id, payload: { steps: [1, 2, 3], tasks_moved: 2 } }))).toBe(
      "ada changed the Workflow · 3 Steps · 2 Tasks moved",
    );
    expect(words(entry(1, "label.created", bug.id, { actor_id: ada.id, payload: { name: "bug", color: "#d1453b" } }))).toBe(
      "ada created the Label bug · for every Project",
    );
    expect(words(entry(1, "project.changed", web.id, { actor_id: ada.id, payload: { auto_complete: true } }))).toBe("ada changed the Project Web · Auto-complete");
    expect(words(entry(1, "project.member_added", web.id, { actor_id: ada.id, payload: { member_id: bob.id } }))).toBe("ada added bob to Web");
  });

  it("says Darkory filed its own Subtasks, at their Step, and names a deleted Step plainly", () => {
    expect(words(entry(1, "task.filed", cart.id, { payload: { step_id: "st-gone", parent_id: checkout.id } }))).toBe(
      "Darkory filed WEB-3 Build the cart at a Step · under WEB-1",
    );
    expect(words(entry(1, "task.lapsed", cart.id, { payload: { holder_id: builder.id } }))).toBe("Darkory Lapsed WEB-3 Build the cart · held by builder");
  });
});

describe("the Activity page's rules", () => {
  const where = { taskProject: (id: string) => (id === "k-ops" ? ops.id : web.id) };

  it("keeps a stream entry about the Project: itself, its Workflow, its own Labels, its Tasks", () => {
    expect(aboutProject(entry(1, "task.claimed", cart.id), web.id, where)).toBe(true);
    expect(aboutProject(entry(1, "task.claimed", "k-ops"), web.id, where)).toBe(false);
    expect(aboutProject(entry(1, "workflow.changed", web.id), web.id, where)).toBe(true);
    expect(aboutProject(entry(1, "label.created", "l-x", { payload: { project_id: web.id } }), web.id, where)).toBe(true);
    expect(aboutProject(entry(1, "label.created", "l-x", { payload: {} }), web.id, where)).toBe(false);
    expect(aboutProject(entry(1, "member.created", ada.id), web.id, where)).toBe(false);
  });

  it("filters by Member as /v1 does, by Kind and by Task", () => {
    const lapse = entry(1, "task.lapsed", cart.id, { payload: { holder_id: builder.id } });
    expect(matchesFilter(lapse, { member: builder.id })).toBe(true);
    expect(matchesFilter(lapse, { member: ada.id })).toBe(false);
    expect(matchesFilter(lapse, { kind: "task.lapsed", task: cart.id })).toBe(true);
    expect(matchesFilter(lapse, { task: checkout.id })).toBe(false);
  });

  it("groups by day, newest first", () => {
    const now = Date.parse("2026-10-08T12:00:00");
    const at = (s: string) => new Date(s).toISOString();
    const groups = groupByDay([entry(3, "task.claimed", "x", { at: at("2026-10-08T09:00:00") }), entry(2, "task.claimed", "x", { at: at("2026-10-07T09:00:00") })], now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
  });
});

const rows = () => within(screen.getByRole("list", { name: "Activity" })).getAllByRole("listitem").filter((li) => li.hasAttribute("data-seq"));

describe("a Project's Activity", () => {
  const history = [
    entry(5, "task.advanced", cart.id, { actor_id: builder.id, payload: { from: step.build, to: step.review, outcome: "pass", claim_id: "c" } }),
    entry(4, "task.claimed", cart.id, { actor_id: builder.id, payload: { claim_id: "c", skill_id: engineer.id } }),
    entry(3, "workflow.changed", web.id, { actor_id: ada.id, payload: { steps: [] } }),
  ];

  it("reads the Project's entries, links each to its Task, Workflow and Steps, and adds the stream's", async () => {
    const { calls } = recordApi({ tasks: [cart, checkout], activity: history });
    renderApp("/projects/WEB/activity");
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(calls.find((c) => c.path === "/v1/activity" && c.query.get("before"))?.query.get("project")).toBe("WEB");
    const advanced = rows()[0];
    expect(advanced).toHaveTextContent(/builder advanced WEB-3 Build the cart along pass to Review/);
    expect(within(advanced).getByRole("link", { name: /WEB-3/ })).toHaveAttribute("href", "/projects/WEB/activity?task=WEB-3");
    expect(within(advanced).getByRole("link", { name: "Review" })).toHaveAttribute("href", `/projects/WEB/tasks?filter.tasks=${encodeURIComponent(`step:is:${step.review}`)}`);
    expect(within(rows()[2]).getByRole("link", { name: "the Workflow" })).toHaveAttribute("href", "/projects/WEB/workflow");

    act(() => FakeEventSource.latest().emit("activity", entry(6, "task.moved", cart.id, { actor_id: ada.id, payload: { from: step.review, to: step.build }, at: minutes(0) }), 6));
    act(() => FakeEventSource.latest().emit("activity", entry(7, "task.moved", "k-ops", { actor_id: ada.id, payload: { to: "x" }, at: minutes(0) }), 7));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(rows()[0]).toHaveTextContent("ada moved WEB-3");
  });

  it("narrows by Kind through /v1, and by Task here", async () => {
    const { calls } = recordApi({ tasks: [cart, checkout], activity: [...history, entry(2, "task.claimed", checkout.id, { actor_id: bob.id, payload: { claim_id: "d" } })] });
    renderApp("/projects/WEB/activity?kind=task.claimed");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(calls.some((c) => c.path === "/v1/activity" && c.query.getAll("kind").includes("task.claimed") && c.query.get("project") === "WEB")).toBe(true);
    expect(screen.getByRole("toolbar", { name: "Filters" })).toHaveTextContent("Kind is Task claimed");

    await userEvent.click(screen.getByRole("button", { name: /^Task/ }));
    await userEvent.click(await screen.findByRole("option", { name: /WEB-1/ }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("bob claimed WEB-1");
    await userEvent.click(screen.getByRole("button", { name: "Clear Task" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it("loads older pages", async () => {
    const many = Array.from({ length: 130 }, (_, i) => entry(i + 1, "task.claimed", cart.id, { actor_id: builder.id, payload: { claim_id: `c${i}` }, at: minutes(-i) }));
    recordApi({
      tasks: [cart],
      extra: {
        "GET /v1/activity": ({ query }) => {
          const before = Number(query.get("before"));
          const limit = Number(query.get("limit"));
          const items = many.filter((e) => e.seq < before).slice(-limit);
          return { items, last_seq: items.at(-1)?.seq ?? 0, first_seq: items[0]?.seq };
        },
      },
    });
    renderApp("/projects/WEB/activity");
    await waitFor(() => expect(rows()).toHaveLength(100));
    await userEvent.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(rows()).toHaveLength(130));
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
  });
});
