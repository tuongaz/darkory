import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { mockApi, refuse } from "@/test/api";
import { ada, builder } from "@/test/fixtures";
import { newQueryClient } from "@/queryClient";
import type { Activity, Member, RunnerSession } from "./client";
import { affectedBy, invalidateFor, keys, useRunnerSessions } from "./queries";

describe("live invalidation", () => {
  it("maps an Activity kind to the queries its area can change", () => {
    expect(affectedBy("task.claimed")).toEqual(expect.arrayContaining(["task", "tasks", "takeable", "feature", "features"]));
    expect(affectedBy("feature.ranked")).toEqual(expect.arrayContaining(["features", "takeable"]));
    expect(affectedBy("member.created")).toEqual(expect.arrayContaining(["members", "me"]));
    expect(affectedBy("token.revoked")).toEqual(expect.arrayContaining(["tokens", "task"]));
    expect(affectedBy("login_link.redeemed")).toEqual([]);
    expect(affectedBy("task.handed_over")).toContain("runner");
    expect(affectedBy("member.agent_changed")).toContain("runner");
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

describe("the Runner's sessions", () => {
  const configured: Member = { ...builder, agent: { command: "claude", args: [], model: "claude-sonnet-5-5", env: {}, unattended: true, paused: false } };
  const session: RunnerSession = {
    task_id: "k-12",
    member_id: builder.id,
    session_id: "sess-builder",
    host: "mac-mini",
    tmux: "dk-WEB-12",
    started_at: "2026-10-07T04:25:00Z",
    state: "running",
    log_path: "/data/sessions/WEB-12/pane.log",
  };

  function render(members: Member[], sessions: () => Response | object) {
    const api = mockApi({ "GET /v1/members": { items: members }, "GET /v1/runner/sessions": sessions });
    const qc = newQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useRunnerSessions(), { wrapper });
    const asked = () => api.calls.filter((c) => c.path === "/v1/runner/sessions").length;
    return { qc, hook, asked };
  }

  it("lists them, and reads again when a Task's Activity arrives", async () => {
    const { qc, hook, asked } = render([ada, configured], () => ({ items: [session] }));
    await waitFor(() => expect(hook.result.current.data).toEqual({ runner: true, items: [session] }));
    act(() => invalidateFor(qc, { kind: "task.completed" }));
    await waitFor(() => expect(asked()).toBe(2));
  });

  it("asks nothing while no agent has agent settings: the Runner starts no other", async () => {
    const { hook, asked } = render([ada, builder], () => ({ items: [] }));
    await waitFor(() => expect(hook.result.current.fetchStatus).toBe("idle"));
    expect(asked()).toBe(0);
    expect(hook.result.current.data).toBeUndefined();
  });

  it("says no Runner is attached on no_runner, and asks no more", async () => {
    const { qc, hook, asked } = render([ada, configured], () => refuse(409, "no_runner", "no Runner is attached to this server"));
    await waitFor(() => expect(hook.result.current.data).toEqual({ runner: false, items: [] }));
    act(() => invalidateFor(qc, { kind: "task.claimed" }));
    await new Promise((done) => setTimeout(done, 20));
    expect(asked()).toBe(1);
  });
});
