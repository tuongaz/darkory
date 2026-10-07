import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { cn } from "@/lib/utils";
import { useCanvas } from "./context";
import type { ConnectorFlowEdge } from "./flow";
import { roundedPath } from "./route";

/**
 * A Connector, drawn along its route (route.ts): right angles with rounded corners, round the
 * nodes, its outcome's name just past where it leaves its step. Editing, the name selects it as
 * its line does, and its ends can be dragged to other steps.
 */
export function ConnectorEdge({ id, data, selected, markerEnd }: EdgeProps<ConnectorFlowEdge>) {
  const { mode, onSelectConnector } = useCanvas();
  if (!data) return null;
  const { route, connector } = data;
  const edit = mode === "edit";
  const shift = route.label.align === "left" ? "0%" : "-100%";
  return (
    <>
      <BaseEdge id={id} path={roundedPath(route.points, 8)} markerEnd={markerEnd} interactionWidth={edit ? 16 : 0} />
      <EdgeLabelRenderer>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => onSelectConnector?.(id)}
          disabled={!edit}
          // Placed by its route: a CSSOM write, which the CSP allows.
          style={{ transform: `translate(${shift}, -50%) translate(${route.label.x}px, ${route.label.y}px)` }}
          className={cn(
            "nodrag nopan absolute top-0 left-0 rounded-full border bg-background px-1.5 text-2xs leading-[16px] whitespace-nowrap text-muted-foreground",
            edit ? "pointer-events-auto cursor-pointer hover:text-foreground" : "pointer-events-none",
            selected && "border-foreground text-foreground",
          )}
        >
          {connector.name}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
