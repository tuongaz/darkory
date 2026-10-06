import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Claim, FeatureDetail, TaskDetail } from "@/api/client";
import { mockApi, refuse } from "@/test/api";
import { ada, bob, builder, build, feature, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const inFuture = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const statuses = [
  { id: "st-todo", name: "Todo", kind: "todo", position: 1 },
  { id: "st-ip", name: "In progress", kind: "in_progress", position: 2 },
  { id: "st-done", name: "Done", kind: "done", position: 3 },
] as const;

function held(holder: string): Claim {
  return { id: "c-1", task_id: "k-3", holder_id: holder, session_id: "sess-1", skill_id: build.id, skill_version: 1, started_at: inFuture(-5), expires_at: inFuture(10), heartbeat_timeout_seconds: 900 };
}

function detail(extra: Partial<TaskDetail["task"]> = {}): TaskDetail {
  const t = task(3, "f-1", { title: "Build the cart page", status_id: extra.claim ? "st-ip" : "st-todo", ...extra });
  return {
    task: t,
    status: extra.claim ? statuses[1] : statuses[0],
    feature: feature(1, 1, { title: "Checkout flow", owner_id: bob.id }),
    workspaces: [],
    claims: extra.claim ? [extra.claim] : [],
    notes: [],
    evidence: [],
    blockers: [],
    blocking: [],
    observations: [],
  };
}

function routes(d: TaskDetail, takeable: string[] = []) {
  return {
    ...signedIn(),
    "GET /v1/tasks/takeable": { items: takeable.map((id) => ({ ...d.task, id })) },
    "GET /v1/tasks/:task": d,
    "GET /v1/statuses": { items: statuses },
    "GET /v1/teams/:team": { team: web, members: [ada, bob, builder] },
    "GET /v1/members/:member": ({ params }: { params: Record<string, string> }) => ({
      member: [ada, bob, builder].find((m) => m.id === params.member),
      teams: [web],
      skills: params.member === builder.id ? [build] : [],
      reports: [],
    }),
  };
}

describe("the Task page", () => {
  it("shows another holder's Claim as facts, the rule for Notes, and Take back up the Reporting line", async () => {
    mockApi(routes(detail({ claim: held(builder.id) })));
    renderApp("/tasks/WEB-3");

    expect(await screen.findByRole("heading", { name: "Build the cart page", level: 1 })).toBeInTheDocument();
    const rail = screen.getByRole("complementary", { name: "Properties" });
    expect(within(rail).getByText("sess-1")).toBeInTheDocument();
    expect(screen.getByText("Only builder can add a Note")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Note" })).not.toBeInTheDocument();
    // ada is not the holder and does not own WEB-1: no primary, and Drop is the owner's.
    expect(screen.queryByRole("button", { name: /Complete|Claim/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "Take back" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Drop Task/ })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: /Drop Task/ })).toHaveTextContent("Owner only");
  });

  it("gives the holder Complete and the Note composer, which writes the Note", async () => {
    const api = mockApi({
      ...routes(detail({ claim: held(ada.id) })),
      "POST /v1/tasks/:task/notes": { id: "n-1", task_id: "k-3", author_id: ada.id, body: "Done the stepper", created_at: inFuture(0) },
    });
    renderApp("/tasks/WEB-3");

    expect(await screen.findByRole("button", { name: "Complete" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Note" }), "Done the stepper");
    await userEvent.click(screen.getByRole("button", { name: "Add Note" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === "/v1/tasks/k-3/notes")).toBe(true));
    expect(api.calls.find((c) => c.path === "/v1/tasks/k-3/notes")?.body).toEqual({ body: "Done the stepper" });
    expect(screen.queryByText(/can add a Note/)).not.toBeInTheDocument();
  });

  it("offers Claim on a takeable Task, claiming without a Heartbeat timeout, and no composer while nobody holds it", async () => {
    const d = detail();
    const api = mockApi({ ...routes(d, [d.task.id]), "POST /v1/tasks/:task/claim": d });
    renderApp("/tasks/WEB-3");

    await userEvent.click(await screen.findByRole("button", { name: "Claim" }));
    await waitFor(() => expect(api.calls.find((c) => c.path === "/v1/tasks/k-3/claim")?.body).toEqual({ heartbeat_timeout_seconds: 0 }));
    expect(screen.queryByRole("textbox", { name: "Note" })).not.toBeInTheDocument();
    expect(screen.queryByText(/can add a Note/)).not.toBeInTheDocument();
  });
});

describe("the Feature page", () => {
  it("names the open Tasks when Ship is refused", async () => {
    const f = feature(1, 2, { title: "Checkout flow", task_counts: { open: 1, claimed: 0, done: 1, dropped: 0 } });
    const open = task(3, f.id, { title: "Build the cart page" });
    const done = task(2, f.id, { title: "Break down: Checkout flow", kind: "breakdown", state: "done", status_id: "st-done", ended_at: inFuture(-1) });
    const fd: FeatureDetail = { feature: f, tasks: [done, open], evidence: [] };
    mockApi({
      ...routes(detail()),
      "GET /v1/features/:feature": fd,
      "GET /v1/features/:feature/observations": { items: [] },
      "POST /v1/features/:feature/ship": refuse(409, "tasks_open", "Feature WEB-1 has 1 open Tasks; each must end, done or dropped, before it ships"),
    });
    renderApp("/features/WEB-1");

    const tasks = await screen.findByRole("region", { name: "Tasks" });
    // Ordered by Status: the Todo Task before the Done one.
    const order = () => within(tasks).getAllByRole("link", { name: /^WEB-\d/ }).map((r) => r.getAttribute("aria-label"));
    await waitFor(() => expect(within(tasks).getByRole("img", { name: "Done" })).toBeInTheDocument());
    expect(order()).toEqual(["WEB-3 Build the cart page", "WEB-2 Break down: Checkout flow"]);

    await userEvent.click(screen.getByRole("button", { name: "Ship" }));
    expect(await screen.findByText("Not shipped: 1 Task open")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "WEB-3" })).toHaveAttribute("href", "/features/WEB-1?task=WEB-3");
  });
});
