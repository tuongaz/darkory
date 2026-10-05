import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Claim, Skill, SkillProposal, TaskDetail } from "../api/client";
import { mockApi, refuse } from "../test/api";
import { ada, bob, build, builder, feature, signedIn, task } from "../test/fixtures";
import { renderApp } from "../test/render";

function detail(extra: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task: task(42, "f-1"),
    feature: feature(1, 1, { owner_id: bob.id }),
    claims: [],
    notes: [],
    evidence: [],
    blockers: [],
    blocking: [],
    observations: [],
    ...extra,
  };
}

const later = new Date(Date.now() + 10 * 60_000).toISOString();

describe("Task view", () => {
  it("shows a claim refusal with its code", async () => {
    mockApi({
      ...signedIn(),
      "GET /v1/tasks/:task": detail(),
      "POST /v1/tasks/:task/claim": refuse(409, "already_claimed", "bob holds WEB-42"),
    });
    renderApp("/tasks/WEB-42");

    await userEvent.click(await screen.findByRole("button", { name: "Claim" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("already_claimed");
    expect(alert).toHaveTextContent("bob holds WEB-42");
  });

  it("claims for the Member, with no heartbeat timeout, and with an Idempotency-Key", async () => {
    const api = mockApi({
      ...signedIn(),
      "GET /v1/tasks/:task": detail(),
      "POST /v1/tasks/:task/claim": detail(),
    });
    renderApp("/tasks/WEB-42");

    await userEvent.click(await screen.findByRole("button", { name: "Claim" }));

    await waitFor(() => expect(api.calls.some((c) => c.path === "/v1/tasks/k-42/claim")).toBe(true));
    const claim = api.calls.find((c) => c.path === "/v1/tasks/k-42/claim")!;
    expect(claim.body).toEqual({ heartbeat_timeout_seconds: 0 });
    expect(claim.headers.get("Idempotency-Key")).toBeTruthy();
    expect(api.calls.find((c) => c.method === "GET")?.headers.get("Idempotency-Key")).toBeNull();
  });

  it("shows the current Claim and offers the holder's actions", async () => {
    const claim: Claim = {
      id: "c-1",
      task_id: "k-42",
      holder_id: ada.id,
      session_id: "browser-1",
      skill_id: build.id,
      skill_version: 3,
      started_at: "2026-10-01T09:00:00Z",
    };
    mockApi({
      ...signedIn(),
      "GET /v1/tasks/:task": detail({ task: task(42, "f-1", { claim }), claims: [claim] }),
    });
    renderApp("/tasks/WEB-42");

    expect(await screen.findByText("Member-bound")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Complete" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Handover" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Release" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim" })).not.toBeInTheDocument();
    // ada directs bob but holds the Claim herself, so there is nothing to take back.
    expect(screen.queryByRole("form", { name: "Take back" })).not.toBeInTheDocument();
  });

  it("offers take-back to the holder's manager, and shows an agent's Session-bound Claim with its model label", async () => {
    const claim: Claim = {
      id: "c-2",
      task_id: "k-42",
      holder_id: "m-builder",
      session_id: "run-7",
      skill_id: build.id,
      skill_version: 2,
      model_label: "claude-opus-5-5",
      heartbeat_timeout_seconds: 300,
      started_at: "2026-10-01T09:00:00Z",
      expires_at: later,
    };
    mockApi({
      ...signedIn(),
      "GET /v1/tasks/:task": detail({ task: task(42, "f-1", { claim }), claims: [claim] }),
    });
    renderApp("/tasks/WEB-42");

    expect(await screen.findByRole("form", { name: "Take back" })).toBeInTheDocument();
    expect(screen.getAllByText(/Session-bound/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("claude-opus-5-5").length).toBeGreaterThan(0);
    expect(screen.queryByRole("form", { name: "Complete" })).not.toBeInTheDocument();
  });

  describe("Skill proposal", () => {
    const deploy: Skill = { id: "s-deploy", name: "deploy-web", kind: "company", builtin: false, current_version: 3, created_at: "2026-10-01T09:00:00Z" };
    const skillReview: Skill = { id: "s-review-skill", name: "skill-review", kind: "generic", builtin: true, current_version: 1, created_at: "2026-10-01T09:00:00Z" };
    const proposal: SkillProposal = {
      id: "p-1",
      skill_id: deploy.id,
      task_id: "k-42",
      based_on_version: 3,
      body: "1. Build.\n2. Run the smoke tests before deploying.\n3. Deploy.",
      author_id: builder.id,
      state: "pending",
      created_at: "2026-10-01T09:30:00Z",
    };
    const claim: Claim = { id: "c-r", task_id: "k-42", holder_id: ada.id, session_id: "browser-1", skill_id: skillReview.id, started_at: "2026-10-01T10:00:00Z" };

    function routes(current: number) {
      return {
        ...signedIn(),
        "GET /v1/skills": { items: [build, deploy, skillReview] },
        "GET /v1/skills/:skill": {
          skill: { ...deploy, current_version: current },
          current: { skill_id: deploy.id, version: current, body: "1. Build.\n2. Deploy.", published_at: "2026-10-01T08:00:00Z" },
        },
        "GET /v1/tasks/:task": detail({
          task: task(42, "f-1", { kind: "retrospective", skill_id: skillReview.id, claim }),
          claims: [claim],
          proposal,
        }),
      };
    }

    it("shows the proposal's author, Skill, base version and text for its reviewer", async () => {
      mockApi(routes(3));
      renderApp("/tasks/WEB-42");

      const section = await screen.findByRole("region", { name: "Skill proposal" });
      // Names come from the Members and Skills lists, read beside the Task.
      await waitFor(() => expect(section).toHaveTextContent("deploy-web"));
      expect(section).toHaveTextContent("version 3");
      expect(section).toHaveTextContent("builder (agent)");
      expect(section).toHaveTextContent("pending");
      const text = screen.getByLabelText("Proposed text");
      expect(text.tagName).toBe("PRE");
      expect(text.textContent).toBe(proposal.body);
      expect(await screen.findByText("Current text, version 3")).toBeInTheDocument();
      expect(section).not.toHaveTextContent("proposal_stale");
      // The reviewer holding it learns that completing publishes it.
      expect(screen.getByRole("form", { name: "Complete" })).toHaveTextContent("publishes the proposal as version 4 of deploy-web");
    });

    it("warns when the Skill has moved past the version the proposal was written against", async () => {
      mockApi(routes(4));
      renderApp("/tasks/WEB-42");

      const section = await screen.findByRole("region", { name: "Skill proposal" });
      await waitFor(() => expect(section).toHaveTextContent("version 4 is current"));
      expect(section).toHaveTextContent("proposal_stale");
    });
  });
});
