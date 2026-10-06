import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Claim, Feature, Task, TaskDetail } from "@/api/client";
import { mockApi, type Handler } from "@/test/api";
import { ada, bob, builder, build, feature, me, review, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { featureBar, featuresIOwn, myProposals, takeableNow } from "./derive";
import { statuses } from "./testing";

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();


function claim(taskId: string, holder: string, extra: Partial<Claim> = {}): Claim {
  return { id: `c-${taskId}`, task_id: taskId, holder_id: holder, session_id: "sess-1", started_at: minutes(-2), ...extra };
}

describe("the Inbox's rules", () => {
  it("shows at most three Takeable Tasks, and none already aimed at me", () => {
    const aimed = task(8, "f-1", { aimed_at_id: ada.id, skill_id: undefined });
    const takeable = [aimed, task(2, "f-1"), task(3, "f-1"), task(4, "f-1"), task(5, "f-1")];
    const { shown, total } = takeableNow(takeable, [aimed]);
    expect(shown.map((t) => t.key)).toEqual(["WEB-2", "WEB-3", "WEB-4"]);
    expect(total).toBe(4);
    expect(takeableNow(takeable.slice(0, 2), []).shown).toHaveLength(2);
  });

  it("gives a Feature I own its blocked count, its waiting Break down, or its open Retrospective", () => {
    const checkout = feature(1, 2);
    const billing = feature(16, 4);
    const shipped = feature(18, 5, { state: "shipped" });
    const done = feature(30, 7, { state: "dropped" });
    const open = [
      task(3, checkout.id, { blocked: true }),
      task(6, checkout.id, { blocked: true }),
      task(7, checkout.id),
      task(17, billing.id, { kind: "breakdown" }),
      task(21, shipped.id, { kind: "retrospective" }),
    ];
    const rows = featuresIOwn([checkout, billing, shipped, done], open);
    expect(rows.map((r) => [r.feature.key, r.blocked, r.breakdown?.key, r.retrospective?.key])).toEqual([
      ["WEB-1", 2, undefined, undefined],
      ["WEB-16", 0, "WEB-17", undefined],
      ["WEB-18", 0, undefined, "WEB-21"],
    ]);
  });

  it("draws a Feature's bar as done, held and waiting out of all its Tasks", () => {
    const f = feature(1, 1, { task_counts: { open: 5, claimed: 1, done: 2, dropped: 1 } });
    const bar = featureBar(f);
    expect([bar.done, bar.held, bar.waiting]).toEqual([2 / 8, 1 / 8, 4 / 8]);
  });

  it("keeps the pending proposals I wrote", () => {
    const detail = (n: number, author: string, state: "pending" | "published"): TaskDetail =>
      ({
        task: task(n, "f-1", { kind: "retrospective" }),
        proposal: { id: `p-${n}`, skill_id: build.id, task_id: `k-${n}`, based_on_version: 1, body: "", author_id: author, state, created_at: minutes(-1) },
      }) as TaskDetail;
    const kept = myProposals([detail(21, ada.id, "pending"), detail(22, bob.id, "pending"), detail(23, ada.id, "published")], ada.id);
    expect(kept.map((d) => d.task.key)).toEqual(["WEB-21"]);
  });
});

/** The reads the Inbox makes, answered from one record of Tasks and Features. */
function inboxApi({ tasks, features, takeable = [], details = {} }: { tasks: Task[]; features: Feature[]; takeable?: Task[]; details?: Record<string, Partial<TaskDetail>> }) {
  const routes: Record<string, Handler> = {
    ...signedIn(),
    "GET /v1/statuses": statuses,
    "GET /v1/tasks/takeable": { items: takeable },
    "GET /v1/tasks": ({ query }) => {
      if (query.get("aimed_at")) return { items: tasks.filter((t) => t.state === "open" && t.aimed_at_id === query.get("aimed_at")) };
      if (query.get("holder")) return { items: tasks.filter((t) => t.claim?.holder_id === query.get("holder")) };
      if (query.get("state") === "open") return { items: tasks.filter((t) => t.state === "open") };
      return { items: tasks };
    },
    "GET /v1/features": ({ query }) => ({ items: query.get("owner") ? features.filter((f) => f.owner_id === query.get("owner")) : features }),
    "GET /v1/tasks/:task": ({ params }) => ({ task: tasks.find((t) => t.key === params.task), ...details[params.task] }),
  };
  return mockApi(routes);
}

const section = (name: string) => screen.findByRole("region", { name });

describe("the Inbox", () => {
  it("lists what needs me, section by section, in order", async () => {
    const checkout = feature(1, 2, { task_counts: { open: 5, claimed: 1, done: 2, dropped: 0 } });
    const billing = feature(16, 4);
    const onboarding = feature(18, 5, { state: "shipped", owner_id: bob.id });
    const cart = task(3, checkout.id, { blocked: true, claim: claim("k-3", builder.id, { expires_at: minutes(15), heartbeat_timeout_seconds: 900 }), status_id: "st-progress" });
    const question = task(8, checkout.id, {
      title: "Stripe keys for staging?",
      description: "Staging has no STRIPE_SECRET_KEY. Which account do we use?",
      skill_id: undefined,
      aimed_at_id: ada.id,
      filed_by: builder.id,
    });
    cart.open_blockers = [{ id: question.id, key: question.key }];
    const mine = task(14, checkout.id, { title: "Session expiry", claim: claim("k-14", ada.id), status_id: "st-progress" });
    const breakdown = task(17, billing.id, { kind: "breakdown", title: "Break down: Billing export" });
    const retro = task(21, onboarding.id, { kind: "retrospective", title: "Retrospective: Onboarding emails", skill_id: review.id, status_id: "st-review" });
    const takeable = [question, task(24, checkout.id, { title: "Retrospective: Dark mode", kind: "retrospective" })];
    inboxApi({
      tasks: [cart, question, mine, breakdown, retro, ...takeable.slice(1)],
      features: [checkout, billing, onboarding],
      takeable,
      details: {
        "WEB-21": {
          proposal: { id: "p-1", skill_id: build.id, task_id: retro.id, based_on_version: 1, body: "", author_id: ada.id, state: "pending", created_at: minutes(-1) },
        },
      },
    });
    renderApp("/inbox");

    const aimed = await section("Aimed at me");
    expect(within(aimed).getByText("Stripe keys for staging?")).toBeInTheDocument();
    expect(within(aimed).getByText("Staging has no STRIPE_SECRET_KEY. Which account do we use?")).toBeInTheDocument();
    expect(within(aimed).getByText(/blocks WEB-3/)).toBeInTheDocument();
    expect(within(aimed).getByRole("button", { name: "Answer WEB-8" })).toBeInTheDocument();

    const held = await section("Held by me");
    expect(within(held).getByText("Session expiry")).toBeInTheDocument();
    expect(within(held).getByText("No expiry")).toBeInTheDocument();

    // WEB-8 is takeable too, but is shown once, under Aimed at me.
    const take = await section("Takeable now");
    expect(within(take).queryByText("Stripe keys for staging?")).not.toBeInTheDocument();
    expect(within(take).getByRole("button", { name: "Claim WEB-24" })).toHaveAttribute("data-variant", "outline");

    const owned = await section("Features I own");
    expect(within(owned).getByRole("link", { name: "Feature 1" })).toHaveAttribute("href", "/features/WEB-1");
    expect(within(owned).getByText("1 blocked")).toBeInTheDocument();
    expect(within(owned).getByText("2 done · 5 open")).toBeInTheDocument();
    expect(within(owned).getByText("WEB-17")).toBeInTheDocument();
    expect(within(owned).getByText("Waiting")).toBeInTheDocument();

    const proposals = await section("My proposals");
    expect(within(proposals).getByText(/Proposal · build v2/)).toBeInTheDocument();

    const order = within(screen.getByRole("main")).getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(order).toEqual(["Aimed at me", "Held by me", "Takeable now", "Features I own", "My proposals"]);
    // Answer is the page's one primary.
    expect(screen.getAllByRole("button", { name: /^Answer/ })[0]).toHaveAttribute("data-variant", "default");
  });

  it("says in one line that nothing is aimed at me and I hold nothing, and leads with what I can take", async () => {
    const search = feature(9, 3);
    const takeable = [2, 3, 4, 5].map((n) => task(n, search.id));
    inboxApi({ tasks: takeable, features: [search], takeable });
    renderApp("/inbox");

    expect(await screen.findByText("Nothing aimed at you · No Claims")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Aimed at me" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Held by me" })).not.toBeInTheDocument();
    const take = await section("Takeable now");
    expect(within(take).getAllByRole("button", { name: /^Claim/ })).toHaveLength(3);
    expect(within(take).getByRole("button", { name: "Claim WEB-2" })).toHaveAttribute("data-variant", "default");
    expect(within(take).getByRole("link", { name: "1 more in My work" })).toHaveAttribute("href", "/my-work");
    expect(screen.queryByRole("region", { name: "My proposals" })).not.toBeInTheDocument();
  });

  it("claims a Task from its row", async () => {
    const search = feature(9, 3);
    const t = task(2, search.id);
    const api = inboxApi({ tasks: [t], features: [search], takeable: [t] });
    api.routes["POST /v1/tasks/:task/claim"] = ({ params }) => ({ task: { ...t, claim: claim(t.id, ada.id) }, key: params.task });
    renderApp("/inbox");
    await userEvent.click(await screen.findByRole("button", { name: "Claim WEB-2" }));
    await waitFor(() => expect(api.calls.some((c) => c.method === "POST" && c.path === "/v1/tasks/WEB-2/claim")).toBe(true));
  });

  it("Answer claims the question and opens it to write the Note, Complete first; the row moves to Held by me", async () => {
    const checkout = feature(1, 2);
    const question = task(8, checkout.id, { title: "Stripe keys for staging?", skill_id: undefined, aimed_at_id: ada.id, filed_by: builder.id });
    const api = inboxApi({
      tasks: [question],
      features: [checkout],
      takeable: [question],
      details: { "WEB-8": { feature: checkout, status: { id: "st-todo", name: "Todo", kind: "todo", position: 2 }, claims: [], notes: [], evidence: [], blockers: [], blocking: [], observations: [] } },
    });
    api.routes["POST /v1/tasks/:task/claim"] = () => {
      question.claim = claim(question.id, ada.id);
      return question;
    };
    renderApp("/inbox");

    await userEvent.click(await screen.findByRole("button", { name: "Answer WEB-8" }));
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/v1/tasks/WEB-8/claim")).toBe(true);
    const peek = await screen.findByRole("dialog", { name: "Task WEB-8" });
    await waitFor(() => expect(within(peek).getByRole("textbox", { name: "Note" })).toHaveFocus());
    expect(within(peek).getByRole("button", { name: "Complete" })).toBeInTheDocument();
    expect(within(peek).queryByRole("button", { name: "Claim" })).not.toBeInTheDocument();

    const held = await section("Held by me");
    expect(within(held).getByText("Stripe keys for staging?")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Aimed at me" })).not.toBeInTheDocument();
  });

  it("keeps the Inbox heading for a Member with nothing at all", async () => {
    mockApi({ ...signedIn(), "GET /v1/me": me(ada), "GET /v1/statuses": statuses, "GET /v1/tasks/takeable": { items: [] }, "GET /v1/features": ({ query }) => ({ items: query.get("owner") ? [] : [feature(1, 1, { owner_id: bob.id, team_id: web.id })] }) });
    renderApp("/inbox");
    expect(await screen.findByText("Nothing aimed at you · No Claims")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });
});

describe("My work", () => {
  it("lists every takeable Task in next order with its Rank, Skill and how long it has waited", async () => {
    const login = feature(11, 1);
    const billing = feature(16, 4);
    const takeable = [
      task(13, login.id, { title: "Magic link email", skill_id: review.id, waiting_since: minutes(-4), status_id: "st-review" }),
      task(17, billing.id, { title: "Break down: Billing export", kind: "breakdown", waiting_since: minutes(-0.2) }),
    ];
    inboxApi({ tasks: takeable, features: [login, billing], takeable });
    renderApp("/my-work");

    const held = await section("Held by me");
    expect(within(held).getByText("You hold no Claims.")).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Takeable now" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[2].textContent)).toEqual(["Magic link email", "Break down: Billing export"]);
    expect(within(rows[0]).getByText("#1")).toBeInTheDocument();
    expect(within(rows[0]).getByText("review")).toBeInTheDocument();
    expect(within(rows[0]).getByText("4 min")).toBeInTheDocument();
    expect(within(rows[1]).getByText("< 1 min")).toBeInTheDocument();
    expect(await within(rows[0]).findByRole("img", { name: "In review" })).toBeInTheDocument();
    expect(within(rows[0]).getByRole("button", { name: "Claim WEB-13" })).toHaveAttribute("data-variant", "default");
  });
});
