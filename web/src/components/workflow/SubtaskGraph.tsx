import { BaseEdge, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { createContext, useContext, useId, useMemo } from "react";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { WorkGlyph } from "@/components/WorkGlyph";
import { cn } from "@/lib/utils";
import { glyphLabel, workingOf } from "@/lib/work";
import { HEADER_H, layoutSubtasks, NODE_H, NODE_W, PAD, type GraphColumn, type GraphNode, type GraphStep, type GraphSubtask } from "./graph";
import type { Point } from "./model";
import { roundedPath } from "./route";

type SubtaskFlowNode = Node<{ node: GraphNode }, "subtask">;
type BlockingFlowEdge = Edge<{ points: Point[] }, "blocking">;

const OpenContext = createContext<(id: string) => void>(() => {});

const kindNames = { breakdown: "Break down", acceptance: "Acceptance", retrospective: "Retrospective" } as const;

/** A Subtask in words, for its button's `aria-label`. */
function subtaskLabel(n: GraphNode): string {
  const s = n.subtask;
  const parts = [`${s.key} ${s.title}`, glyphLabel(n.glyph)];
  if (s.holder) parts.push(`held by ${s.holder.name}`);
  else if (s.aimedAt && s.state === "open") parts.push(`aimed at ${s.aimedAt.name}`);
  if (n.takeable) parts.push("takeable now");
  return parts.join(", ");
}

/**
 * A Subtask: its glyph (or, while someone holds it, their mark, which says how they work), key,
 * kind when Darkory filed it, and title. Takeable now, it is drawn in the waiting blue and says
 * so; worked, as it is; otherwise dimmed.
 */
function SubtaskNode({ data: { node } }: NodeProps<SubtaskFlowNode>) {
  const open = useContext(OpenContext);
  const s = node.subtask;
  const worked = !!s.holder && s.state === "open";
  const kind = s.kind === "work" ? undefined : kindNames[s.kind];
  return (
    <button
      type="button"
      aria-label={subtaskLabel(node)}
      data-takeable={node.takeable || undefined}
      onClick={() => open(s.id)}
      className={cn(
        "flex size-full cursor-pointer flex-col justify-center gap-1 rounded-lg border bg-card px-2.5 text-left text-card-foreground shadow-soft transition-opacity hover:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        node.takeable && "border-state-waiting/60 bg-state-waiting-bg/50",
        !node.takeable && !worked && "opacity-60 hover:opacity-100 focus-visible:opacity-100",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {worked ? (
          <MemberAvatar member={s.holder!} working={s.working ?? workingOf(s.holder!.kind)} className="-my-0.5" />
        ) : (
          <span aria-hidden className="flex">
            <WorkGlyph glyph={node.glyph} />
          </span>
        )}
        <span className="font-mono text-xs text-muted-foreground">{s.key}</span>
        <span className="ml-auto flex min-w-0 gap-1">
          {kind && <Pill className="h-4 px-1.5 text-2xs">{kind}</Pill>}
          {node.takeable && (
            <Pill tone="waiting" className="h-4 px-1.5 text-2xs">
              Takeable
            </Pill>
          )}
        </span>
      </span>
      <span className={cn("truncate", s.state === "open" && "font-medium")}>{s.title}</span>
      {/* Where a Blocking's arrow is fastened; the arrow itself is drawn from the layout's points. */}
      <Handle type="source" position={Position.Right} isConnectable={false} className="canvas-handle-hidden" />
      <Handle type="target" position={Position.Left} isConnectable={false} className="canvas-handle-hidden" />
    </button>
  );
}

function BlockingEdge({ id, data, markerEnd }: EdgeProps<BlockingFlowEdge>) {
  return <BaseEdge id={id} path={roundedPath(data?.points ?? [])} markerEnd={markerEnd} />;
}

const nodeTypes = { subtask: SubtaskNode };
const edgeTypes = { blocking: BlockingEdge };
const handles = [
  { type: "source" as const, position: Position.Right, x: NODE_W - 1, y: NODE_H / 2, width: 1, height: 1 },
  { type: "target" as const, position: Position.Left, x: 0, y: NODE_H / 2, width: 1, height: 1 },
];

function ColumnHead({ column }: { column: GraphColumn }) {
  return (
    <div
      className="absolute top-0 flex items-center gap-1.5 px-1 text-xs"
      // Placed by the layout: a CSSOM write, which the CSP allows.
      style={{ left: column.x, width: column.width, height: HEADER_H }}
    >
      {column.member && <MemberAvatar member={column.member} />}
      <span className="truncate font-medium">{column.title}</span>
      {column.kind === "step" && <span className="truncate text-muted-foreground">{column.skill ?? "hold"}</span>}
    </div>
  );
}

/**
 * A Parent's Subtasks over its Project's Workflow (Task page, Subtasks › Graph): each in its
 * step's column (`layoutSubtasks` says where), Blocking arrows from blocker to blocked, the ones
 * someone can take now highlighted and the rest dimmed. Read-only: a click opens the Subtask.
 * Drawn at full size; wider than its box, it scrolls sideways inside it.
 */
export function SubtaskGraph({
  steps,
  subtasks,
  onOpen,
  className,
}: {
  /** The Project's steps, in the Workflow's order. */
  steps: GraphStep[];
  subtasks: GraphSubtask[];
  onOpen: (id: string) => void;
  className?: string;
}) {
  const id = useId();
  const layout = useMemo(() => layoutSubtasks(steps, subtasks), [steps, subtasks]);
  const keys = useMemo(() => new Map(subtasks.map((s) => [s.id, s.key])), [subtasks]);
  // Tab walks them column by column, top to bottom, as they read.
  const nodes: SubtaskFlowNode[] = [...layout.nodes].sort((a, b) => a.x - b.x || a.y - b.y).map((n) => ({
    id: n.subtask.id,
    type: "subtask",
    position: { x: n.x, y: n.y },
    data: { node: n },
    width: NODE_W,
    height: NODE_H,
    handles,
    // React Flow gives a node no one selects or drags no pointer; this one is clicked.
    style: { pointerEvents: "all" },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    deletable: false,
  }));
  const edges: BlockingFlowEdge[] = layout.edges.map((e) => ({
    id: e.id,
    type: "blocking",
    source: e.from,
    target: e.to,
    data: { points: e.points },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--xy-edge-stroke)" },
    selectable: false,
    focusable: false,
    deletable: false,
    ariaLabel: `${keys.get(e.from)} blocks ${keys.get(e.to)}`,
  }));

  if (subtasks.length === 0) return null;
  return (
    <div role="region" aria-label="Subtasks, graph" className={cn("subtask-graph overflow-x-auto overscroll-x-contain", className)}>
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        {layout.columns.map((c) => (
          <div
            key={c.id}
            aria-hidden
            className="absolute rounded-lg bg-muted/50"
            style={{ left: c.x - 8, top: 0, width: c.width + 16, height: layout.height - PAD + 8 }}
          />
        ))}
        {layout.columns.map((c) => (
          <ColumnHead key={c.id} column={c} />
        ))}
        <OpenContext.Provider value={onOpen}>
          <ReactFlowProvider>
            <ReactFlow<SubtaskFlowNode, BlockingFlowEdge>
              id={`subtasks${id}`}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              minZoom={1}
              maxZoom={1}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              panOnDrag={false}
              panOnScroll={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
              preventScrolling={false}
              autoPanOnNodeFocus={false}
            />
          </ReactFlowProvider>
        </OpenContext.Provider>
      </div>
    </div>
  );
}
