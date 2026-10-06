import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { mockApi } from "@/test/api";
import { health, signedIn } from "@/test/fixtures";
import { renderApp } from "@/test/render";

describe("update notice", () => {
  afterEach(() => localStorage.clear());

  it("says a newer release exists until dismissed, and stays dismissed for that version", async () => {
    mockApi({
      ...signedIn(),
      "GET /v1/health": health({ version: "v1.2.0", update_available: true, latest_version: "v1.3.0" }),
      
    });
    const first = renderApp("/");

    const notice = await screen.findByRole("complementary", { name: "Update available" });
    expect(notice).toHaveTextContent("Update available: v1.3.0");
    expect(notice).toHaveTextContent("This server runs v1.2.0");

    await userEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("complementary", { name: "Update available" })).not.toBeInTheDocument();

    // A later visit remembers the dismissal.
    first.unmount();
    renderApp("/");
    await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(localStorage.getItem("darkory.update-dismissed")).toBe("v1.3.0"));
    expect(screen.queryByRole("complementary", { name: "Update available" })).not.toBeInTheDocument();
  });

  it("shows nothing when the Install is current or has not checked", async () => {
    const api = mockApi({
      ...signedIn(),
      "GET /v1/health": health({ update_available: false, latest_version: "v1.2.0" }),
      
    });
    renderApp("/");

    await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() => expect(api.calls.some((c) => c.path === "/v1/health")).toBe(true));
    expect(screen.queryByRole("complementary", { name: "Update available" })).not.toBeInTheDocument();
  });
});
