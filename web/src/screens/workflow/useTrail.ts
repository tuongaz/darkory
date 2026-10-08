import { useMemo, useState } from "react";
import type { Activity, Project } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { useActivity } from "@/api/queries";
import { flowKinds, trailLine, type FlowContext, type TrailLine } from "./flowEvents";

/** The entries the trail opens on: the Project's latest moves. */
export const seeded = 30;
/** The most lines the trail keeps. */
const kept = 200;

/** What a hovered (or clicked) row lights on the canvas: its Steps and its Task's chip. */
export type TrailFocus = { steps: string[]; taskId?: string };

/**
 * The Project's trail beside the live canvas: its Tasks' moves through the Workflow, newest first,
 * opened on the latest ones and joined on top by each that arrives over the stream (highlighted a
 * moment). `fresh` are the lines that arrived while the page was open.
 */
export function useTrail(project: Project, ctx: FlowContext): { lines: TrailLine[]; fresh: Set<number>; loading: boolean } {
  const history = useActivity({ project: project.key, kind: [...flowKinds], limit: seeded });
  const live = useLiveEntries();
  const [opened] = useState(() => live[0]?.seq ?? 0);
  return useMemo(() => {
    const bySeq = new Map<number, Activity>();
    for (const e of history.data?.items ?? []) bySeq.set(e.seq, e);
    for (const e of live) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
    const lines = [...bySeq.values()]
      .sort((a, b) => b.seq - a.seq)
      .map((e) => trailLine(e, ctx))
      .filter((l): l is TrailLine => !!l)
      .slice(0, kept);
    const fresh = new Set(lines.filter((l) => l.seq > opened && live.some((e) => e.seq === l.seq)).map((l) => l.seq));
    return { lines, fresh, loading: history.isPending };
  }, [history.data, history.isPending, live, ctx, opened]);
}

