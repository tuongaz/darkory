import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity, Task } from "@/api/client";
import { LiveActivity } from "@/api/live";
import { Providers } from "@/App";
import { MeContext } from "@/me";
import { newQueryClient } from "@/queryClient";
import { claim, entry, minutes, recordApi } from "@/screens/inbox/testing";
import { refuse } from "@/test/api";
import { ada, builder, me, step, task, web } from "@/test/fixtures";
import { NeedsYouPanel, StoriesPanel, useStoriesQuiet } from ".";

function renderPanel(ui: ReactNode) {
  const client = newQueryClient();
  const live = new LiveActivity();
  return render(
    <Providers client={client} live={live}>
      <MemoryRouter initialEntries={["/projects/WEB/workflows"]}>
        <MeContext.Provider value={me(ada)}>{ui}</MeContext.Provider>
      </MemoryRouter>
    </Providers>,
  );
}

// A question builder asked ada 36 minutes ago, which WEB-4 waits on.
function questionDay() {
  const q = task(13, { aimed_at_id: ada.id, step_id: undefined, step_since: undefined, skill_id: undefined, filed_by: builder.id, title: "Which export format do coordinators use?", created_at: minutes(-36) });
  const blocked = task(4, { blocked: true, open_blockers: [{ id: q.id, key: q.key, title: q.title }] });
  return { q, blocked, tasks: [q, blocked] };
}

describe("Needs you's answer box", () => {
  it("claims, notes and completes in one submit, then says it was answered and what now waits", async () => {
    const { q, tasks } = questionDay();
    const api = recordApi({
      tasks,
      extra: {
        "POST /v1/tasks/:task/claim": () => {
          q.claim = claim(q.id, ada.id);
          return { task: q };
        },
        "POST /v1/tasks/:task/complete": () => {
          q.state = "done";
          return q;
        },
      },
    });
    const onHover = vi.fn();
    renderPanel(<NeedsYouPanel project={web} onHover={onHover} />);
    const card = await screen.findByRole("article", { name: /WEB-13/ });
    expect(within(card).getByText("unblocks WEB-4")).toBeInTheDocument();
    expect(within(card).getByText("asked")).toBeInTheDocument();
    await userEvent.type(within(card).getByRole("textbox", { name: "Your answer to WEB-13" }), "CSV, one row per shift");
    await userEvent.click(within(card).getByRole("button", { name: "Answer" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Answered\s*WEB-13\s*· WEB-4 waiting/);
    const writes = api.calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body]);
    expect(writes).toEqual([
      ["/v1/tasks/WEB-13/claim", {}],
      ["/v1/tasks/WEB-13/complete", { note: "CSV, one row per shift" }],
    ]);
  });

  it("says so in the card when someone else is answering, keeping the words", async () => {
    const { tasks } = questionDay();
    const api = recordApi({ tasks, extra: { "POST /v1/tasks/:task/claim": refuse(409, "already_claimed", "Someone holds WEB-13") } });
    renderPanel(<NeedsYouPanel project={web} onHover={() => {}} />);
    const card = await screen.findByRole("article", { name: /WEB-13/ });
    const box = within(card).getByRole("textbox", { name: "Your answer to WEB-13" });
    await userEvent.type(box, "CSV");
    await userEvent.click(within(card).getByRole("button", { name: "Answer" }));
    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("already_claimed");
    expect(alert).toHaveTextContent("Someone else is answering WEB-13 now.");
    expect(box).toHaveValue("CSV");
    expect(api.calls.some((c) => c.path.endsWith("/complete"))).toBe(false);
  });

  it("when the claim held but the completion was refused, keeps the card, says the question is mine to finish, and finishes it on the next submit", async () => {
    const { q, tasks } = questionDay();
    let refuseComplete = true;
    const api = recordApi({
      tasks,
      extra: {
        "POST /v1/tasks/:task/claim": () => {
          q.claim = claim(q.id, ada.id);
          return { task: q };
        },
        "POST /v1/tasks/:task/complete": () => (refuseComplete ? refuse(409, "conflict", "The Task changed.") : { ...q, state: "done" }),
      },
    });
    renderPanel(<NeedsYouPanel project={web} onHover={() => {}} />);
    let card = await screen.findByRole("article", { name: /WEB-13/ });
    await userEvent.type(within(card).getByRole("textbox", { name: "Your answer to WEB-13" }), "CSV");
    await userEvent.click(within(card).getByRole("button", { name: "Answer" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("You hold WEB-13, but it was not completed: The Task changed. Answer again to finish it.");
    // The question, now held by ada, is still hers to answer.
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/v1/tasks" && c.method === "GET").length).toBeGreaterThan(1));
    card = await screen.findByRole("article", { name: /WEB-13/ });
    expect(within(card).getByRole("textbox", { name: "Your answer to WEB-13" })).toHaveValue("CSV");
    refuseComplete = false;
    await userEvent.click(within(card).getByRole("button", { name: "Answer" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Answered/);
    expect(api.calls.filter((c) => c.path.endsWith("/claim")).length).toBe(1);
  });

  it("says Nothing needs you when nothing does", async () => {
    recordApi({ tasks: [task(1)] });
    renderPanel(<NeedsYouPanel project={web} onHover={() => {}} />);
    expect(await screen.findByText("Nothing needs you")).toBeInTheDocument();
  });

  it("shows three cards at rest and the rest behind +N more, and rings a card's Task on hover", async () => {
    const holds = [1, 2, 3, 4, 5].map((n) => task(n, { step_id: step.backlog, skill_id: undefined, step_since: minutes(-60 * n) }));
    recordApi({ tasks: holds });
    const onHover = vi.fn();
    renderPanel(<NeedsYouPanel project={web} onHover={onHover} />);
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    // Oldest first.
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("data-need"))).toEqual(["WEB-5", "WEB-4", "WEB-3"]);
    await userEvent.hover(screen.getAllByRole("article")[0]);
    expect(onHover).toHaveBeenLastCalledWith("k-5");
    await userEvent.click(screen.getByRole("button", { name: "+2 more" }));
    expect(screen.getAllByRole("article")).toHaveLength(5);
    expect(screen.getAllByRole("button", { name: /^Move on/ })[0]).toBeInTheDocument();
  });
});

// The Project's flow entries: WEB-9 filed long ago and picked up 2 h ago; WEB-12 picked up 5 min ago.
function storyDay(recent: boolean) {
  const t9 = task(9, { title: "Reaction picker", step_since: minutes(-200) });
  const t12 = task(12, { title: "Admin can remove a reaction", step_since: minutes(-30) });
  const entries: Activity[] = [
    entry(1, "task.filed", t9.id, { actor_id: ada.id, at: minutes(-200), payload: { step_id: step.build, project_id: web.id } }),
    entry(2, "task.claimed", t9.id, { actor_id: builder.id, at: minutes(-120), payload: { project_id: web.id } }),
  ];
  if (recent) entries.push(entry(3, "task.claimed", t12.id, { actor_id: builder.id, at: minutes(-5), payload: { project_id: web.id } }));
  const tasks: Task[] = [
    { ...t9, claim: claim(t9.id, builder.id, { started_at: minutes(-120) }) },
    recent ? { ...t12, claim: claim(t12.id, builder.id, { started_at: minutes(-5) }) } : t12,
  ];
  return { tasks, entries };
}

function QuietMark() {
  return <p data-testid="quiet">{String(useStoriesQuiet(web))}</p>;
}

describe("What's happening", () => {
  // The panel tells today's stories: on a clock read near midnight "an hour ago" would be
  // yesterday, so the day is pinned at noon (only Date: the timers stay real for the queries).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("divides the stories at where I last looked, the new ones on two lines", async () => {
    const { tasks, entries } = storyDay(true);
    recordApi({ tasks, activity: entries, extra: { "GET /v1/projects/:project/seen": { seq: 2, at: new Date(Date.now() - 30 * 60_000).toISOString() } } });
    renderPanel(<StoriesPanel project={web} onHover={() => {}} />);
    const sep = await screen.findByRole("separator");
    expect(sep).toHaveTextContent(/Since you looked · \d\d:\d\d/);
    const rows = screen.getAllByRole("listitem").filter((li) => li.dataset.story);
    expect(rows.map((r) => [r.dataset.story, !!r.dataset.fresh])).toEqual([
      ["WEB-12", true],
      ["WEB-9", false],
    ]);
    expect(rows[0]).toHaveTextContent("builder picked up");
  });

  it("opens a row into its Task's path, with its entries and a way to open it", async () => {
    const { tasks, entries } = storyDay(true);
    const api = recordApi({ tasks, activity: entries, extra: { "GET /v1/projects/:project/seen": { seq: null, at: null } } });
    const onOpen = vi.fn();
    renderPanel(<StoriesPanel project={web} onHover={() => {}} onOpen={onOpen} />);
    await userEvent.click(await screen.findByRole("listitem", { name: /WEB-9 Reaction picker/ }));
    expect(onOpen).toHaveBeenLastCalledWith("k-9");
    const opened = await screen.findByRole("listitem", { name: "WEB-9 Reaction picker: its path" });
    expect(await within(opened).findByRole("list", { name: "WEB-9's entries" })).toHaveTextContent("builder picked up");
    expect(within(opened).getByRole("link", { name: "Open WEB-9 →" })).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === "/v1/activity" && c.query.get("task") === "WEB-9")).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onOpen).toHaveBeenLastCalledWith(null);
  });

  it("folds to one quiet line after an hour with nothing new since I looked, and opens again on a click", async () => {
    const { tasks, entries } = storyDay(false);
    recordApi({ tasks, activity: entries, extra: { "GET /v1/projects/:project/seen": { seq: 2, at: minutes(-90) } } });
    renderPanel(
      <>
        <QuietMark />
        <StoriesPanel project={web} onHover={() => {}} />
      </>,
    );
    const line = await screen.findByRole("button", { name: "Open What's happening" });
    expect(line).toHaveTextContent(/Quiet since \d\d:\d\d/);
    expect(line).toHaveTextContent("WEB-9");
    expect(screen.getByTestId("quiet")).toHaveTextContent("true");
    await userEvent.click(line);
    expect(screen.getByTestId("quiet")).toHaveTextContent("false");
    expect(await screen.findByRole("list", { name: "Stories" })).toBeInTheDocument();
  });

  it("moves the mark to the newest entry shown when the page is left", async () => {
    const { tasks, entries } = storyDay(true);
    const api = recordApi({ tasks, activity: entries, extra: { "GET /v1/projects/:project/seen": { seq: 1, at: minutes(-60) }, "PUT /v1/projects/:project/seen": ({ body }) => ({ ...(body as object), at: new Date().toISOString() }) } });
    const view = renderPanel(<StoriesPanel project={web} onHover={() => {}} />);
    await screen.findByRole("listitem", { name: /WEB-12/ });
    // Nothing older than the mark: no divider with nothing under it.
    expect(screen.queryByRole("separator")).toBeNull();
    view.unmount();
    await waitFor(() => expect(api.calls.find((c) => c.method === "PUT")).toMatchObject({ path: "/v1/projects/WEB/seen", body: { seq: 3 } }));
  });
});
