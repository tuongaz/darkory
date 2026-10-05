import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MemberDetail, Token } from "../../api/client";
import { mockApi } from "../../test/api";
import { ada, bob, builder, signedIn, web } from "../../test/fixtures";
import { renderApp } from "../../test/render";

const builderDetail: MemberDetail = { member: builder, teams: [web], skills: [], reports: [] };
const issued: Token = { id: "tok-1", member_id: builder.id, name: "laptop", prefix: "dk_7f3a", created_at: "2026-10-01T09:00:00Z" };
const secret = "dk_7f3a9c0ffee0123456789abcdef";

describe("admin", () => {
  it("is hidden from Members who are not admins", async () => {
    mockApi({ ...signedIn(bob), "GET /v1/features": { items: [] } });
    renderApp("/");

    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Board" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("refuses its pages to Members who are not admins", async () => {
    mockApi(signedIn(bob));
    renderApp("/admin/members");

    expect(await screen.findByText(/Only admins/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Create a Member" })).not.toBeInTheDocument();
  });

  it("is shown to admins", async () => {
    mockApi({ ...signedIn(ada), "GET /v1/features": { items: [] } });
    renderApp("/");

    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Admin" })).toBeInTheDocument();
  });

  it("shows a new token's secret once, and only its prefix after", async () => {
    let tokens: Token[] = [];
    const api = mockApi({
      ...signedIn(ada),
      "GET /v1/members/:member": builderDetail,
      "GET /v1/members/:member/tokens": () => ({ items: tokens }),
      "POST /v1/members/:member/tokens": () => {
        tokens = [issued];
        return { token: issued, secret };
      },
    });
    renderApp(`/admin/members/${builder.id}`);

    await userEvent.type(await screen.findByLabelText("Name", { selector: "form[aria-label='Issue a token'] input" }), "laptop");
    await userEvent.click(screen.getByRole("button", { name: "Issue token" }));

    expect(await screen.findByDisplayValue(secret)).toBeInTheDocument();
    expect(screen.getByText(/shown only once/)).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({ name: "laptop" });

    // The list, read again after the write, knows only the prefix.
    const list = await screen.findByRole("list", { name: "Tokens" });
    expect(within(list).getByText("dk_7f3a…")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(secret);
  });

  it("issues a login link to copy", async () => {
    mockApi({
      ...signedIn(ada),
      "GET /v1/members/:member": builderDetail,
      "GET /v1/members/:member/tokens": { items: [] },
      "POST /v1/members/:member/login-links": { url: "http://127.0.0.1:7357/v1/login-links/abc", expires_at: "2026-10-01T10:00:00Z" },
    });
    renderApp(`/admin/members/${builder.id}`);

    await userEvent.click(await screen.findByRole("button", { name: "Issue a login link" }));

    expect(await screen.findByLabelText("Login link for builder")).toHaveValue("http://127.0.0.1:7357/v1/login-links/abc");
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});
