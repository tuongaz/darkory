import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FakeEventSource } from "../test/eventSource";
import { mockApi } from "../test/api";
import { ada, bob, feature, signedIn, task } from "../test/fixtures";
import { renderApp } from "../test/render";

function featureNames(): string[] {
  const board = screen.getByRole("region", { name: "Features in Rank order" });
  return within(within(board).getByRole("list"))
    .getAllByRole("link")
    .map((a) => a.textContent ?? "");
}

describe("board", () => {
  it("shows a Team's Features in Rank order with owner and Task counts", async () => {
    const api = mockApi({
      ...signedIn(),
      "GET /v1/features": {
        items: [feature(3, 3, { owner_id: bob.id }), feature(1, 1), feature(2, 2)],
      },
      "GET /v1/tasks": {
        items: [
          task(10, "f-1"),
          task(11, "f-1", { claim: { id: "c", task_id: "k-11", holder_id: bob.id, session_id: "s", started_at: "2026-10-01T09:00:00Z" } }),
          task(12, "f-1", { state: "done" }),
        ],
      },
    });
    renderApp("/");

    await screen.findByText("Feature 1");
    expect(featureNames()).toEqual(["WEB-1 Feature 1", "WEB-2 Feature 2", "WEB-3 Feature 3"]);
    const first = screen.getByText("Feature 1").closest("li")!;
    expect(first).toHaveTextContent("owned by ada");
    expect(first).toHaveTextContent("Tasks: 1 open · 1 claimed · 1 done");
    expect(screen.getByText("Feature 3").closest("li")).toHaveTextContent("owned by bob");
    // The Team defaults to the caller's first Team.
    expect(api.calls.find((c) => c.path === "/v1/features")?.query.get("team")).toBe("WEB");
  });

  it("moves a Feature to its neighbour's place in the Rank, skipping hidden ended ones", async () => {
    const api = mockApi({
      ...signedIn(),
      "GET /v1/features": { items: [feature(1, 1), feature(2, 2, { state: "shipped" }), feature(3, 3)] },
      "GET /v1/tasks": { items: [] },
      "POST /v1/features/:feature/rank": ({ params }) => feature(3, 1, { id: params.feature }),
    });
    renderApp("/");

    await userEvent.click(await screen.findByRole("button", { name: "Move WEB-3 up" }));

    await waitFor(() => expect(api.calls.some((c) => c.path === "/v1/features/f-3/rank")).toBe(true));
    const rank = api.calls.find((c) => c.path === "/v1/features/f-3/rank")!;
    expect(rank.body).toEqual({ position: 1 });
    expect(rank.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refetches when an Activity event arrives on the stream", async () => {
    const api = mockApi({
      ...signedIn(),
      "GET /v1/features": { items: [feature(1, 1)] },
      "GET /v1/tasks": { items: [] },
    });
    renderApp("/");
    await screen.findByText("Feature 1");
    expect(FakeEventSource.latest().url).toBe("/v1/activity/stream");
    expect(FakeEventSource.latest().withCredentials).toBe(true);

    // Someone else files a Feature; the stream says so.
    api.routes["GET /v1/features"] = { items: [feature(1, 1), feature(2, 2)] };
    act(() => {
      FakeEventSource.latest().open();
      FakeEventSource.latest().emit(
        "activity",
        { seq: 7, at: "2026-10-01T09:00:00Z", actor_id: ada.id, kind: "feature.filed", subject_id: "f-2", payload: {} },
        7,
      );
    });

    expect(await screen.findByText("Feature 2")).toBeInTheDocument();
    expect(screen.getByText("Live")).toHaveAttribute("role", "status");
  });
});
