import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Token } from "../api/client";
import { mockApi } from "../test/api";
import { bob, signedIn } from "../test/fixtures";
import { renderApp } from "../test/render";

const at = "2026-10-01T09:00:00Z";
const laptop: Token = { id: "tok-1", member_id: bob.id, name: "laptop", prefix: "dk_7f3a", created_at: at };
const ci: Token = { id: "tok-2", member_id: bob.id, name: "ci", prefix: "dk_91bc", created_at: at, revoked_at: at };

describe("my account", () => {
  it("lets a Member who is not an admin revoke their own token", async () => {
    let tokens = [laptop, ci];
    const api = mockApi({
      ...signedIn(bob),
      "GET /v1/members/:member/tokens": () => ({ items: tokens }),
      "POST /v1/tokens/:token/revoke": ({ params }) => {
        tokens = tokens.map((t) => (t.id === params.token ? { ...t, revoked_at: at } : t));
        return tokens.find((t) => t.id === params.token);
      },
    });
    renderApp("/account");

    const list = await screen.findByRole("list", { name: "Tokens" });
    expect(api.calls.find((c) => c.path.endsWith("/tokens"))?.path).toBe(`/v1/members/${bob.id}/tokens`);
    expect(within(list).getByText("dk_7f3a…")).toBeInTheDocument();
    // A revoked token cannot be revoked again.
    expect(within(list).queryByRole("button", { name: "Revoke token ci" })).not.toBeInTheDocument();

    await userEvent.click(within(list).getByRole("button", { name: "Revoke token laptop" }));
    expect(api.calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);
    await userEvent.click(within(list).getByRole("button", { name: /Revoke laptop/ }));

    await waitFor(() => expect(api.calls.some((c) => c.path === "/v1/tokens/tok-1/revoke")).toBe(true));
    await waitFor(() => expect(within(list).queryByRole("button", { name: "Revoke token laptop" })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "My account" })).toHaveClass("active");
  });

  it("closes one of the Member's Sessions by its id", async () => {
    const api = mockApi({
      ...signedIn(bob),
      "GET /v1/members/:member/tokens": { items: [] },
      "POST /v1/sessions/:session/close": ({ params }) => ({
        session: { id: params.session, member_id: bob.id, kind: "token", started_at: at, last_seen_at: at, closed_at: at },
        claims_ended: 2,
      }),
    });
    renderApp("/account");

    await userEvent.type(await screen.findByLabelText("Session id"), "run-7");
    await userEvent.click(screen.getByRole("button", { name: "Close Session" }));

    const section = screen.getByRole("region", { name: "Close a Session" });
    expect(await within(section).findByRole("status")).toHaveTextContent("Closed Session run-7; 2 Claims ended.");
    const close = api.calls.find((c) => c.path === "/v1/sessions/run-7/close")!;
    expect(close.query.get("member")).toBeNull();
  });
});
