import type { RunnerSession, RunnerSessionState } from "@/api/client";
import { cn } from "@/lib/utils";
import { ClockTime } from "./Time";

const dots: Record<RunnerSessionState, string> = {
  running: "bg-state-done",
  nudged: "bg-state-claimed",
  ending: "bg-state-dropped",
};

/** A runner session's state as its dot: green running, amber nudged, grey ending. */
export function SessionStateDot({ state, className }: { state: RunnerSessionState; className?: string }) {
  return <span aria-hidden className={cn("size-1.5 flex-none rounded-full", dots[state], className)} />;
}

/**
 * The session the Runner runs for a Task, in one line: "Session · running since 04:25 · mac-mini".
 * A fact, not a button.
 */
export function RunnerSessionBadge({ session, className }: { session: RunnerSession; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <SessionStateDot state={session.state} />
      <span className="truncate">
        Session · {session.state === "running" ? "running since" : `${session.state} · started`} <ClockTime at={session.started_at} /> · {session.host}
      </span>
    </span>
  );
}
