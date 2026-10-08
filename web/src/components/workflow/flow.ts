import { Position, type Edge, type Node, type NodeHandle } from "@xyflow/react";
import { STEP_H, STEP_W, TERMINAL_H, TERMINAL_W, terminals } from "./layout";
import { stepsInOrder, targetName, unstaffed, waitingAt, type Connector, type Ends, type Step, type Workflow } from "./model";
import { routeConnectors, type Rect, type Route } from "./route";

/** The terminal nodes' ids; a Step's id is a UUID, so these never meet one. */
export const DONE_NODE = "@done";
export const DROPPED_NODE = "@dropped";

export type Mode = "live" | "edit";

export type StepFlowNode = Node<{ step: Step }, "step">;
export type TerminalFlowNode = Node<{ terminal: "done" | "dropped" }, "terminal">;
export type CanvasNode = StepFlowNode | TerminalFlowNode;
export type ConnectorFlowEdge = Edge<{ connector: Connector; route: Route }, "connector">;

// A Step's handles, where a Connector's route leaves and enters it (route.ts): out on the right
// and in on the left, which a drag connects; and, for a route back, out on the left and in from
// below, above or the right. Given here so the edges draw before the nodes are measured; once
// they are, React Flow reads the real ones.
const handle = (id: string, type: "source" | "target", position: Position, x: number, y: number): NodeHandle => ({
  id,
  type,
  position,
  x: x - 4,
  y: y - 4,
  width: 8,
  height: 8,
});
const stepHandles = [
  handle("in", "target", Position.Left, 0, STEP_H / 2),
  handle("out", "source", Position.Right, STEP_W, STEP_H / 2),
  handle("out-left", "source", Position.Left, 0, STEP_H / 2),
  handle("in-right", "target", Position.Right, STEP_W, STEP_H / 2),
  handle("in-bottom", "target", Position.Bottom, STEP_W / 2, STEP_H),
  handle("in-top", "target", Position.Top, STEP_W / 2, 0),
];
const exitHandles = { right: "out", left: "out-left" } as const;
const entryHandles = { left: "in", right: "in-right", bottom: "in-bottom", top: "in-top" } as const;

/** A Step in words, for its node's `aria-label`. */
export function stepLabel(step: Step): string {
  const what = step.skill ? `Skill ${step.skill.name}` : "a hold, moved on by hand";
  const counts = `${waitingAt(step)} waiting, ${step.working} working`;
  const who = unstaffed(step)
    ? `no Member has ${step.skill!.name}`
    : step.takers.length > 0
      ? `taken by ${step.takers.map((t) => (t.kind === "agent" ? `${t.name} (agent)` : t.name)).join(", ")}`
      : "";
  return [`${step.name}: ${what}`, counts, who].filter(Boolean).join("; ");
}

/**
 * The canvas's nodes: the Steps in the Workflow's order (the order Tab walks them in), then Done
 * and Dropped, fixed right of them. Editing, a Step can be dragged, selected and connected.
 */
export function toNodes(workflow: Workflow, mode: Mode): CanvasNode[] {
  const edit = mode === "edit";
  const { done, dropped } = terminals(workflow);
  const steps: StepFlowNode[] = stepsInOrder(workflow).map((step) => ({
    id: step.id,
    type: "step",
    position: { x: step.x, y: step.y },
    data: { step },
    width: STEP_W,
    height: STEP_H,
    handles: stepHandles,
    // Live, React Flow would give a node no one selects or drags no pointer; its titles (the
    // median, "+N") need one.
    style: { pointerEvents: "all" },
    draggable: edit,
    connectable: edit,
    selectable: edit,
    deletable: false,
    ariaLabel: stepLabel(step),
  }));
  const terminal = (id: string, kind: "done" | "dropped", at: { x: number; y: number }, ariaLabel: string): TerminalFlowNode => ({
    id,
    type: "terminal",
    position: at,
    data: { terminal: kind },
    width: TERMINAL_W,
    height: TERMINAL_H,
    handles: kind === "done" ? [handle("in", "target", Position.Left, 0, TERMINAL_H / 2)] : [],
    draggable: false,
    connectable: edit && kind === "done",
    selectable: false,
    deletable: false,
    ariaLabel,
  });
  return [
    ...steps,
    terminal(DONE_NODE, "done", done, "Done"),
    terminal(DROPPED_NODE, "dropped", dropped, "Dropped: a Task's Owner drops it from any Step"),
  ];
}

/** The nodes' boxes where they stand now, mid-drag too, and the dashed arrow into Dropped. */
export function boxesOf(nodes: CanvasNode[]): { boxes: Map<string, Rect>; extra: Rect[] } {
  const boxes = new Map<string, Rect>();
  const extra: Rect[] = [];
  for (const n of nodes) {
    const box = { x: n.position.x, y: n.position.y, w: n.width ?? STEP_W, h: n.height ?? STEP_H };
    if (n.id === DROPPED_NODE) extra.push(box, { x: box.x - DROPPED_ARROW, y: box.y, w: DROPPED_ARROW, h: box.h });
    else boxes.set(n.id, box);
  }
  return { boxes, extra };
}

/** How far left of Dropped its dashed "from any Step" arrow reaches (nodes.tsx draws it). */
export const DROPPED_ARROW = 132;

/** Every Connector's route round the nodes where they stand. */
export function routesOf(workflow: Workflow, nodes: CanvasNode[]): Map<string, Route> {
  const { boxes, extra } = boxesOf(nodes);
  return routeConnectors(
    boxes,
    workflow.connectors.map((c) => ({ id: c.id, from: c.from, to: c.to ?? DONE_NODE, label: c.name, order: c.position, terminal: c.to === null })),
    extra,
  );
}

/** The Connectors as edges, each drawn along its route and named by its outcome. */
export function toEdges(workflow: Workflow, mode: Mode, routes: Map<string, Route>): ConnectorFlowEdge[] {
  const edit = mode === "edit";
  const at = new Map(workflow.steps.map((s) => [s.id, s]));
  return [...workflow.connectors]
    .sort((a, b) => (at.get(a.from)?.position ?? 0) - (at.get(b.from)?.position ?? 0) || a.position - b.position)
    .flatMap((c) => {
      const from = at.get(c.from);
      const route = routes.get(c.id);
      if (!from || !route || (c.to !== null && !at.has(c.to))) return [];
      return [
        {
          id: c.id,
          type: "connector" as const,
          source: c.from,
          target: c.to ?? DONE_NODE,
          sourceHandle: exitHandles[route.exit],
          targetHandle: entryHandles[route.entry],
          data: { connector: c, route },
          selectable: edit,
          reconnectable: edit,
          focusable: false,
          deletable: false,
          ariaLabel: `${from.name} to ${targetName(workflow, c.to)}: ${c.name}`,
        },
      ];
    });
}

/** A drawn connection's ends as a Connector's: Done is `to: null`. */
export function endsOf(connection: { source: string; target: string }): Ends {
  return {
    from: connection.source,
    to: connection.target === DONE_NODE ? null : connection.target === DROPPED_NODE ? "dropped" : connection.target,
  };
}
