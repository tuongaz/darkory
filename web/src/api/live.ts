import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { Activity } from "./client";
import { invalidateAll, invalidateFor } from "./queries";

export type StreamState = "connecting" | "live" | "reconnecting" | "closed";

const kept = 500;

/** The Activity received over the stream since the page loaded, newest first. */
export class LiveActivity {
  private entries: Activity[] = [];
  private state: StreamState = "connecting";
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  entriesSnapshot = () => this.entries;
  stateSnapshot = () => this.state;

  add(entry: Activity) {
    if (this.entries.some((e) => e.seq === entry.seq)) return;
    this.entries = [entry, ...this.entries].sort((a, b) => b.seq - a.seq).slice(0, kept);
    this.emit();
  }

  setState(state: StreamState) {
    if (state === this.state) return;
    this.state = state;
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

export const LiveActivityContext = createContext<LiveActivity | null>(null);

function useLive(): LiveActivity {
  const live = useContext(LiveActivityContext);
  if (!live) throw new Error("LiveActivityContext is not provided");
  return live;
}

export function useLiveEntries(): Activity[] {
  const live = useLive();
  return useSyncExternalStore(live.subscribe, live.entriesSnapshot);
}

export function useStreamState(): StreamState {
  const live = useLive();
  return useSyncExternalStore(live.subscribe, live.stateSnapshot);
}

const retryAfterMs = 10_000;

/**
 * Holds the Activity stream open while mounted. Each entry marks the queries it may have changed
 * stale, so open views refetch. After a dropped connection the browser reconnects by itself and
 * sends Last-Event-ID, so the server resumes after the last entry seen. When the server refuses
 * the stream outright the browser gives up; this then opens a new one after a pause, resuming
 * with `after`.
 */
export function useActivityStream() {
  const qc = useQueryClient();
  const live = useLive();
  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastSeq: number | undefined;

    const open = () => {
      const url = lastSeq === undefined ? "/v1/activity/stream" : `/v1/activity/stream?after=${lastSeq}`;
      const s = new EventSource(url, { withCredentials: true });
      source = s;
      s.onopen = () => {
        // A stream that was refused may have missed entries no one will replay.
        if (live.stateSnapshot() === "closed") invalidateAll(qc);
        live.setState("live");
      };
      s.onerror = () => {
        if (s.readyState !== EventSource.CLOSED) {
          live.setState("reconnecting");
          return;
        }
        live.setState("closed");
        retry = setTimeout(open, retryAfterMs);
      };
      s.addEventListener("activity", (event) => {
        let entry: Activity;
        try {
          entry = JSON.parse((event as MessageEvent<string>).data) as Activity;
        } catch {
          return;
        }
        lastSeq = Math.max(lastSeq ?? 0, entry.seq);
        live.add(entry);
        invalidateFor(qc, entry);
      });
    };

    open();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [qc, live]);
}
