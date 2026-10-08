import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Activity, ActivityKind, Task } from "@/api/client";
import { mockApi } from "@/test/api";
import { ada, builder, signedIn, step, task } from "@/test/fixtures";
import { FakeEventSource } from "@/test/eventSource";
import { renderApp } from "@/test/render";

// The live Workflow as it happens: each Step's Tasks as chips, a pickup called out above its Step,
// a move carried by a token along its Connector, and the trail beside the canvas.

const claim = (holder: string) => ({ id: `c-${holder}`, task_id: "", holder_id: holder, session_id: "s", started_at: "2026-10-08T09:00:00Z" });
const entry = (seq: number, kind: ActivityKind, subject: string, payload: Record<string, unknown>, actor?: string): Activity => ({
  seq,
  at: "2026-10-08T09:30:00Z",
  kind,
  subject_type: "task",
  subject_id: subject,
  ...(actor ? { actor_id: actor } : {}),
  payload,
});

/** WEB with `tasks` open and `history` its recent moves; the Tasks may be changed before an entry says so. */
function serve(tasks: Task[], history: Activity[] = []) {
  const list = { tasks };
  const api = mockApi({
    ...signedIn(ada),
    "GET /v1/tasks": ({ query }) => ({ items: list.tasks.filter((t) => !query.get("step") || t.step_id === query.get("step")) }),
    "GET /v1/activity": { items: history, last_seq: history.at(-1)?.seq ?? 0 },
    "GET /v1/runner/sessions": { items: [], runner: false },
  });
  return { api, list };
}

const node = (name: string) => screen.getAllByRole("group", { hidden: true }).find((n) => n.getAttribute("aria-label")?.startsWith(`${name}:`))!;
const trail = () => screen.getByRole("list", { name: "Trail" });
const deliver = (e: Activity) => act(() => FakeEventSource.latest().emit("activity", e, e.seq));
const reducedMotion = (on: boolean) => {
  const was = window.matchMedia;
  window.matchMedia = (q: string) => ({ ...was(q), matches: on && q.includes("reduced-motion") });
  return () => (window.matchMedia = was);
};

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("the live Workflow's Tasks", () => {
  it("shows each Step's open Tasks as chips, three and '+N more' that opens the Step", async () => {
    serve([
      task(1, { claim: claim(builder.id), title: "Normalise names" }),
      task(2),
      task(3),
      task(4),
      task(5, { step_id: step.review }),
      task(6, { step_id: undefined, title: "A Parent" }),
    ]);
    renderApp("/projects/WEB/workflow");
    const build = await waitFor(() => within(node("Build")).getByRole("list", { name: "Tasks at Build", hidden: true }));
    const chips = within(build).getAllByRole("button", { hidden: true });
    expect(chips.map((c) => c.getAttribute("aria-label") ?? c.textContent)).toEqual([
      "WEB-1 Normalise names, held by builder (agent)",
      "WEB-2 Task 2, waiting",
      "WEB-3 Task 3, waiting",
      "+1 more",
    ]);
    expect(chips[3]).toHaveTextContent("+1 more");
    expect(within(node("Review")).getByRole("button", { name: "WEB-5 Task 5, waiting", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^WEB-6 /, hidden: true })).toBeNull();

    await userEvent.click(chips[3]);
    expect(await screen.findByRole("dialog", { name: "Step Build" })).toBeInTheDocument();
  });

  it("opens a chip's Task in its peek", async () => {
    serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    await userEvent.click(await screen.findByRole("button", { name: "WEB-2 Task 2, waiting", hidden: true }));
    expect(await screen.findByRole("dialog", { name: "Task WEB-2" })).toBeInTheDocument();
  });
});

describe("the live Workflow as it happens", () => {
  it("calls out a pickup above its Step, pulses the chip, and joins the trail on top", async () => {
    const { list } = serve([task(2)], [entry(5, "task.filed", "k-2", { key: "WEB-2", project_id: "p-web", step_id: step.build }, ada.id)]);
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(trail()).toHaveTextContent("ada filed WEB-2 at Build"));
    list.tasks = [task(2, { claim: claim(builder.id) })];
    deliver(entry(6, "task.claimed", "k-2", { step_id: step.build }, builder.id));
    await waitFor(() => expect(document.querySelector(".flow-callout")).toHaveTextContent("builder picked up WEB-2"));
    expect(document.querySelector(".flow-callout")).toHaveAttribute("data-tone", "agent");
    await waitFor(() => expect(screen.getByRole("button", { name: "WEB-2 Task 2, held by builder (agent)", hidden: true })).toHaveAttribute("data-live", "agent"));
    const rows = within(trail()).getAllByRole("listitem");
    expect(rows[0]).toHaveAccessibleName("builder picked up WEB-2 at Build");
    expect(rows[0]).toHaveAttribute("data-fresh", "true");
    expect(rows[1]).not.toHaveAttribute("data-fresh");
    // A screen reader hears it.
    expect(screen.getAllByRole("status").some((s) => s.textContent === "builder picked up WEB-2 at Build")).toBe(true);
  });

  it("carries an advanced Task in a token along its Connector, its outcome lit, and hides its chip until it lands", async () => {
    const { list } = serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    await screen.findByRole("button", { name: "WEB-2 Task 2, waiting", hidden: true });
    list.tasks = [task(2, { step_id: step.review })];
    deliver(entry(7, "task.advanced", "k-2", { from: step.build, to: step.review, outcome: "pass" }, builder.id));
    await waitFor(() => expect(document.querySelector(".flow-token")).toHaveTextContent("WEB-2"));
    expect(screen.queryByRole("button", { name: /^WEB-2 /, hidden: true })).toBeNull();
    expect(document.querySelector('[data-lit="true"]')).toHaveTextContent("pass");
    expect(within(trail()).getAllByRole("listitem")[0]).toHaveAccessibleName("builder advanced WEB-2 along pass to Review");
    // Landed: the chip at Review, highlighted.
    await waitFor(() => expect(within(node("Review")).getByRole("button", { name: /^WEB-2 /, hidden: true })).toHaveAttribute("data-arrived", "true"), { timeout: 3000 });
    expect(document.querySelector(".flow-token")).toBeNull();
  });

  it("with reduced motion sends no token: the chip simply appears, and the trail still says it", async () => {
    restore = reducedMotion(true);
    const { list } = serve([task(2)]);
    renderApp("/projects/WEB/workflow");
    await screen.findByRole("button", { name: "WEB-2 Task 2, waiting", hidden: true });
    list.tasks = [task(2, { step_id: step.review })];
    deliver(entry(7, "task.advanced", "k-2", { from: step.build, to: step.review, outcome: "pass" }, builder.id));
    await waitFor(() => expect(within(trail()).getAllByRole("listitem")[0]).toHaveAccessibleName("builder advanced WEB-2 along pass to Review"));
    await waitFor(() => expect(within(node("Review")).getByRole("button", { name: /^WEB-2 /, hidden: true })).toBeInTheDocument());
    expect(document.querySelector(".flow-token")).toBeNull();
  });

  it("seeds the trail with the Project's recent moves, newest first, and ignores another Project's", async () => {
    serve(
      [task(2)],
      [
        entry(3, "task.filed", "k-2", { key: "WEB-2", project_id: "p-web", step_id: step.build }, ada.id),
        entry(4, "task.claimed", "k-2", { step_id: step.build }, builder.id),
      ],
    );
    renderApp("/projects/WEB/workflow");
    await waitFor(() => expect(within(trail()).getAllByRole("listitem")).toHaveLength(2));
    expect(within(trail()).getAllByRole("listitem").map((r) => r.getAttribute("aria-label"))).toEqual(["builder picked up WEB-2 at Build", "ada filed WEB-2 at Build"]);
    expect(screen.getByRole("complementary", { name: "Live trail" })).toHaveTextContent("0 working now");
    deliver(entry(8, "task.claimed", "k-ops", { step_id: "ops-st-build" }, builder.id));
    expect(within(trail()).getAllByRole("listitem")).toHaveLength(2);
  });

  it("lists each Step's Tasks in the text view", async () => {
    serve([task(2), task(3, { claim: claim(builder.id) })]);
    renderApp("/projects/WEB/workflow?view=text");
    const list = await screen.findByRole("list", { name: "Tasks at Build" });
    expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["WEB-3 Task 3, held by builder", "WEB-2 Task 2, waiting"]);
  });
});
