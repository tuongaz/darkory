import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { empty, mockApi, refuse } from "../test/api";
import { renderApp } from "../test/render";

describe("signed out", () => {
  it("explains how to get a login link when /v1/me answers 401", async () => {
    mockApi({ "GET /v1/me": refuse(401, "unauthenticated", "no credential") });
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Sign in to Darkory" })).toBeInTheDocument();
    expect(screen.getByText("darkory login <member>")).toBeInTheDocument();
    expect(screen.getByText(/ask an admin/i)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
  });

  it("asks for a link by email and says the same whatever the address", async () => {
    const api = mockApi({
      "GET /v1/me": refuse(401, "unauthenticated", "no credential"),
      "POST /v1/sign-in/email": () => empty(202),
    });
    renderApp("/");

    await userEvent.type(await screen.findByLabelText("Email"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Email me a link" }));

    expect(await screen.findByRole("status")).toHaveTextContent("If ada@example.com belongs to a Member");
    const sent = api.calls.find((c) => c.path === "/v1/sign-in/email");
    expect(sent?.body).toEqual({ email: "ada@example.com" });
  });

  it("shows any other failure of /v1/me as a refusal, not the sign-in page", async () => {
    mockApi({ "GET /v1/me": refuse(501, "not_implemented", "GET /v1/me is not built yet") });
    renderApp("/");

    expect(await screen.findByRole("alert")).toHaveTextContent("not_implemented");
    expect(screen.queryByRole("heading", { name: "Sign in to Darkory" })).not.toBeInTheDocument();
  });
});
