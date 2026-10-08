import { ViewportPortal } from "@xyflow/react";
import { MemberAvatar } from "@/components/MemberAvatar";
import { SystemMark } from "@/components/Timeline";
import { tokenPath, type CanvasNode } from "./flow";
import { STEP_W } from "./layout";
import type { LiveCanvas } from "./live";
import type { Route } from "./route";

/**
 * Over the live canvas, in its coordinates: each Step's callouts stacked above it, newest on top,
 * each with the Member's mark (Darkory's when it acted) and fading after a few seconds; and the
 * tokens, each a Task's key in a pill travelling its Connector's drawn line. Nothing here takes a
 * pointer: the canvas under it does.
 */
export function LiveLayer({ live, nodes, routes }: { live: LiveCanvas; nodes: CanvasNode[]; routes: Map<string, Route> }) {
  return (
    <ViewportPortal>
      <div className="pointer-events-none" aria-hidden>
        {[...live.callouts].map(([stepId, callouts]) => {
          const node = nodes.find((n) => n.id === stepId);
          if (!node || callouts.length === 0) return null;
          return (
            <div
              key={stepId}
              className="absolute top-0 left-0 flex flex-col items-start gap-1"
              // Placed above its Step: a CSSOM write, which the CSP allows.
              style={{ width: STEP_W, transform: `translate(${node.position.x}px, ${node.position.y - 6}px) translateY(-100%)` }}
            >
              {callouts.map((c) => (
                <span
                  key={c.id}
                  data-tone={c.tone}
                  className="flow-callout flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border bg-popover pr-2.5 pl-0.5 text-xs whitespace-nowrap text-popover-foreground shadow-pop"
                >
                  {c.who ? <MemberAvatar member={c.who} className="size-5" /> : <SystemMark />}
                  <span className="min-w-0 truncate font-medium">{c.text}</span>
                </span>
              ))}
            </div>
          );
        })}
        {live.tokens.map((t) => {
          const d = tokenPath(t, nodes, routes);
          if (!d) return null;
          return (
            <span
              key={t.id}
              data-token={t.key}
              className="flow-token absolute top-0 left-0 rounded-full border bg-foreground px-1.5 text-2xs leading-[16px] font-semibold whitespace-nowrap text-background tabular-nums shadow-pop"
              // Its way along the drawn line: a CSSOM write, which the CSP allows.
              style={{ offsetPath: `path("${d}")` }}
            >
              {t.key}
            </span>
          );
        })}
      </div>
    </ViewportPortal>
  );
}
