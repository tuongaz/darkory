import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Activity } from "../api/client";
import { mockApi, type Call } from "../test/api";
import { FakeEventSource } from "../test/eventSource";
import { ada, builder, signedIn } from "../test/fixtures";
import { renderApp } from "../test/render";

const at = "2026-10-01T09:00:00Z";

function entry(seq: number, extra: Partial<Activity> = {}): Activity {
  return {
    seq,
    at,
    actor_id: ada.id,
    kind: "task.note_added",
    subject_type: "task",
    subject_id: `k-${seq}`,
    payload: { note_id: `n-${seq}` },
    ...extra,
  };
}

/** Answers `before` reads from a record of `total` entries, as the server pages them. */
function history(total: number, extra: (seq: number) => Partial<Activity> = () => ({})) {
  return ({ query }: Call) => {
    const before = Math.min(Number(query.get("before")), total + 1);
    const limit = Number(query.get("limit"));
    const first = Math.max(1, before - limit);
    const items = [];
    for (let seq = first; seq < before; seq++) items.push(entry(seq, extra(seq)));
    return { items, last_seq: before - 1, first_seq: items.length ? first : undefined };
  };
}

function seqs(): number[] {
  const list = screen.getByRole("list", { name: "Activity" });
  return within(list)
    .getAllByText(/^#\d+$/)
    .map((e) => Number(e.textContent!.slice(1)));
}

describe("Activity", () => {
  it("reads the latest page first and pages backwards with before, newest first", async () => {
    const api = mockApi({ ...signedIn(), "GET /v1/activity": history(150) });
    renderApp("/activity");

    await waitFor(() => expect(seqs()).toHaveLength(100));
    expect(seqs()[0]).toBe(150);
    expect(seqs().at(-1)).toBe(51);
    const reads = () => api.calls.filter((c) => c.path === "/v1/activity");
    expect(reads()[0].query.get("before")).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(reads()[0].query.get("after")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Load older entries" }));

    await waitFor(() => expect(seqs()).toHaveLength(150));
    expect(reads().at(-1)!.query.get("before")).toBe("51");
    expect(seqs().at(-1)).toBe(1);
    expect(seqs()).toEqual([...seqs()].sort((a, b) => b - a));
    // The first entry has been read, so there is nothing older to load.
    expect(screen.queryByRole("button", { name: "Load older entries" })).not.toBeInTheDocument();
  });

  it("says what each kind of entry means, and skips kinds it does not know", async () => {
    const entries: Activity[] = [
      entry(1, { kind: "feature.filed", subject_type: "feature", subject_id: "f-1", payload: { key: "WEB-1", title: "Sign-in" } }),
      entry(2, { kind: "task.claimed", actor_id: builder.id, subject_id: "k-2", payload: { claim_id: "c" } }),
      entry(3, { kind: "something.new" as Activity["kind"], payload: { secret: "x" } }),
      entry(4, { kind: "task.lapsed", actor_id: undefined, payload: { holder_id: builder.id, how_ended: "lapsed" } }),
      entry(5, { kind: "feature.shipped", subject_type: "feature", subject_id: "f-1", payload: {} }),
    ];
    mockApi({ ...signedIn(), "GET /v1/activity": { items: entries, last_seq: 5, first_seq: 1 } });
    renderApp("/activity");

    const list = await screen.findByRole("list", { name: "Activity" });
    // Names come from the Members list, read beside the Activity.
    await waitFor(() => expect(within(list).getByText("#2").closest("li")).toHaveTextContent("builder (agent) claimed a Task"));
    expect(within(list).getByText("#1").closest("li")).toHaveTextContent(/^#1ada filed WEB-1 Sign-in/);
    for (const link of within(list).getAllByRole("link", { name: "WEB-1 Sign-in" })) expect(link).toHaveAttribute("href", "/features/f-1");
    expect(within(list).getByText("#4").closest("li")).toHaveTextContent("Darkory recorded a lapsed Claim on a Task · held by builder (agent), lapsed");
    expect(within(list).queryByText("#3")).not.toBeInTheDocument();
    // An entry whose payload names nothing borrows the name its record was filed with.
    expect(within(list).getByText("#5").closest("li")).toHaveTextContent("ada shipped WEB-1 Sign-in");
  });

  it("reads the history again when the stream shows entries were missed", async () => {
    let total = 5;
    const api = mockApi({ ...signedIn(), "GET /v1/activity": (c) => history(total)(c) });
    renderApp("/activity");
    await waitFor(() => expect(seqs()).toEqual([5, 4, 3, 2, 1]));
    const reads = () => api.calls.filter((c) => c.path === "/v1/activity").length;
    expect(reads()).toBe(1);

    // The stream opened after the history was read, and #6 and #7 were written in between.
    total = 8;
    act(() => FakeEventSource.latest().emit("activity", entry(8), 8));
    await waitFor(() => expect(seqs()).toEqual([8, 7, 6, 5, 4, 3, 2, 1]));
    expect(reads()).toBe(2);

    // From then on the stream follows on from what was read, so nothing is read again.
    total = 9;
    act(() => FakeEventSource.latest().emit("activity", entry(9), 9));
    await waitFor(() => expect(seqs()[0]).toBe(9));
    expect(reads()).toBe(2);
  });
});
