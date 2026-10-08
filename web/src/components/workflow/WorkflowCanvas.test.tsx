import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connection, NodeChange, ReactFlowProps } from "@xyflow/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { DONE_NODE, DROPPED_NODE, type CanvasNode, type ConnectorFlowEdge } from "./flow";
import { tidy } from "./layout";
import type { Workflow } from "./model";
import { sampleSteps, sampleSubtasks, sampleWorkflow } from "./samples";
import { SubtaskGraph } from "./SubtaskGraph";
import { WorkflowCanvas } from "./WorkflowCanvas";

// What the canvas hands React Flow, so a test can play the drags jsdom cannot: a connection
// drawn, an end dragged, a Step dropped.
const flow = vi.hoisted(() => ({ props: undefined as unknown as ReactFlowProps<CanvasNode, ConnectorFlowEdge> }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...mod,
    ReactFlow: (props: ReactFlowProps<CanvasNode, ConnectorFlowEdge>) => {
      if (props.onConnect) flow.props = props;
      return <mod.ReactFlow {...(props as ComponentProps<typeof mod.ReactFlow>)} />;
    },
  };
});

const docs = { id: "s-docs", name: "Docs", skill: { id: "k-docs", name: "docs" }, position: 8, x: 0, y: 900, takers: [], tasks: 0, working: 0 };
const workflow: Workflow = { ...sampleWorkflow, steps: [...sampleWorkflow.steps, docs] };

function renderCanvas(mode: "live" | "edit" = "edit") {
  const calls = {
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onAddStep: vi.fn(),
    onAddConnector: vi.fn(),
    onConnectorChange: vi.fn(),
    onDeleteStep: vi.fn(),
    onDeleteConnector: vi.fn(),
    onLayout: vi.fn(),
  };
  render(<WorkflowCanvas workflow={workflow} mode={mode} {...calls} />);
  return calls;
}

// React Flow draws a node hidden until it has measured it, which jsdom never does.
const stepNode = (name: string) => screen.getAllByRole("group", { hidden: true }).find((n) => n.getAttribute("aria-label")?.startsWith(`${name}:`))!;
const connection = (source: string, target: string): Connection => ({ source, target, sourceHandle: "out", targetHandle: "in" });

describe("WorkflowCanvas, editing", () => {
  it("names each Step for a screen reader, in the Workflow's order", () => {
    renderCanvas();
    const names = screen.getAllByRole("group", { hidden: true }).map((n) => n.getAttribute("aria-label")?.split(":")[0]);
    expect(names.slice(0, 3)).toEqual(["Backlog", "Plan", "Build"]);
    expect(stepNode("Docs")).toHaveAttribute(
      "aria-label",
      "Docs: Skill docs; 0 waiting, 0 working; no Member has docs; no way out: its Tasks can only be moved by hand",
    );
  });

  it("warns on a Step with a Skill and no Connector out, and on no hold", () => {
    renderCanvas();
    expect(within(stepNode("Docs")).getByText("No way out")).toHaveAttribute("title", "No way out: Tasks here can only be moved by hand.");
    expect(within(stepNode("Backlog")).queryByText("No way out")).toBeNull();
    expect(within(stepNode("Review")).queryByText("No way out")).toBeNull();
  });

  it("selects a Step on Enter, says so, and opens its panel with the Connectors out", async () => {
    const calls = renderCanvas();
    act(() => stepNode("Review").focus());
    fireEvent.keyDown(stepNode("Review"), { key: "Enter" });
    expect(calls.onSelect).toHaveBeenLastCalledWith(workflow.steps.find((s) => s.id === "s-review"));
    const panel = await screen.findByRole("region", { name: "Selected", hidden: true });
    expect(within(panel).getByRole("heading", { name: "Review", hidden: true })).toBeInTheDocument();
    const out = within(panel).getByRole("list", { name: "Connectors out of Review", hidden: true });
    expect(within(out).getAllByRole("listitem", { hidden: true }).map((li) => li.textContent)).toEqual(["passDone", "needs changesBuild"]);

    await userEvent.click(within(panel).getByRole("button", { name: "Remove needs changes to Build", hidden: true }));
    expect(calls.onDeleteConnector).toHaveBeenCalledWith(workflow.connectors.find((c) => c.id === "c-review-build"));

    await userEvent.click(within(panel).getByRole("button", { name: "Close", hidden: true }));
    expect(calls.onSelect).toHaveBeenLastCalledWith(null);
  });

  it("deletes a Step without Tasks at once, and asks where a Step's Tasks go before deleting it", async () => {
    const calls = renderCanvas();
    act(() => stepNode("Retro").focus());
    fireEvent.keyDown(stepNode("Retro"), { key: "Enter" });
    await userEvent.click(await screen.findByRole("button", { name: "Delete Retro", hidden: true }));
    expect(calls.onDeleteStep).toHaveBeenCalledWith(workflow.steps.find((s) => s.id === "s-retro"), undefined);

    act(() => stepNode("Build").focus());
    fireEvent.keyDown(stepNode("Build"), { key: "Enter" });
    await userEvent.click(await screen.findByRole("button", { name: "Delete Build", hidden: true }));
    expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent("4 Tasks are at Build: say which Step they move to.");
    expect(calls.onDeleteStep).toHaveBeenCalledTimes(1);
  });

  it("adds a Step after one from its +", async () => {
    const calls = renderCanvas();
    await userEvent.click(screen.getByRole("button", { name: "Add a Step after QA", hidden: true }));
    expect(calls.onAddStep).toHaveBeenCalledWith("s-qa");
  });

  it("tidies up into dagre's positions", async () => {
    const calls = renderCanvas();
    await userEvent.click(screen.getByRole("button", { name: "Tidy up", hidden: true }));
    expect(calls.onLayout).toHaveBeenCalledWith(tidy(workflow));
  });

  it("turns a connection drawn into a Step or Done into a Connector, and refuses the rest in words", () => {
    const calls = renderCanvas();
    act(() => flow.props.onConnect!(connection("s-docs", DONE_NODE)));
    expect(calls.onAddConnector).toHaveBeenLastCalledWith({ from: "s-docs", to: null });
    act(() => flow.props.onConnect!(connection("s-docs", "s-review")));
    expect(calls.onAddConnector).toHaveBeenLastCalledWith({ from: "s-docs", to: "s-review" });

    act(() => flow.props.onConnect!(connection("s-docs", "s-docs")));
    expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent("A Connector leads out of Docs into another Step or Done.");
    act(() => flow.props.onConnect!(connection("s-docs", DROPPED_NODE)));
    expect(screen.getByRole("alert", { hidden: true })).toHaveTextContent("Dropped needs no Connector");
    expect(calls.onAddConnector).toHaveBeenCalledTimes(2);
  });

  it("moves a Connector's end when it is dragged onto another Step", () => {
    const calls = renderCanvas();
    const edge = flow.props.edges!.find((e) => e.id === "c-qa-build")!;
    act(() => flow.props.onReconnect!(edge, connection("s-qa", "s-review")));
    expect(calls.onConnectorChange).toHaveBeenCalledWith(workflow.connectors.find((c) => c.id === "c-qa-build"), { from: "s-qa", to: "s-review" });
    // Dropped where it was: nothing to send.
    act(() => flow.props.onReconnect!(edge, connection("s-qa", "s-build")));
    expect(calls.onConnectorChange).toHaveBeenCalledTimes(1);
  });

  it("says where a Step was dropped, once, when the drag ends", () => {
    const calls = renderCanvas();
    const move = (dragging: boolean): NodeChange<CanvasNode>[] => [{ type: "position", id: "s-plan", position: { x: 101.4, y: 202.6 }, dragging }];
    act(() => flow.props.onNodesChange!(move(true)));
    expect(calls.onMove).not.toHaveBeenCalled();
    act(() => flow.props.onNodesChange!(move(false)));
    expect(calls.onMove).toHaveBeenCalledWith(workflow.steps.find((s) => s.id === "s-plan"), 101, 203);
  });

  it("adds a Step where a connection is let go over empty canvas", () => {
    const calls = renderCanvas();
    const fromNode = { id: "s-docs" } as never;
    act(() =>
      flow.props.onConnectEnd!(new MouseEvent("mouseup", { clientX: 400, clientY: 300 }), {
        isValid: false,
        fromNode,
        fromHandle: { id: "out", type: "source" } as never,
        toNode: null,
      } as never),
    );
    expect(calls.onAddStep).toHaveBeenCalledWith("s-docs", { x: expect.any(Number), y: expect.any(Number) });
  });
});

describe("WorkflowCanvas, live", () => {
  it("offers no editing: no +, no Tidy up, nothing to drag or connect", () => {
    renderCanvas("live");
    expect(screen.queryByRole("button", { name: /Add a Step after/, hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tidy up", hidden: true })).toBeNull();
    expect(screen.getByRole("region", { name: "Workflow" })).toHaveAttribute("data-mode", "live");
  });

  it("rings a working taker's mark", () => {
    renderCanvas("live");
    expect(screen.getAllByRole("img", { name: "builder-2 (agent), working, its session stalled", hidden: true })[0]).toHaveAttribute("data-working", "stalled");
  });
});

describe("SubtaskGraph", () => {
  it("opens a Subtask on a click, and names each with its state and whether it can be taken now", async () => {
    const onOpen = vi.fn();
    render(<SubtaskGraph steps={sampleSteps} subtasks={sampleSubtasks} onOpen={onOpen} />);
    const takeable = screen.getByRole("button", { name: "MAIN-5 Normalise names on input, Waiting, takeable now", hidden: true });
    expect(takeable).toHaveAttribute("data-takeable", "true");
    expect(screen.getByRole("button", { name: "MAIN-6 Render emoji in the sidebar, Working, its session running, held by builder-1", hidden: true })).not.toHaveAttribute(
      "data-takeable",
    );
    await userEvent.click(takeable);
    expect(onOpen).toHaveBeenCalledWith("t-5");
  });

  it("draws nothing for a Parent without Subtasks", () => {
    const { container } = render(<SubtaskGraph steps={sampleSteps} subtasks={[]} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
