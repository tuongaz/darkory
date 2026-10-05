import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FeatureDetail } from "../api/client";
import { mockApi } from "../test/api";
import { feature, signedIn, task } from "../test/fixtures";
import { renderApp } from "../test/render";

describe("Feature view", () => {
  it("names each Task's open blockers by display key, linked", async () => {
    const detail: FeatureDetail = {
      feature: feature(1, 1),
      tasks: [
        task(2, "f-1", {
          blocked: true,
          open_blockers: [
            { id: "k-3", key: "WEB-3" },
            { id: "k-9", key: "OPS-9" },
          ],
        }),
        task(3, "f-1"),
      ],
      evidence: [],
    };
    mockApi({ ...signedIn(), "GET /v1/features/:feature": detail, "GET /v1/features/:feature/observations": { items: [] } });
    renderApp("/features/WEB-1");

    const tasks = await screen.findByRole("region", { name: "Tasks" });
    const blocked = within(tasks).getByText("Task 2").closest("li")!;
    expect(blocked).toHaveTextContent("blocked by WEB-3, OPS-9");
    expect(within(blocked).getByRole("link", { name: "OPS-9" })).toHaveAttribute("href", "/tasks/OPS-9");
    expect(within(tasks).getByText("Task 3").closest("li")).not.toHaveTextContent("blocked by");
  });
});
