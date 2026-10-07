// Saved Views on Team › Tasks: what a View keeps beside its filters, and applying, editing, saving
// and leaving one from the page.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Member, View } from "@/api/client";
import { mockApi, refuse, type Call, type Handler } from "@/test/api";
import { ada, feature, me, signedIn, task, web } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { defaultDisplay } from "./derive";
import { statuses } from "./testData";
import { readFeatureView, readTaskView, taskViewRest } from "./views";

describe("what a View keeps beside its filters", () => {
  it("keeps the order as its sort and the rest of the Display with the layout", () => {
    const rest = taskViewRest({ ...defaultDisplay, order: "waiting", group: "feature" }, "board");
    expect(rest).toEqual({
      sort: "waiting",
      display: { layout: "board", group: "feature", showDone: true, showDropped: false, showEndedFeatures: true },
    });
    expect(readTaskView(rest)).toEqual({
      display: { order: "waiting", group: "feature", showDone: true, showDropped: false, showEndedFeatures: true },
      layout: "board",
    });
  });

  it("reads back only what it recognises", () => {
    expect(readTaskView({ sort: "priority", display: { group: "colour", showDone: "yes", layout: "grid" } })).toEqual({ display: {}, layout: undefined });
    expect(readTaskView({})).toEqual({ display: {}, layout: undefined });
    expect(readFeatureView({ display: { showEnded: true } })).toEqual({ showEnded: true });
    expect(readFeatureView({ display: { showEnded: 1 } })).toEqual({});
  });
});

const cart = task(3, "f-1", { title: "Build the cart page", skill_id: "s-review" });
const discount = task(5, "f-1", { title: "Discount codes" });

const saved: View = {
  id: "v-1",
  entity: "tasks",
  team_id: web.id,
  name: "Reviews",
  filters: ["skill:is:s-review"],
  sort: "waiting",
  display: { layout: "list", group: "feature", showDone: true, showDropped: false, showEndedFeatures: true },
  created_at: "2026-10-07T00:00:00Z",
  updated_at: "2026-10-07T00:00:00Z",
};

function routes(views: View[], extra: Record<string, Handler> = {}, member: Member = ada): Record<string, Handler> {
  return {
    ...signedIn(member),
    "GET /v1/me": { ...me(member), teams: [web] },
    "GET /v1/statuses": { items: statuses },
    "GET /v1/tasks": { items: [cart, discount] },
    "GET /v1/features": { items: [feature(1, 1, { title: "Checkout flow" })] },
    "GET /v1/activity": { items: [], last_seq: 0 },
    "GET /v1/views": () => ({ items: views }),
    ...extra,
  };
}

const row = (name: RegExp) => screen.findByRole("link", { name });
const chips = () => screen.queryByRole("toolbar", { name: "Filters" });
const openViews = () => userEvent.click(screen.getByRole("button", { name: "Views" }));

beforeEach(() => localStorage.clear());

describe("Views on Team › Tasks", () => {
  it("applies a View: its pills, its Display, and its name at the head of the chips; edited once they change; Reset leaves it", async () => {
    mockApi(routes([saved]));
    renderApp("/teams/WEB/tasks?view=list");
    await row(/WEB-5/);
    await openViews();
    await userEvent.click(await screen.findByRole("option", { name: /Reviews/ }));

    expect(await within(chips()!).findByLabelText("View Reviews")).toBeInTheDocument();
    expect(within(chips()!).getByRole("button", { name: "Needs: review" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("link", { name: /WEB-5/ })).not.toBeInTheDocument());
    // The View's Display: grouped by Feature.
    expect(screen.getByRole("region", { name: "WEB-1 Checkout flow" })).toBeInTheDocument();

    await userEvent.click(within(chips()!).getByRole("button", { name: "Clear Needs" }));
    expect(await within(chips()!).findByLabelText("View Reviews, edited")).toBeInTheDocument();
    await userEvent.click(within(chips()!).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(chips()).not.toBeInTheDocument());
  });

  it("saves the list as a View with its tokens, sort and Display, and names it on the chips", async () => {
    const views: View[] = [];
    const posts: Call[] = [];
    mockApi(
      routes(views, {
        "POST /v1/views": (c) => {
          posts.push(c);
          const body = c.body as { name: string; filters: string[]; sort: string; display: Record<string, unknown> };
          const view: View = { ...saved, id: "v-9", name: body.name, filters: body.filters, sort: body.sort, display: body.display };
          views.push(view);
          return view;
        },
      }),
    );
    renderApp(`/teams/WEB/tasks?view=board&filter.tasks=${encodeURIComponent("skill:is:s-review")}`);
    await row(/WEB-3/);
    await openViews();
    await userEvent.click(screen.getByRole("button", { name: "Save as view…" }));
    await userEvent.type(screen.getByRole("textbox", { name: "View name" }), "Board of reviews");
    await userEvent.click(screen.getByRole("button", { name: "Save View" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({
      entity: "tasks",
      team: web.id,
      name: "Board of reviews",
      filters: ["skill:is:s-review"],
      sort: "rank",
      display: { layout: "board", group: "status", showDone: true, showDropped: false, showEndedFeatures: true },
    });
    expect(posts[0].headers.get("Idempotency-Key")).toBeTruthy();
    expect(await within(chips()!).findByLabelText("View Board of reviews")).toBeInTheDocument();
  });

  it("words a name already taken beside the field", async () => {
    mockApi(routes([saved], { "POST /v1/views": refuse(409, "conflict", "a View with that name exists") }));
    renderApp("/teams/WEB/tasks?view=list");
    await row(/WEB-5/);
    await openViews();
    await userEvent.click(screen.getByRole("button", { name: "Save as view…" }));
    await userEvent.type(screen.getByRole("textbox", { name: "View name" }), "reviews");
    await userEvent.click(screen.getByRole("button", { name: "Save View" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have a View named “reviews” for this list.");
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue("reviews");
  });
});
