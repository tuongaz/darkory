import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Activity } from "@/api/client";
import { mockApi } from "@/test/api";
import { FakeEventSource } from "@/test/eventSource";
import { ada, build, builder, feature, ops, review, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { dayLabel, groupByDay, matchesFilter } from "./derive";
import { statuses } from "./testing";
import { describe as say, sentenceText, type Lookup } from "./wording";

function at(h: number, m: number, s = 0, dayOffset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, s, 0);
  return d.toISOString();
}

function entry(seq: number, kind: Activity["kind"], payload: Record<string, unknown> = {}, extra: Partial<Activity> = {}): Activity {
  return { seq, at: at(9, 0), kind, actor_id: builder.id, subject_type: kind.split(".")[0] as Activity["subject_type"], subject_id: "k-4", payload, ...extra };
}

const lookup: Lookup = {
  members: new Map([ada, builder].map((m) => [m.id, m])),
  teams: new Map([[web.id, web]]),
  skills: new Map([build, review].map((s) => [s.id, s])),
  tasks: new Map([
    ["k-4", { key: "WEB-4", title: "Payment form" }],
    ["k-8", { key: "WEB-8", title: "Stripe keys?" }],
  ]),
  features: new Map([["f-11", { key: "WEB-11", title: "Login page" }]]),
  statuses: new Map(statuses.items.map((s) => [s.id, s])),
  claims: new Map([["c-5", entry(1, "task.claimed", { claim_id: "c-5", heartbeat_timeout_seconds: 2 })]]),
};

const text = (e: Activity) => sentenceText(say(e, lookup)!);

describe("the Activity wording", () => {
  it("says who did what to which record, and the one detail worth a glance", () => {
    expect(text(entry(2, "task.claimed", { skill_id: build.id, model_label: "claude-sonnet-5-5" }))).toBe(
      "builder claimed WEB-4 Payment form · build · claude-sonnet-5-5",
    );
    expect(text(entry(3, "task.claimed", { skill_id: build.id, heartbeat_timeout_seconds: 2 }))).toBe(
      "builder claimed WEB-4 Payment form · build · Heartbeat every 2 s",
    );
    expect(text(entry(4, "task.status_set", { from: "st-todo", to: "st-review" }))).toBe("builder set the Status of WEB-4 Payment form · Todo → In review");
    expect(text(entry(5, "feature.ranked", { from: 3, to: 1 }, { subject_id: "f-11", actor_id: ada.id }))).toBe("ada ranked WEB-11 Login page · Rank #3 → #1");
    expect(text(entry(6, "feature.filed", { owner_id: builder.id, key: "WEB-11", title: "Login page" }, { subject_id: "f-11", actor_id: ada.id }))).toBe(
      "ada filed the Feature WEB-11 Login page · owner builder",
    );
    expect(text(entry(7, "task.filed", { aimed_at_id: ada.id, blocks: "k-4" }, { subject_id: "k-8" }))).toBe(
      "builder filed WEB-8 Stripe keys? · aimed at ada · blocks WEB-4",
    );
    expect(text(entry(8, "task.skill_proposed", { skill_id: build.id, based_on_version: 1 }))).toBe("builder proposed build v2 on WEB-4 Payment form");
    expect(text(entry(9, "login_link.issued", { member_id: ada.id }, { actor_id: ada.id, subject_id: "l-1" }))).toBe("ada issued a login link for ada");
    expect(text(entry(10, "team.member_added", { member_id: builder.id }, { actor_id: ada.id, subject_id: web.id }))).toBe("ada added builder to Web");
    expect(text(entry(11, "task.observed", { outcome: "didnt_work" }))).toBe("builder added an Observation to WEB-4 Payment form Didn't work");
  });

  it("marks lapses, take-backs and hand-overs instead of saying them, and names Darkory when no Member acted", () => {
    const lapse = entry(12, "task.lapsed", { claim_id: "c-5", holder_id: builder.id }, { actor_id: undefined });
    const s = say(lapse, lookup)!;
    expect(s.mark).toBe("lapsed");
    expect(s.actorId).toBeUndefined();
    expect(sentenceText(s)).toBe("Darkory Lapsed WEB-4 Payment form · held by builder · no Heartbeat in 2 s");
    expect(text(entry(13, "task.taken_back", { holder_id: builder.id }, { actor_id: ada.id }))).toBe("ada Taken back WEB-4 Payment form · held by builder");
    expect(text(entry(14, "task.handed_over", { from_skill_id: build.id, skill_id: review.id }))).toBe("builder Handed over WEB-4 Payment form · build → review");
  });

  it("skips a kind it does not know", () => {
    expect(say(entry(15, "task.renamed" as Activity["kind"]), lookup)).toBeNull();
  });

  it("groups entries by day", () => {
    const now = new Date(at(22, 19)).getTime();
    const entries = [
      entry(133, "task.claimed", {}, { at: at(22, 19, 2) }),
      entry(132, "task.filed", {}, { at: at(22, 19, 2) }),
      entry(131, "task.completed", {}, { at: at(8, 18, 29) }),
      entry(30, "task.claimed", {}, { at: at(9, 5, 0, -1) }),
    ];
    const groups = groupByDay(entries, now);
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.seq)])).toEqual([
      ["Today", [133, 132, 131]],
      ["Yesterday", [30]],
    ]);
    expect(dayLabel(new Date(at(9, 0, 0, -3)), now)).not.toMatch(/Today|Yesterday/);
  });

  it("keeps a live entry on a filtered page by /v1's rule", () => {
    const where = { taskFeature: (id: string) => (id === "k-4" ? "f-1" : undefined), featureTeam: (id: string) => (id === "f-1" ? web.id : ops.id) };
    const lapse = entry(16, "task.lapsed", { holder_id: builder.id }, { actor_id: undefined });
    expect(matchesFilter(lapse, { member: builder.id }, where)).toBe(true);
    expect(matchesFilter(entry(17, "task.claimed", {}, { actor_id: ada.id }), { member: builder.id }, where)).toBe(false);
    expect(matchesFilter(lapse, { kind: "task.lapsed" }, where)).toBe(true);
    expect(matchesFilter(lapse, { kind: "task.claimed" }, where)).toBe(false);
    expect(matchesFilter(lapse, { team: web.id }, where)).toBe(true);
    expect(matchesFilter(lapse, { team: ops.id }, where)).toBe(false);
    // A Task filed after the page loaded is placed by the Feature its filing names.
    expect(matchesFilter(entry(18, "task.filed", { feature_id: "f-2" }, { subject_id: "k-99" }), { team: ops.id }, where)).toBe(true);
  });
});

describe("the Activity page", () => {
  const payment = task(4, "f-1", { title: "Payment form" });
  const history = [
    entry(1, "feature.filed", { key: "WEB-1", title: "Checkout", owner_id: ada.id }, { actor_id: ada.id, subject_id: "f-1", at: at(9, 0) }),
    entry(2, "task.claimed", { claim_id: "c-5", skill_id: build.id, heartbeat_timeout_seconds: 2 }, { at: at(9, 1, 10) }),
    entry(3, "task.lapsed", { claim_id: "c-5", holder_id: builder.id }, { actor_id: undefined, at: at(9, 1, 12) }),
  ];

  function activityApi() {
    return mockApi({
      ...signedIn(),
      "GET /v1/statuses": statuses,
      "GET /v1/tasks": { items: [payment] },
      "GET /v1/features": { items: [feature(1, 1)] },
      "GET /v1/activity": ({ query }) => {
        const kind = query.get("kind");
        const member = query.get("member");
        const items = history.filter((e) => (!kind || e.kind === kind) && (!member || e.actor_id === builder.id || e.payload.holder_id === builder.id));
        return { items, last_seq: 3, first_seq: items[0]?.seq };
      },
    });
  }

  it("lists the trail newest first, with Darkory for the lapse, and prepends what the stream brings", async () => {
    const api = activityApi();
    renderApp("/activity");
    const list = await screen.findByRole("list", { name: "Activity" });
    const rows = () => within(list).getAllByRole("listitem").filter((li) => li.dataset.seq);
    await waitFor(() => expect(rows().map((r) => r.dataset.seq)).toEqual(["3", "2", "1"]));
    expect(within(rows()[0]).getByRole("img", { name: "Darkory" })).toBeInTheDocument();
    expect(rows()[0]).toHaveTextContent("Darkory Lapsed WEB-4 Payment form · held by builder · no Heartbeat in 2 s");
    expect(within(rows()[0]).getByRole("link", { name: /WEB-4/ })).toHaveAttribute("href", "/activity?task=WEB-4");
    expect(screen.getByText("3 entries loaded")).toBeInTheDocument();
    // Nothing older: no Load older.
    expect(screen.queryByRole("button", { name: "Load older" })).not.toBeInTheDocument();
    expect(api.calls.find((c) => c.path === "/v1/activity")?.query.get("limit")).toBe("100");

    act(() => {
      FakeEventSource.latest().open();
      FakeEventSource.latest().emit("activity", entry(4, "task.completed", { claim_id: "c-6" }, { at: at(9, 2) }), 4);
    });
    await waitFor(() => expect(rows()[0].dataset.seq).toBe("4"));
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toContain("Live");
  });

  it("narrows to a Member through /v1, and keeps only the stream's entries that match", async () => {
    const api = activityApi();
    renderApp("/activity?member=builder");
    await screen.findByText("Member is");
    await waitFor(() => expect(api.calls.some((c) => c.path === "/v1/activity" && c.query.get("member") === "builder")).toBe(true));
    act(() => {
      FakeEventSource.latest().emit("activity", entry(5, "task.claimed", {}, { actor_id: ada.id, at: at(9, 3) }), 5);
      FakeEventSource.latest().emit("activity", entry(6, "task.claimed", {}, { at: at(9, 3) }), 6);
    });
    const list = await screen.findByRole("list", { name: "Activity" });
    await waitFor(() => expect(within(list).getAllByRole("listitem").filter((li) => li.dataset.seq).map((r) => r.dataset.seq)).toEqual(["6", "3", "2"]));

    // × on the chip clears it.
    await userEvent.click(screen.getByRole("button", { name: "Clear Member" }));
    await waitFor(() => expect(screen.queryByText("Member is")).not.toBeInTheDocument());
  });

  it("says how many entries are loaded the same way when there are older ones, and offers them", async () => {
    const page = Array.from({ length: 100 }, (_, i) => entry(200 - i, "task.claimed", { claim_id: `c-${i}` }, { at: at(9, 0) }));
    mockApi({
      ...signedIn(),
      "GET /v1/statuses": statuses,
      "GET /v1/tasks": { items: [payment] },
      "GET /v1/features": { items: [feature(1, 1)] },
      "GET /v1/activity": { items: page, last_seq: 200, first_seq: 101 },
    });
    renderApp("/activity");
    const footer = await screen.findByText("100 entries loaded");
    expect(footer.parentElement).toHaveTextContent(/^100 entries loaded·Load older$/);
    expect(screen.getByRole("button", { name: "Load older" })).toBeInTheDocument();
  });

  it("leaves sign-ins out until the Kind menu or the footer shows them", async () => {
    const signIns = [
      entry(5, "login_link.redeemed", {}, { actor_id: ada.id, subject_type: "member", subject_id: ada.id, at: at(9, 4) }),
      entry(4, "login_link.issued", { member_id: ada.id }, { actor_id: ada.id, subject_type: "member", subject_id: ada.id, at: at(9, 4) }),
    ];
    mockApi({
      ...signedIn(),
      "GET /v1/statuses": statuses,
      "GET /v1/tasks": { items: [payment] },
      "GET /v1/features": { items: [feature(1, 1)] },
      "GET /v1/activity": { items: [...history, ...signIns], last_seq: 5, first_seq: 1 },
    });
    renderApp("/activity");
    const list = await screen.findByRole("list", { name: "Activity" });
    const seqs = () => within(list).getAllByRole("listitem").filter((li) => li.dataset.seq).map((r) => r.dataset.seq);
    await waitFor(() => expect(seqs()).toEqual(["3", "2", "1"]));
    // One group for the day, and no #ids.
    expect(within(list).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toHaveLength(1);
    expect(list).not.toHaveTextContent("#3");
    expect(screen.getByText("2 sign-ins hidden")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Kind" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Show sign-ins" }));
    await waitFor(() => expect(seqs()).toEqual(["5", "4", "3", "2", "1"]));
    expect(screen.queryByText(/sign-ins hidden/)).not.toBeInTheDocument();
  });

  it("filters by Kind from its menu", async () => {
    const api = activityApi();
    renderApp("/activity");
    await screen.findByRole("list", { name: "Activity" });
    await userEvent.click(screen.getByRole("button", { name: "Kind" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Lapsed" }));
    await waitFor(() => expect(api.calls.some((c) => c.path === "/v1/activity" && c.query.get("kind") === "task.lapsed")).toBe(true));
    expect(await screen.findByText("Task lapsed")).toBeInTheDocument();
    expect(await screen.findByText("1 entry loaded")).toBeInTheDocument();
  });
});
