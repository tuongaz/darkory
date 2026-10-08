import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, call, type Schemas } from "@/api/client";

// The Member's "seen" mark of a Project's Activity: `GET` and `PUT /v1/projects/{project}/seen`.

/** How far the Member has seen a Project's Activity: both null until they first looked. */
export type Seen = Schemas["ProjectSeen"];

const never: Seen = { seq: null, at: null };

export const seenKey = (project: string) => ["seen", project] as const;

/** The mark, or none when it cannot be read (the caller is not in the Project). */
export async function readSeen(project: string): Promise<Seen> {
  try {
    return await call(api.GET("/v1/projects/{project}/seen", { params: { path: { project } } }));
  } catch {
    return never;
  }
}

/**
 * Moves the mark forward to `seq`; the server keeps the higher of the two. `keepalive` lets the
 * write outlive a page being left. A refusal changes nothing the Member sees: the mark stays.
 */
export function writeSeen(project: string, seq: number): Promise<unknown> {
  return call(api.PUT("/v1/projects/{project}/seen", { params: { path: { project } }, body: { seq }, keepalive: true })).catch(() => undefined);
}

/** The Member's mark of `project` as it stood when they came to the page (or last came back to it). */
export function useSeen(project: string): Seen | undefined {
  return useQuery({ queryKey: seenKey(project), queryFn: () => readSeen(project), staleTime: Infinity }).data;
}

// The mark each Project's panel will write as it goes, unless another mounts for it at once.
const leaving = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Makes the newest entry shown to the Member (`newest`) their mark when they leave the page or it
 * is hidden. Coming back to a hidden page reads the mark again, so the divider moves to where they
 * last looked. One caller per page: What's happening.
 */
export function useMarkSeenOnLeave(project: string, newest: number | undefined) {
  const qc = useQueryClient();
  const seen = useSeen(project);
  const latest = useRef(newest);
  const kept = useRef<number | null>(null);
  useEffect(() => {
    latest.current = newest;
  }, [newest]);
  useEffect(() => {
    kept.current = Math.max(kept.current ?? 0, seen?.seq ?? 0) || null;
  }, [seen]);
  useEffect(() => {
    const mark = () => {
      const seq = latest.current;
      if (seq === undefined || (kept.current !== null && seq <= kept.current)) return;
      kept.current = seq;
      void writeSeen(project, seq);
      // The page shown next reads the mark as it now stands, before the server answers.
      qc.setQueryData<Seen>(seenKey(project), { seq, at: new Date().toISOString() });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") mark();
      else void qc.invalidateQueries({ queryKey: seenKey(project) });
    };
    // A remount straight after an unmount (React's strict mode, the page moving the panel) is not leaving.
    clearTimeout(leaving.get(project));
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", mark);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", mark);
      leaving.set(project, setTimeout(mark, 0));
    };
  }, [project, qc]);
}
