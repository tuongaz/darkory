import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bug, clientX } from "@/test/fixtures";
import { LabelPills } from "./LabelPill";

describe("LabelPills", () => {
  it("draws the Labels a Task names that still exist, by name, each with its own colour", () => {
    const labels = new Map([bug, clientX].map((l) => [l.id, l]));
    render(<LabelPills ids={[clientX.id, "l-gone", bug.id]} labels={labels} />);
    const group = screen.getByLabelText("Labels: bug, client-x");
    expect([...group.querySelectorAll("[data-label]")].map((e) => e.getAttribute("data-label"))).toEqual(["bug", "client-x"]);
    expect(group.querySelector("[data-label=bug] [aria-hidden]")).toHaveStyle({ backgroundColor: "#d1453b" });
  });

  it("draws nothing for a Task with none", () => {
    const { container } = render(<LabelPills ids={undefined} labels={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
