import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon, LogOutIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { To } from "react-router";
import type { Member, RunnerSession, Session } from "@/api/client";
import { useEndedSessions, type MemberSessions } from "@/api/queries";
import { closeSession, logout } from "@/api/writes";
import { Copy } from "@/components/Copy";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { Refusal } from "@/components/Refusal";
import { SessionStatePill } from "@/components/RunnerSessionBadge";
import { useNow } from "@/clock";
import { ClockTime, DayTime } from "@/components/Time";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { boundToSession, count, madeThrough, type Held } from "./model";
import { ConfirmDialog, Fact, Facts, MoreMenu } from "./parts";

/**
 * A Member's Sessions as a table: each one's full id (with Copy), when it started and was last
 * seen, whether it is open or ended — and, for the Session the Runner holds a Claim through, the
 * state of the agent's session there — the Tasks held through it, and Close Session in its ⋯,
 * which asks first. Ended Sessions are hidden behind "Show ended (N)". On Account, `current` marks
 * this browser, whose row has Log out instead. `compact` fits a narrow host, such as the agent's
 * peek or a phone: Started and Last seen share a column, and the state and what a Session holds
 * go under its id, which keeps the width to stay on one line.
 */
export function SessionsTable({
  member,
  sessions,
  held,
  runner,
  taskTo,
  self,
  current,
  canClose,
  compact: narrowHost,
}: {
  member: Pick<Member, "id" | "name">;
  sessions: MemberSessions;
  held: Held[];
  runner?: RunnerSession;
  taskTo: (key: string) => To;
  /** Whether the Sessions are the caller's own: closing one then names no Member. */
  self: boolean;
  current?: string;
  canClose: boolean;
  compact?: boolean;
}) {
  // A phone is narrow whatever the host.
  const phone = useIsMobile();
  const compact = narrowHost || phone;
  const [showEnded, setShowEnded] = useState(false);
  const ended = useEndedSessions(member.id, showEnded && sessions.ended > 0);
  const [closing, setClosing] = useState<Session | null>(null);
  const close = useMutation({
    mutationFn: (s: Session) => closeSession(s.id, self ? undefined : member.id),
    onSuccess: () => setClosing(null),
  });
  const qc = useQueryClient();
  // Forget everything read as this Member; /v1/me then answers 401 and the shell logs out.
  const signOut = useMutation({ mutationFn: logout, onSuccess: () => qc.resetQueries() });
  const endedRows = showEnded ? (ended.data?.pages.flatMap((p) => p.items) ?? []) : [];
  const ends = closing ? boundToSession(held, closing.id) : [];
  const cols = compact ? 3 : 6;

  const row = (s: Session) => {
    const open = !s.ended_at;
    const here = s.id === current;
    // An ended Session holds nothing: its bound Claims ended with it, and a Claim made through it
    // without a timeout is the Member's.
    const holds = open ? madeThrough(held, s.id) : [];
    const run = open && runner?.session_id === s.id ? runner : undefined;
    const state = <SessionState session={s} runner={run} />;
    const holding = holds.length > 0 && (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {compact && <span className="text-muted-foreground">Holds</span>}
        {holds.map((h) => (
          <Key key={h.task.id} to={taskTo(h.task.key)}>
            {h.task.key}
          </Key>
        ))}
        {holds[0].claim.heartbeat_timeout_seconds ? <HeartbeatMeter claim={holds[0].claim} variant="compact" className="text-xs" /> : null}
      </span>
    );
    return (
      <tr
        key={s.id}
        aria-label={here ? "This browser" : `Session ${s.id}`}
        className={cn("group/copy border-b align-top last:border-b-0 [&>td]:py-2 [&>td]:pr-2.5 [&>td:first-child]:pl-2.5", !open && "text-muted-foreground")}
      >
        <td>
          {here && <b className="block text-xs font-medium text-foreground">This browser</b>}
          <Copy value={s.id} label="Session id" className="leading-5">
            <span className={cn("font-mono text-[11.5px] [overflow-wrap:anywhere]", open && "text-foreground")}>{s.id}</span>
          </Copy>
          {s.kind === "browser" && !here && <span className="block text-xs text-muted-foreground">Browser</span>}
          {compact && <span className="block text-xs leading-5">{state}</span>}
          {compact && holding && <span className="block text-xs leading-5">{holding}</span>}
        </td>
        {compact ? (
          <td className="text-xs leading-5">
            <DayTime at={s.started_at} what="Started" className="block" />
            <Ago at={s.last_seen_at} className="block whitespace-nowrap text-muted-foreground" />
          </td>
        ) : (
          <>
            <td className="text-xs leading-5">
              <DayTime at={s.started_at} what="Started" />
            </td>
            <td className="text-xs leading-5">
              <Ago at={s.last_seen_at} className="whitespace-nowrap" />
            </td>
          </>
        )}
        {!compact && <td className="text-xs leading-5">{state}</td>}
        {!compact && <td className="text-xs leading-5">{holding}</td>}
        <td className="!pr-1 text-right">
          {open &&
            (here ? (
              <Button variant="outline" size="xs" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
                <LogOutIcon />
                Log out
              </Button>
            ) : (
              canClose && (
                <MoreMenu label={`More for Session ${s.id}`} size="icon-xs">
                  <DropdownMenuItem variant="destructive" onSelect={() => setClosing(s)}>
                    <XIcon />
                    Close Session
                  </DropdownMenuItem>
                </MoreMenu>
              )
            ))}
        </td>
      </tr>
    );
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div className="w-full min-w-0 overflow-hidden rounded-md border">
        <table aria-label={`Sessions of ${member.name}`} className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col />
            {/* The id takes what the others leave: its 22 characters on one line, on a phone too,
                where the state goes under it. */}
            {compact ? (
              <col className="w-[76px]" />
            ) : (
              <>
                <col className="w-[56px]" />
                <col className="w-[80px]" />
              </>
            )}
            {!compact && <col className="w-[112px]" />}
            {!compact && <col className="w-[96px]" />}
            <col className={here(sessions.items, current) ? "w-[92px]" : "w-8"} />
          </colgroup>
          <thead>
            <tr className="h-8 border-b text-left text-xs text-muted-foreground [&>th]:pr-2.5 [&>th]:font-medium [&>th:first-child]:pl-2.5">
              <th scope="col">ID</th>
              {compact ? (
                <th scope="col" title="Started, and last seen">
                  Seen
                </th>
              ) : (
                <>
                  <th scope="col">Started</th>
                  <th scope="col">Last seen</th>
                </>
              )}
              {!compact && <th scope="col">State</th>}
              {!compact && <th scope="col">Holds</th>}
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.items.length === 0 && (
              <tr>
                <td colSpan={cols} className="px-2.5 py-2 text-muted-foreground">
                  None open
                </td>
              </tr>
            )}
            {sessions.items.map(row)}
            {endedRows.map(row)}
          </tbody>
        </table>
      </div>
      {sessions.ended > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="xs" className="text-muted-foreground" aria-expanded={showEnded} onClick={() => setShowEnded((v) => !v)}>
            {showEnded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            {showEnded ? "Hide ended" : `Show ended (${sessions.ended})`}
          </Button>
          {showEnded && ended.hasNextPage && (
            <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={ended.isFetchingNextPage} onClick={() => void ended.fetchNextPage()}>
              Show more ended
            </Button>
          )}
        </div>
      )}
      <Refusal error={ended.error ?? signOut.error} />
      {closing && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (o) return;
            setClosing(null);
            close.reset();
          }}
          title="Close this Session?"
          confirmLabel="Close Session"
          onConfirm={() => close.mutate(closing)}
          pending={close.isPending}
          error={close.error}
        >
          <Facts>
            <Fact label="Closes">
              <span className="font-mono text-xs [overflow-wrap:anywhere]">{closing.id}</span>
            </Fact>
            {ends.length > 0 && (
              <Fact label="Ends">
                {count(ends.length, "Claim")}
                {ends.map((h) => (
                  <Key key={h.task.id}>{h.task.key}</Key>
                ))}
              </Fact>
            )}
          </Facts>
        </ConfirmDialog>
      )}
    </div>
  );
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Ago({ at, className }: { at: string; className?: string }) {
  const now = useNow();
  return (
    <time dateTime={at} title={`Last seen ${dateTime.format(new Date(at))}`} className={cn("tabular-nums", className)}>
      {agoText(now - new Date(at).getTime())}
    </time>
  );
}

function here(sessions: Session[], current: string | undefined) {
  return !!current && sessions.some((s) => s.id === current);
}

/**
 * Open or Ended (with when), and for the Session the Runner works a Task through, the agent
 * session's state there and since when: "Open", then "Running since 22:01".
 */
function SessionState({ session, runner }: { session: Session; runner?: RunnerSession }) {
  if (session.ended_at) {
    return (
      <span className="block">
        Ended <DayTime at={session.ended_at} what="Ended" />
      </span>
    );
  }
  return (
    <>
      <span className="flex items-center gap-1.5 text-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-state-done" />
        Open
      </span>
      {runner && (
        <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5" title="What the Runner's session for the Task held through this Session is doing">
          <SessionStatePill state={runner.state} />
          <span className="whitespace-nowrap text-muted-foreground">
            since <ClockTime at={runner.state_since} />
          </span>
        </span>
      )}
    </>
  );
}
