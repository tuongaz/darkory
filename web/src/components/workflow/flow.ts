import { Position, type Edge, type Node, type NodeHandle } from "@xyflow/react";
import { settle, STEP_H, STEP_W, stepHeight, TERMINAL_H, TERMINAL_W, terminals, type StepBox } from "./layout";
import { deadEnd, stepsInOrder, targetName, unstaffed, waitingAt, type Connector, type Ends, type Step, type Workflow } from "./model";
import { DONE, DROPPED, type Token } from "./live";
import { roundedPath, routeConnectors, type Rect, type Route } from "./route";

/** The terminal nodes' ids; a Step's id is a UUID, so these never meet one. */
export const DONE_NODE = "@done";
export const DROPPED_NODE = "@dropped";

export type Mode = "live" | "edit";

export type StepFlowNode = Node<{ step: Step; deadEnd: boolean }, "step">;
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
const stepHandles = (h: number) => [
  handle("in", "target", Position.Left, 0, h / 2),
  handle("out", "source", Position.Right, STEP_W, h / 2),
  handle("out-left", "source", Position.Left, 0, h / 2),
  handle("in-right", "target", Position.Right, STEP_W, h / 2),
  handle("in-bottom", "target", Position.Bottom, STEP_W / 2, h),
  handle("in-top", "target", Position.Top, STEP_W / 2, 0),
];
const exitHandles = { right: "out", left: "out-left" } as const;
const entryHandles = { left: "in", right: "in-right", bottom: "in-bottom", top: "in-top" } as const;

/** A Step in words, for its node's `aria-label`; `noWayOut` when it has a Skill and no Connector out. */
export function stepLabel(step: Step, noWayOut = false): string {
  const what = step.skill ? `Skill ${step.skill.name}` : "a hold, moved on by hand";
  const counts = `${waitingAt(step)} waiting, ${step.working} working`;
  const who = unstaffed(step)
    ? `no Member has ${step.skill!.name}`
    : step.takers.length > 0
      ? `taken by ${step.takers.map((t) => (t.kind === "agent" ? `${t.name} (agent)` : t.name)).join(", ")}`
      : "";
  return [`${step.name}: ${what}`, counts, who, noWayOut && "no way out: its Tasks can only be moved by hand"].filter(Boolean).join("; ");
}

/**
 * Where each Step is drawn. Editing, where the record has it, the size Tidy up lays out; live, as
 * tall as its Tasks' chips need, moved down by the Steps above it that grew (layout.ts `settle`).
 */
export function stepBoxes(workflow: Workflow, mode: Mode): Map<string, StepBox> {
  if (mode === "edit") return new Map(workflow.steps.map((s) => [s.id, { x: s.x, y: s.y, h: STEP_H }]));
  return settle(workflow.steps.map((s) => ({ id: s.id, x: s.x, y: s.y, h: stepHeight(s.chips?.length ?? 0) })));
}

/**
 * The canvas's nodes: the Steps in the Workflow's order (the order Tab walks them in), then Done
 * and Dropped, fixed right of them. Editing, a Step can be dragged, selected and connected.
 */
export function toNodes(workflow: Workflow, mode: Mode): CanvasNode[] {
  const edit = mode === "edit";
  const boxes = stepBoxes(workflow, mode);
  const { done, dropped } = terminals(workflow, boxes);
  const steps: StepFlowNode[] = stepsInOrder(workflow).map((step) => ({
    id: step.id,
    type: "step",
    position: { x: boxes.get(step.id)!.x, y: boxes.get(step.id)!.y },
    data: { step, deadEnd: deadEnd(workflow, step) },
    width: STEP_W,
    height: boxes.get(step.id)!.h,
    handles: stepHandles(boxes.get(step.id)!.h),
    // Live, React Flow would give a node no one selects or drags no pointer; its titles (the
    // median, "+N") need one.
    style: { pointerEvents: "all" },
    draggable: edit,
    connectable: edit,
    selectable: edit,
    deletable: false,
    ariaLabel: stepLabel(step, deadEnd(workflow, step)),
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

/** The node a token travels into: a Step's, Done's or Dropped's. */
const nodeOf = (to: string) => (to === DONE ? DONE_NODE : to === DROPPED ? DROPPED_NODE : to);

/**
 * The way a token travels: the Connector's route when it went along one, as drawn; otherwise
 * (moved by hand, dropped) a route of its own round the nodes, as a Connector there would run.
 */
export function tokenPath(token: Token, nodes: CanvasNode[], routes: Map<string, Route>): string | undefined {
  const along = token.travel.connectorId ? routes.get(token.travel.connectorId) : undefined;
  if (along) return roundedPath(along.points, 8);
  const { boxes, extra } = boxesOf(nodes);
  const dropped = nodes.find((n) => n.id === DROPPED_NODE);
  const all = new Map<string, Rect>(boxes);
  if (dropped) all.set(DROPPED_NODE, { x: dropped.position.x, y: dropped.position.y, w: dropped.width ?? 0, h: dropped.height ?? 0 });
  const to = nodeOf(token.travel.to);
  const terminal = to === DONE_NODE || to === DROPPED_NODE;
  // Into Dropped the dashed arrow is no obstacle: the token runs in beside it.
  const obstacles = to === DROPPED_NODE ? [] : extra;
  const route = routeConnectors(all, [{ id: "token", from: token.travel.from, to, label: "", order: 0, terminal }], obstacles).get("token");
  return route ? roundedPath(route.points, 8) : undefined;
}
