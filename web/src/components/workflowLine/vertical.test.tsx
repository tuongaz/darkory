import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BIG, MAIN, SOFTWARE } from "./fixtures";
import { WorkflowLine } from "./WorkflowLine";

// The phone says in words what the line draws where Tasks enter.
describe("the line down a phone", () => {
  it("says where new Tasks start, what Break down does, and that Backlog's Tasks move on by hand", () => {
    render(<WorkflowLine workflow={MAIN} tasks={[{ id: "t1", key: "MAIN-1", title: "Later", stepId: "backlog", kind: "work", blockers: [] }]} now={0} orientation="vertical" />);
    const enter = screen.getByRole("region", { name: "Where Tasks enter" });
    expect(within(enter).getByText("Break down")).toBeInTheDocument();
    expect(within(enter).getByText("files Subtasks", { exact: true })).toBeInTheDocument();
    expect(within(enter).getByText("done → Done")).toBeInTheDocument();
    expect(within(enter).getByText("hold · moved on by hand")).toBeInTheDocument();
    expect(within(enter).getByRole("button", { name: "MAIN-1 Later, in the hold" })).toBeInTheDocument();
    expect(within(enter).getByText(/New Tasks start here/)).toHaveTextContent("New Tasks start here↓Build");
    // Build, QA, Review and Done run down the rail; Backlog and Plan do not.
    const rail = screen.getByRole("list", { name: "Steps on the line" });
    expect(within(rail).queryByText("Backlog")).toBeNull();
    expect(within(rail).queryByText("Plan")).toBeNull();
  });

  it("marks a start Step the entry cannot lead into (BIG: Triage after Backlog)", () => {
    render(<WorkflowLine workflow={BIG} tasks={[]} now={0} orientation="vertical" />);
    const rail = screen.getByRole("list", { name: "Steps on the line" });
    const mark = rail.querySelector("[data-entry-mark]");
    expect(mark).toHaveTextContent("New Tasks start here, at Triage");
    expect(mark?.closest("li")).toHaveTextContent(/Triage/);
  });

  it("names no Step for the Subtasks Break down files: in the software Workflow Plan files its Design Subtask at Design, Triage is only the default", () => {
    render(<WorkflowLine workflow={SOFTWARE} tasks={[]} now={0} orientation="vertical" />);
    const enter = screen.getByRole("region", { name: "Where Tasks enter" });
    const files = within(enter).getByText("files Subtasks", { exact: true });
    expect(within(enter).queryByText(/files Subtasks →/)).toBeNull();
    expect(files.parentElement).toHaveAttribute("title", expect.stringMatching(/files the Parent's other Subtasks, each at the Step its filer names, Triage when they name none$/));
  });
});
