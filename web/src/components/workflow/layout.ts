import dagre from "@dagrejs/dagre";
import type { Point, Workflow } from "./model";

/** A Step node's size on the canvas: Tidy up lays these out, so the node is drawn this size. */
export const STEP_W = 208;
export const STEP_H = 88;
/** Done and Dropped. */
export const TERMINAL_W = 120;
export const TERMINAL_H = 40;
/** Between ranks, edge to edge: room for a Connector's name. */
export const RANK_GAP = 240;
/** Between steps stacked in one rank. */
export const ROW_GAP = 40;

const DONE = "\u0000done";
const START = "\u0000start";

/**
 * Tidy up: the Steps laid out left to right by dagre, 240px between ranks, each as far left as
 * its Connectors allow, so a Workflow reads from where its Tasks start. A Connector into an
 * earlier Step of the Workflow's order ("needs changes", "fail") is laid out as if it pointed
 * forward, so it runs back under the nodes rather than turning the Workflow round. Done takes
 * part, so the Steps that lead into it sit before it, but it is not returned: the canvas places
 * Done and Dropped itself. Positions are whole pixels from (0, 0).
 */
export function tidy(workflow: Workflow): Record<string, Point> {
  const steps = [...workflow.steps].sort((a, b) => a.position - b.position);
  const order = new Map(steps.map((s, i) => [s.id, i]));
  const g = new dagre.graphlib.Graph({ multigraph: true });
  // One of Brandes-Köpf's alignments rather than their average, which leaves a chain of steps a
  // few pixels off level and its Connectors jogging.
  g.setGraph({ rankdir: "LR", ranksep: RANK_GAP, nodesep: ROW_GAP, marginx: 0, marginy: 0, align: "UL" });
  g.setDefaultEdgeLabel(() => ({}));
  // A start every Step hangs from, pulling harder than a Connector does, so a Step with nothing
  // leading into it (Plan, Retro) stands in the first rank instead of beside Done. In the
  // Workflow's order, which dagre's ordering starts from.
  g.setNode(START, { width: 1, height: 1 });
  for (const s of steps) {
    g.setNode(s.id, { width: STEP_W, height: STEP_H });
    g.setEdge(START, s.id, { weight: 4 }, `start:${s.id}`);
  }
  if (workflow.connectors.some((c) => c.to === null)) g.setNode(DONE, { width: TERMINAL_W, height: TERMINAL_H });
  for (const c of workflow.connectors) {
    if (!order.has(c.from) || (c.to !== null && !order.has(c.to))) continue;
    const back = c.to !== null && order.get(c.to)! < order.get(c.from)!;
    if (back) g.setEdge(c.to!, c.from, { weight: 1 }, c.id);
    else g.setEdge(c.from, c.to ?? DONE, { weight: 1 }, c.id);
  }
  dagre.layout(g);

  const placed = steps.map((s) => ({ id: s.id, ...g.node(s.id) }));
  const left = Math.min(...placed.map((n) => n.x - STEP_W / 2));
  const top = Math.min(...placed.map((n) => n.y - STEP_H / 2));
  return Object.fromEntries(placed.map((n) => [n.id, { x: Math.round(n.x - STEP_W / 2 - left), y: Math.round(n.y - STEP_H / 2 - top) }]));
}

/**
 * Where Done and Dropped stand: one rank right of the rightmost Step. Done is level with the
 * steps that lead into it (the middle of them all when none does); Dropped is under it, no
 * higher than the lowest step, so its dashed arrow from any Step has room.
 */
export function terminals(workflow: Workflow): { done: Point; dropped: Point } {
  const steps = workflow.steps;
  if (steps.length === 0) return { done: { x: 0, y: 0 }, dropped: { x: 0, y: TERMINAL_H + 56 } };
  const x = Math.max(...steps.map((s) => s.x)) + STEP_W + RANK_GAP;
  const middle = (s: { y: number }) => s.y + STEP_H / 2;
  const feeding = steps.filter((s) => workflow.connectors.some((c) => c.from === s.id && c.to === null));
  const level = feeding.length > 0 ? feeding : steps;
  const doneY = Math.round(level.reduce((sum, s) => sum + middle(s), 0) / level.length - TERMINAL_H / 2);
  const lowest = Math.max(...steps.map(middle)) - TERMINAL_H / 2;
  return { done: { x, y: doneY }, dropped: { x, y: Math.round(Math.max(doneY + TERMINAL_H + 56, lowest)) } };
}
