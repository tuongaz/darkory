import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ada, bob, builder, ops, parentTask, step, task } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { ownedParents, progressText } from "./derive";
import { claim, minutes, recordApi } from "./testing";

const section = (name: string) => screen.findByRole("region", { name });
const row = (region: HTMLElement, key: string) => region.querySelector<HTMLElement>(`[data-task="${key}"]`)!;

describe("My work's rules", () => {
  it("lists the open top-level Parents I own by Project, then Rank", () => {
    const counts = { open: 1, working: 0, done: 1, dropped: 0 };
    const a = parentTask(4, counts);
    const b = parentTask(2, counts);
    const c = parentTask(9, counts, { id: "k-ops-9", key: "OPS-9", project_id: ops.id, rank: 1 });
    const ended = parentTask(1, counts, { state: "done" });
    expect(ownedParents([a, b, c, ended, task(5)]).map((t) => t.key)).toEqual(["OPS-9", "WEB-2", "WEB-4"]);
    expect(progressText({ open: 2, working: 1, done: 3, dropped: 1 })).toBe("3 of 6 done · 1 dropped");
  });
});

describe("My work", () => {
  it("shows what I hold, what is aimed at me and the Parents I own, across Projects", async () => {
    const held = task(3, { claim: claim("k-3", ada.id, { expires_at: minutes(15), heartbeat_timeout_seconds: 900 }), title: "Payment form" });
    const forever = task(4, { claim: claim("k-4", ada.id), step_id: step.review, title: "Review the cart" });
    const question = task(8, { aimed_at_id: ada.id, step_id: undefined, filed_by: builder.id, title: "Which currency?" });
    const checkout = parentTask(1, { open: 2, working: 1, done: 3, dropped: 0 }, { title: "Checkout" });
    const opsParent = parentTask(20, { open: 1, working: 0, done: 0, dropped: 0 }, { id: "k-ops-20", key: "OPS-20", project_id: ops.id, title: "Keys" });
    const notMine = parentTask(30, { open: 1, working: 0, done: 0, dropped: 0 }, { owner_id: bob.id });
    recordApi({ tasks: [held, forever, question, checkout, opsParent, notMine] });
    renderApp("/my-work");

    const holding = await section("Held by you");
    expect(row(holding, "WEB-3")).toHaveTextContent(/lapses in 1[45] min/);
    expect(row(holding, "WEB-3")).toHaveTextContent("Build");
    expect(row(holding, "WEB-4")).toHaveTextContent("No expiry");
    expect(row(holding, "WEB-4")).toHaveTextContent("Review");

    const aimed = await section("Aimed at you");
    expect(within(row(aimed, "WEB-8")).getByRole("button", { name: "Answer WEB-8" })).toBeInTheDocument();

    const owned = await section("You own");
    expect(owned.querySelectorAll("[data-task]")).toHaveLength(2);
    expect(row(owned, "WEB-1")).toHaveTextContent("3 of 5 done");
    // Said once, in words: not "3/5" beside it as well.
    expect(row(owned, "WEB-1")).not.toHaveTextContent("3/5");
    expect(row(owned, "WEB-1")).toHaveTextContent("1 working");
    expect(within(row(owned, "WEB-1")).getAllByRole("img", { name: "3 of 5 done" }).length).toBeGreaterThan(0);
    expect(within(row(owned, "OPS-20")).getByTitle("Ops")).toBeInTheDocument();
  });

  it("says so for each empty section", async () => {
    recordApi({ tasks: [task(1, { owner_id: bob.id })] });
    renderApp("/my-work");
    expect(await screen.findByText("You hold nothing")).toBeInTheDocument();
    expect(screen.getByText("No questions for you")).toBeInTheDocument();
    expect(screen.getByText("You own no open Parent")).toBeInTheDocument();
  });
});
