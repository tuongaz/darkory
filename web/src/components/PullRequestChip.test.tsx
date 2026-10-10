import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PullRequestChip } from "./PullRequestChip";

describe("a pull request's chip", () => {
  it("links to the pull request on GitHub in a new tab", () => {
    render(<PullRequestChip pr={{ number: 7, url: "https://github.com/o/r/pull/7", state: "open" }} />);
    const link = screen.getByRole("link", { name: "#7 open" });
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/7");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("is plain text when its address is not https", () => {
    render(<PullRequestChip pr={{ number: 7, url: "javascript:alert(1)", state: "merged" }} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("#7 merged")).toBeInTheDocument();
  });
});
