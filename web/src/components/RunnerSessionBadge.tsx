import type { Member, RunnerSession, RunnerSessionState } from "@/api/client";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "./MemberAvatar";
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
 * A fact, not a button. `bare` leaves out "Session ·" where a column already says it.
 */
export function RunnerSessionBadge({ session, bare, className }: { session: RunnerSession; bare?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <SessionStateDot state={session.state} />
      <span className="truncate">
        {!bare && "Session · "}
        {session.state === "running" ? "running since" : `${session.state} · started`} <ClockTime at={session.started_at} /> · {session.host}
      </span>
    </span>
  );
}

const stateNames: Record<RunnerSessionState, string> = { running: "Running", nudged: "Nudged", ending: "Ending" };

function Sep() {
  return (
    <span aria-hidden className="text-muted-foreground">
      ·
    </span>
  );
}

/**
 * A runner session's facts in one line, as text: the agent, when it started, its state, the
 * machine it runs on, and its tmux session, or "no tmux" when it cannot be joined.
 */
export function SessionFacts({
  session,
  agent,
  className,
}: {
  session: RunnerSession;
  agent: Pick<Member, "name" | "kind"> | undefined;
  className?: string;
}) {
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap", className)}>
      {agent && (
        <>
          <MemberAvatar member={agent} />
          <span className="font-medium">{agent.name}</span>
          <Sep />
        </>
      )}
      <span>
        started <ClockTime at={session.started_at} />
      </span>
      <Sep />
      <span className="inline-flex items-center gap-1.5">
        <SessionStateDot state={session.state} />
        {stateNames[session.state]}
      </span>
      <Sep />
      <span className="min-w-0 truncate" title="Host">
        {session.host}
      </span>
      <Sep />
      {session.tmux ? (
        <span className="min-w-0 truncate">
          tmux <span className="font-mono text-xs">{session.tmux}</span>
        </span>
      ) : (
        <span>no tmux</span>
      )}
    </p>
  );
}
