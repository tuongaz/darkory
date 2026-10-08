import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from "@xyflow/react";
import { MaximizeIcon, MinusIcon, PlusIcon, WandSparklesIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ConnectorEdge } from "./ConnectorEdge";
import { CanvasContext, type CanvasActions } from "./context";
import { endsOf, routesOf, toEdges, toNodes, type CanvasNode, type ConnectorFlowEdge, type Mode } from "./flow";
import { STEP_H, tidy } from "./layout";
import type { LiveCanvas } from "./live";
import { LiveLayer } from "./LiveLayer";
import { connectProblem, type Connector, type Point, type Step, type Workflow } from "./model";
import { StepNode, TerminalNode } from "./nodes";
import { ConnectorPanel, Problem, StepPanel } from "./StepPanel";

const nodeTypes = { step: StepNode, terminal: TerminalNode };
const edgeTypes = { connector: ConnectorEdge };
// The arrowhead's colour is written on the marker, so it is the edges' token, not React Flow's grey.
const edgeDefaults = { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--xy-edge-stroke)" } };
const fit = { padding: 0.12, maxZoom: 1, minZoom: 0.5 };

/** A Connector's ends once checked: into a Step or Done. */
export type ConnectorEnds = { from: string; to: string | null };

/** What is selected on an editing canvas: a Step, a Connector, or nothing (null). */
export type CanvasSelection = { kind: "step" | "connector"; id: string } | null;

export type WorkflowCanvasProps = {
  workflow: Workflow;
  /**
   * `live` (Project › Workflow): read-only, with each Step's counts and its takers' rings.
   * `edit` (Settings › Workflow): steps are dragged, selected, connected and added.
   */
  mode: Mode;
  /** A Step was selected, or nothing (or a Connector) is. */
  onSelect?: (step: Step | null) => void;
  /**
   * Editing, the selection when the page holds it (its own side panel, a selection that follows
   * a new step), told of every change through `onSelectionChange`. Given, the canvas draws no
   * panel of its own.
   */
  selection?: CanvasSelection;
  onSelectionChange?: (selection: CanvasSelection) => void;
  /** Live, a Step was clicked, or Enter or Space pressed on it: open what it holds. */
  onOpenStep?: (step: Step) => void;
  /**
   * Live, what is happening as it happens (live.ts): callouts above the Steps, chips pulsing,
   * tokens travelling the Connectors; and where a chip leads.
   */
  live?: LiveCanvas;
  /** A Step was dropped where it now stands (a drag ended, or an arrow key moved it). */
  onMove?: (step: Step, x: number, y: number) => void;
  /** "+" on a Step, or a connection dropped on empty canvas: a new step after `from`, at `at` if dropped. */
  onAddStep?: (from: string, at?: Point) => void;
  /** A connection drawn from a Step into another Step or Done: a new Connector, to be named. */
  onAddConnector?: (ends: ConnectorEnds) => void;
  /** A Connector's end dragged onto another Step or Done. */
  onConnectorChange?: (connector: Connector, ends: ConnectorEnds) => void;
  /** Delete in the panel; `moveTo` is the Step its Tasks go to, when it has Tasks. */
  onDeleteStep?: (step: Step, moveTo?: string) => void;
  onDeleteConnector?: (connector: Connector) => void;
  /** Tidy up: every Step's new place. */
  onLayout?: (positions: Record<string, Point>) => void;
  className?: string;
};

type Selection = CanvasSelection;

/**
 * A Project's Workflow on a canvas (`@xyflow/react`): its Steps, the Connectors between them
 * named by outcome, and Done and Dropped fixed right of them. The parent holds the record: every
 * edit is a callback, and the canvas draws whatever Workflow it is given next. What `/v1` would
 * refuse (a Connector into Dropped or back into its own step, a Step deleted with its Tasks
 * nowhere to go) is said in words and not sent.
 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({
  workflow,
  mode,
  onSelect,
  selection,
  onSelectionChange,
  onOpenStep,
  live,
  onMove,
  onAddStep,
  onAddConnector,
  onConnectorChange,
  onDeleteStep,
  onDeleteConnector,
  onLayout,
  className,
}: WorkflowCanvasProps) {
  const edit = mode === "edit";
  const flow = useReactFlow<CanvasNode, ConnectorFlowEdge>();
  // Its own id, so two canvases on a page do not share their arrowheads' and descriptions' ids.
  const id = useId();
  // The whole Workflow in view; when it fits only below half size (a phone), half size from its
  // top-left, where it starts, and the rest pans.
  const frame = async () => {
    await flow.fitView(fit);
    if (flow.getZoom() > fit.minZoom + 0.001) return;
    const b = flow.getNodesBounds(flow.getNodes());
    // Editing, below Tidy up.
    const top = edit ? 56 : 24;
    await flow.setViewport({ x: 24 - b.x * fit.minZoom, y: top - b.y * fit.minZoom, zoom: fit.minZoom });
  };
  const [problem, setProblem] = useState<string | undefined>();
  const [own, setOwn] = useState<Selection>(null);
  const held = selection !== undefined;
  const selected = held ? selection : own;
  const current = useRef<Selection>(selected);
  useEffect(() => {
    if (held) current.current = selection;
  }, [held, selection]);

  // The nodes as React Flow moves and measures them; drawn afresh from each new Workflow given.
  const [nodes, setNodes] = useState(() => toNodes(workflow, mode));
  const [drawn, setDrawn] = useState({ workflow, mode });
  if (drawn.workflow !== workflow || drawn.mode !== mode) {
    setDrawn({ workflow, mode });
    setNodes((prev) => toNodes(workflow, mode).map((n) => ({ ...n, measured: prev.find((p) => p.id === n.id)?.measured })));
  }

  const isSelected = (kind: "step" | "connector", id: string) => selected?.kind === kind && selected.id === id;
  const shownNodes = useMemo(
    () => nodes.map((n) => (n.type === "step" && !!n.selected !== isSelected("step", n.id) ? { ...n, selected: !n.selected } : n)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isSelected reads `selected`
    [nodes, selected],
  );
  // Routed round the nodes where they stand, so the lines follow a Step while it is dragged.
  const routes = useMemo(() => routesOf(workflow, nodes), [workflow, nodes]);
  const edges = useMemo(
    () => toEdges(workflow, mode, routes).map((e) => (isSelected("connector", e.id) ? { ...e, selected: true } : e)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isSelected reads `selected`
    [workflow, mode, routes, selected],
  );

  const choose = (next: Selection) => {
    const prev = current.current;
    if (prev?.kind === next?.kind && prev?.id === next?.id) return;
    current.current = next;
    if (!held) setOwn(next);
    onSelectionChange?.(next);
    setProblem(undefined);
    const was = prev?.kind === "step" ? prev.id : null;
    const is = next?.kind === "step" ? next.id : null;
    if (was !== is) onSelect?.(is ? (workflow.steps.find((s) => s.id === is) ?? null) : null);
  };
  // React Flow's select and deselect changes, for a click, Enter on a focused node, or the pane.
  const follow = (kind: "step" | "connector", changes: (NodeChange<CanvasNode> | EdgeChange<ConnectorFlowEdge>)[]) => {
    let next = current.current;
    for (const c of changes) {
      if (c.type !== "select") continue;
      if (c.selected) next = { kind, id: c.id };
      else if (next?.kind === kind && next.id === c.id) next = null;
    }
    choose(next);
  };

  const onNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    follow("step", changes);
    for (const c of changes) {
      if (c.type !== "position" || c.dragging !== false || !c.position) continue;
      const step = workflow.steps.find((s) => s.id === c.id);
      if (step) onMove?.(step, Math.round(c.position.x), Math.round(c.position.y));
    }
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "select"), ns));
  };

  const check = (connection: Connection): ConnectorEnds | undefined => {
    const ends = endsOf(connection);
    const p = connectProblem(workflow, ends);
    setProblem(p);
    return p || ends.to === "dropped" ? undefined : { from: ends.from, to: ends.to };
  };
  const onConnect = (connection: Connection) => {
    const ends = check(connection);
    if (ends) onAddConnector?.(ends);
  };
  const onReconnect = (old: ConnectorFlowEdge, connection: Connection) => {
    const connector = workflow.connectors.find((c) => c.id === old.id);
    const ends = check(connection);
    if (connector && ends && (ends.from !== connector.from || ends.to !== connector.to)) onConnectorChange?.(connector, ends);
  };
  // A connection let go over empty canvas: a new step there, after the one it was drawn from.
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || state.toNode || !state.fromNode || state.fromHandle?.type !== "source" || !onAddStep) return;
    if (!workflow.steps.some((s) => s.id === state.fromNode!.id)) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const at = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
    onAddStep(state.fromNode.id, { x: Math.round(at.x), y: Math.round(at.y - STEP_H / 2) });
  };

  const openStep = (id: string) => {
    const step = workflow.steps.find((s) => s.id === id);
    if (step && !edit) onOpenStep?.(step);
  };
  const actions = useMemo<CanvasActions>(
    () => ({
      mode,
      onAdd: onAddStep,
      onSelectConnector: (id) => choose({ kind: "connector", id }),
      opens: !edit && !!onOpenStep,
      onOpenStep: openStep,
      live: edit ? undefined : live,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- choose reads the current selection through a ref
    [mode, onAddStep, workflow, onOpenStep, live],
  );

  // Live, a focused step opens on Enter or Space as a click opens it (React Flow selects on
  // those, and nothing is selectable live). A chip in it is a button of its own.
  const onKeyDown = (e: KeyboardEvent) => {
    if (edit || !onOpenStep || (e.key !== "Enter" && e.key !== " ")) return;
    if (!(e.target as HTMLElement).classList.contains("react-flow__node")) return;
    const id = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node")?.dataset.id;
    if (!id) return;
    e.preventDefault();
    openStep(id);
  };

  const selectedStep = selected?.kind === "step" ? workflow.steps.find((s) => s.id === selected.id) : undefined;
  const selectedConnector = selected?.kind === "connector" ? workflow.connectors.find((c) => c.id === selected.id) : undefined;

  return (
    <CanvasContext.Provider value={actions}>
      <div role="region" aria-label={edit ? "Workflow, editing" : "Workflow"} data-mode={mode} className={cn("workflow-canvas relative min-h-0", className)} onKeyDown={onKeyDown}>
        <ReactFlow<CanvasNode, ConnectorFlowEdge>
          id={`workflow${id}`}
          nodes={shownNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={edgeDefaults}
          onNodesChange={onNodesChange}
          onEdgesChange={(changes) => follow("connector", changes)}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onConnectEnd={onConnectEnd}
          onNodeClick={(_, node) => openStep(node.id)}
          nodesDraggable={edit}
          nodesConnectable={edit}
          elementsSelectable={edit}
          edgesReconnectable={edit}
          nodesFocusable
          edgesFocusable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          connectionRadius={32}
          onInit={() => void frame()}
          minZoom={0.2}
          maxZoom={1.5}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          {!edit && live && <LiveLayer live={live} nodes={nodes} routes={routes} />}
          <Panel position="top-left" className="flex gap-1.5">
            {edit && onLayout && (
              <Button variant="outline" size="xs" onClick={() => onLayout(tidy(workflow))}>
                <WandSparklesIcon />
                Tidy up
              </Button>
            )}
          </Panel>
          <Panel position="bottom-left" className="flex flex-col overflow-hidden rounded-md border bg-background shadow-soft">
            <Button variant="ghost" size="icon-xs" className="rounded-none" aria-label="Zoom in" onClick={() => flow.zoomIn()}>
              <PlusIcon />
            </Button>
            <Button variant="ghost" size="icon-xs" className="rounded-none border-t" aria-label="Zoom out" onClick={() => flow.zoomOut()}>
              <MinusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-none border-t"
              aria-label="Fit the Workflow"
              onClick={() => void frame()}
            >
              <MaximizeIcon />
            </Button>
          </Panel>
          {edit && !held && (selectedStep || selectedConnector) && (
            <Panel position="top-right">
              {selectedStep ? (
                <StepPanel
                  key={selectedStep.id}
                  workflow={workflow}
                  step={selectedStep}
                  onClose={() => choose(null)}
                  onDeleteStep={onDeleteStep}
                  onDeleteConnector={onDeleteConnector}
                />
              ) : (
                <ConnectorPanel workflow={workflow} connector={selectedConnector!} onClose={() => choose(null)} onDeleteConnector={onDeleteConnector} />
              )}
            </Panel>
          )}
          {problem && (
            <Panel position="bottom-center" className="max-w-[calc(100%-120px)] rounded-md border border-danger-border bg-background px-3 py-2 shadow-soft">
              <Problem>{problem}</Problem>
            </Panel>
          )}
        </ReactFlow>
      </div>
    </CanvasContext.Provider>
  );
}
