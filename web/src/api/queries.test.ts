import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Activity } from "./client";
import { affectedBy, invalidateFor, keys } from "./queries";

describe("live invalidation", () => {
  it("maps an Activity kind to the queries its area can change", () => {
    expect(affectedBy("task.claimed")).toEqual(expect.arrayContaining(["task", "tasks", "takeable", "feature", "features"]));
    expect(affectedBy("feature.ranked")).toEqual(expect.arrayContaining(["features", "takeable"]));
    expect(affectedBy("member.created")).toEqual(expect.arrayContaining(["members", "me"]));
    expect(affectedBy("token.revoked")).toEqual(expect.arrayContaining(["tokens", "task"]));
    expect(affectedBy("login_link.redeemed")).toEqual([]);
    expect(affectedBy("something.new")).toBe("all");
  });

  it("refetches the Statuses, and the work they order, when the Organisation's list changes", () => {
    const qc = new QueryClient();
    qc.setQueryData(["statuses"], []);
    qc.setQueryData(keys.task("WEB-1"), {});
    qc.setQueryData(keys.teams, []);

    invalidateFor(qc, { kind: "statuses.changed" });
    expect(qc.getQueryState(["statuses"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.task("WEB-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.teams)?.isInvalidated).toBe(false);

    // Moving one Task leaves the list alone.
    qc.setQueryData(["statuses"], []);
    invalidateFor(qc, { kind: "task.status_set" });
    expect(qc.getQueryState(["statuses"])?.isInvalidated).toBe(false);
  });

  it("marks the affected queries stale and leaves Activity history alone", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.task("WEB-1"), {});
    qc.setQueryData(keys.teams, []);
    qc.setQueryData(keys.activity, {});

    invalidateFor(qc, { kind: "task.completed" });

    expect(qc.getQueryState(keys.task("WEB-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.teams)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(keys.activity)?.isInvalidated).toBe(false);

    // A kind added to the server after this build was made.
    invalidateFor(qc, { kind: "unheard.of" as string as Activity["kind"] });
    expect(qc.getQueryState(keys.teams)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.activity)?.isInvalidated).toBe(false);
  });
});
