import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { mockApi } from "@/test/api";
import { builder, bug, clientX, signedIn, web, workflow } from "@/test/fixtures";
import { newQueryClient } from "@/queryClient";
import type { Activity, RunnerSession } from "./client";
import { affectedBy, invalidateFor, keys, useLabels, useRunnerSessions, useTasks, useWorkflow } from "./queries";

describe("live invalidation", () => {
  it("maps an Activity kind to the queries its area can change", () => {
    expect(affectedBy("task.claimed")).toEqual(expect.arrayContaining(["task", "tasks", "takeable", "runner"]));
    // A Workflow's live facts are the open and worked Tasks at each Step.
    expect(affectedBy("task.advanced")).toContain("workflow");
    expect(affectedBy("workflow.changed")).toEqual(expect.arrayContaining(["workflow", "tasks", "task", "takeable"]));
    // A Label renamed or deleted changes every Task carrying it.
    expect(affectedBy("label.deleted")).toEqual(expect.arrayContaining(["labels", "tasks", "task"]));
    expect(affectedBy("label.created")).not.toContain("projects");
    expect(affectedBy("project.created")).toEqual(expect.arrayContaining(["projects", "project", "me", "workflow"]));
    // A Member given a Skill becomes a taker at the Steps carrying it.
    expect(affectedBy("member.skill_granted")).toEqual(expect.arrayContaining(["members", "me", "workflow"]));
    expect(affectedBy("token.revoked")).toEqual(expect.arrayContaining(["tokens", "task"]));
    expect(affectedBy("login_link.redeemed")).toEqual([]);
    expect(affectedBy("member.agent_changed")).toContain("runner");
    // A Workspace added, changed or removed refetches the list, the Projects that name it and the Tasks.
    expect(affectedBy("workspace.added")).toEqual(expect.arrayContaining(["workspaces", "projects", "task"]));
    expect(affectedBy("project.changed")).not.toContain("workspaces");
    expect(affectedBy("something.new")).toBe("all");
  });

  it("refetches a Project's Workflow and the work at its Steps when it changes, and leaves the Projects alone", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.workflow("WEB"), workflow());
    qc.setQueryData(keys.task("WEB-1"), {});
    qc.setQueryData(keys.projects, []);

    invalidateFor(qc, { kind: "workflow.changed" });
    expect(qc.getQueryState(keys.workflow("WEB"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.task("WEB-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.projects)?.isInvalidated).toBe(false);
  });

  it("marks the affected queries stale and leaves Activity history alone", () => {
    const qc = new QueryClient();
    const history = keys.activity({ project: "WEB" });
    qc.setQueryData(keys.task("WEB-1"), {});
    qc.setQueryData(keys.projects, []);
    qc.setQueryData(history, {});

    invalidateFor(qc, { kind: "task.completed" });

    expect(qc.getQueryState(keys.task("WEB-1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(keys.projects)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(history)?.isInvalidated).toBe(false);

    // A kind added to the server after this build was made.
    invalidateFor(qc, { kind: "unheard.of" as string as Activity["kind"] });
    expect(qc.getQueryState(keys.projects)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(history)?.isInvalidated).toBe(false);
  });
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("the shared reads", () => {
  it("read every page of a Project's Tasks, passing the filter tokens through", async () => {
    const api = mockApi({
      ...signedIn(),
      "GET /v1/tasks": ({ query }) =>
        query.get("cursor") ? { items: [{ id: "k-2" }] } : { items: [{ id: "k-1" }], next_cursor: "c2" },
    });
    const hook = renderHook(() => useTasks({ project: "WEB", filter: ["step:in:st-build,st-review", "holder:is:none"] }), { wrapper: wrap(newQueryClient()) });
    await waitFor(() => expect(hook.result.current.data?.map((t) => t.id)).toEqual(["k-1", "k-2"]));
    const first = api.calls.find((c) => c.path === "/v1/tasks")!;
    expect(first.query.get("project")).toBe("WEB");
    expect(first.query.getAll("filter")).toEqual(["step:in:st-build,st-review", "holder:is:none"]);
  });

  it("read a Project's Workflow with its live facts, and refetch it when a Task advances", async () => {
    const api = mockApi(signedIn());
    const qc = newQueryClient();
    const hook = renderHook(() => useWorkflow("WEB"), { wrapper: wrap(qc) });
    await waitFor(() => expect(hook.result.current.data?.steps.map((s) => s.name)).toEqual(["Backlog", "Plan", "Build", "Review", "Retro", "Skill review"]));
    act(() => invalidateFor(qc, { kind: "task.advanced" }));
    await waitFor(() => expect(api.calls.filter((c) => c.path === "/v1/projects/WEB/workflow")).toHaveLength(2));
  });

  it("list the Labels a Project's Tasks can carry: its own, then the Organisation's", async () => {
    mockApi({ ...signedIn(), "GET /v1/projects/:project/labels": { items: [clientX] }, "GET /v1/labels": { items: [bug] } });
    const qc = newQueryClient();
    const carried = renderHook(() => useLabels(web.key), { wrapper: wrap(qc) });
    const org = renderHook(() => useLabels(), { wrapper: wrap(qc) });
    await waitFor(() => expect(carried.result.current.data?.map((l) => l.name)).toEqual(["client-x", "bug"]));
    await waitFor(() => expect(org.result.current.data?.map((l) => l.name)).toEqual(["bug"]));
  });
});

describe("the Runner's sessions", () => {
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

  function render(list: object) {
    const api = mockApi({ "GET /v1/runner/sessions": list });
    const qc = newQueryClient();
    const hook = renderHook(() => useRunnerSessions(), { wrapper: wrap(qc) });
    const asked = () => api.calls.filter((c) => c.path === "/v1/runner/sessions").length;
    return { qc, hook, asked };
  }

  it("lists them, and reads again when a Task's Activity arrives", async () => {
    const { qc, hook, asked } = render({ items: [session], runner: true });
    await waitFor(() => expect(hook.result.current.data).toEqual({ items: [session], runner: true }));
    act(() => invalidateFor(qc, { kind: "task.completed" }));
    await waitFor(() => expect(asked()).toBe(2));
  });

  it("asks no more once the server says no Runner is attached", async () => {
    const { qc, hook, asked } = render({ items: [], runner: false });
    await waitFor(() => expect(hook.result.current.data).toEqual({ items: [], runner: false }));
    act(() => invalidateFor(qc, { kind: "task.claimed" }));
    await new Promise((done) => setTimeout(done, 20));
    expect(asked()).toBe(1);
    expect(hook.result.current.fetchStatus).toBe("idle");
  });
});
