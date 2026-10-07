import type { Member, RunnerSession, RunnerSessionState } from "@/api/client";
import { cn } from "@/lib/utils";
import { MemberAvatar } from "./MemberAvatar";
import { Pill, type PillTone } from "./Pill";
import { ClockTime } from "./Time";

const stateNames: Record<RunnerSessionState, string> = { running: "Running", waiting: "Waiting", stalled: "Stalled", ending: "Ending" };

const stateTones: Record<RunnerSessionState, PillTone> = { running: "done", waiting: "claimed", stalled: "blocked", ending: "dropped" };

const stateHints: Record<RunnerSessionState, string> = {
  running: "The agent is working; the Runner sends its Heartbeats",
  waiting: "The agent's turn ended without a decision (the Runner nudges it, then releases the Task), or it asks something a person answers by joining",
  stalled: "No progress for a while: the Runner sends no more Heartbeats, and the Claim lapses unless it moves",
  ending: "The Claim has ended; the session is closing",
};

/** A runner session's state as a pill: Running (green), Waiting (amber), Stalled (red), Ending (grey). */
export function SessionStatePill({ state }: { state: RunnerSessionState }) {
  return (
    <span title={stateHints[state]} className="inline-flex">
      <Pill tone={stateTones[state]}>{stateNames[state]}</Pill>
    </span>
  );
}

/**
 * The session the Runner runs for a Task, in one line: "Session [Running] started 04:25 ·
 * mac-mini". A fact, not a button. `bare` leaves out "Session" where a column already says it,
 * and `state={false}` the pill where a column of its own shows it.
 */
export function RunnerSessionBadge({
  session,
  bare,
  state = true,
  className,
}: {
  session: RunnerSession;
  bare?: boolean;
  state?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {!bare && <span>Session</span>}
      {state && <SessionStatePill state={session.state} />}
      <span className="truncate">
        started <ClockTime at={session.started_at} /> · {session.host}
      </span>
    </span>
  );
}

function Sep() {
  return (
    <span aria-hidden className="text-muted-foreground">
      ·
    </span>
  );
}

/**
 * A runner session's facts in one line, as text: the agent, when it started, its state, the
 * machine it runs on, and its tmux session, or "no tmux" when it cannot be joined. Too narrow for
 * one line (a phone), it wraps between facts rather than cutting them.
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
    <p className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 whitespace-nowrap", className)}>
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
      <SessionStatePill state={session.state} />
      <Sep />
      <span className="max-w-full truncate" title="Host">
        {session.host}
      </span>
      <Sep />
      {session.tmux ? (
        <span className="max-w-full truncate">
          tmux <span className="font-mono text-xs">{session.tmux}</span>
        </span>
      ) : (
        <span>no tmux</span>
      )}
    </p>
  );
}
