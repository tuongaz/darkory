import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { newKey } from "@/api/client";

// The Member's "seen" mark of a Project's Activity: `GET` and `PUT /v1/projects/{project}/seen`.
// The operation is specified on the wl-seen branch; until it is merged into the spec this app is
// generated from, it is called here by hand against its shape, and swapped for the typed client then.

/** How far the Member has seen a Project's Activity: both null until they first looked. */
export type Seen = { seq: number | null; at: string | null };

const never: Seen = { seq: null, at: null };

export const seenKey = (project: string) => ["seen", project] as const;

const url = (project: string) => `${window.location.origin}/v1/projects/${encodeURIComponent(project)}/seen`;

/** The mark, or none when it cannot be read (not in the Project, or a server without it). */
export async function readSeen(project: string): Promise<Seen> {
  const res = await globalThis.fetch(new Request(url(project), { credentials: "include" }));
  if (!res.ok) return never;
  const body = (await res.json()) as Partial<Seen>;
  return { seq: typeof body.seq === "number" ? body.seq : null, at: typeof body.at === "string" ? body.at : null };
}

/**
 * Moves the mark forward to `seq`; the server keeps the higher of the two. `keepalive` lets the
 * write outlive a page being left. A refusal changes nothing the Member sees: the mark stays.
 */
export function writeSeen(project: string, seq: number): Promise<unknown> {
  return globalThis
    .fetch(
      new Request(url(project), {
        method: "PUT",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json", "Idempotency-Key": newKey() },
        body: JSON.stringify({ seq }),
      }),
    )
    .catch(() => undefined);
}

/** The Member's mark of `project` as it stood when they came to the page (or last came back to it). */
export function useSeen(project: string): Seen | undefined {
  return useQuery({ queryKey: seenKey(project), queryFn: () => readSeen(project), staleTime: Infinity }).data;
}

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
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", mark);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", mark);
      mark();
    };
  }, [project, qc]);
}
