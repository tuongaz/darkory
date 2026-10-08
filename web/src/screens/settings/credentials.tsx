import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BanIcon, KeyRoundIcon, LogOutIcon, MonitorIcon, XIcon, ZapIcon } from "lucide-react";
import { useState } from "react";
import type { Member, Token } from "@/api/client";
import { logout } from "@/api/writes";
import { SessionId } from "@/components/CopyValue";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { shortSessionId } from "@/lib/members";
import { boundToSession, count, madeThrough, revokeSummary, type Held, type Session } from "./model";
import { ConfirmDialog, Fact, Facts, MoreMenu, RecordRow } from "./parts";
import { closeSession, revokeToken } from "@/api/writes";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** A moment as short as it can be told apart: "22:18" today, "6 Oct, 22:18" before, the full date on hover. */
export function Stamp({ at }: { at: string }) {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return (
    <time dateTime={at} title={dateTime.format(d)} className="tabular-nums">
      {today ? clock.format(d) : `${day.format(d)}, ${clock.format(d)}`}
    </time>
  );
}

/** A Member's live tokens, each with Revoke in its ⋯, which asks first and says what it stops. */
export function TokenRows({ tokens, sessions, held }: { tokens: Token[]; sessions: Session[]; held: Held[] }) {
  const [revoking, setRevoking] = useState<Token | null>(null);
  const revoke = useMutation({ mutationFn: (t: Token) => revokeToken(t.id), onSuccess: () => setRevoking(null) });
  if (tokens.length === 0) return <span className="text-muted-foreground">None</span>;
  const summary = revoking ? revokeSummary(revoking, sessions, held) : undefined;
  return (
    <div role="list" aria-label="Tokens" className="flex w-full min-w-0 flex-col gap-1.5">
      {tokens.map((t) => (
        <RecordRow
          key={t.id}
          label={`Token ${t.name}`}
          icon={<KeyRoundIcon />}
          action={
            <MoreMenu label={`More for token ${t.name}`} size="icon-xs">
              <DropdownMenuItem variant="destructive" onSelect={() => setRevoking(t)}>
                <BanIcon />
                Revoke
              </DropdownMenuItem>
            </MoreMenu>
          }
        >
          <b className="font-medium">{t.name}</b>
          <Key>{`${t.prefix}…`}</Key>
          <span className="text-muted-foreground">
            issued <Stamp at={t.created_at} />
            {t.last_used_at && (
              <>
                {" · last used "}
                <Stamp at={t.last_used_at} />
              </>
            )}
          </span>
        </RecordRow>
      ))}
      {revoking && summary && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (o) return;
            setRevoking(null);
            revoke.reset();
          }}
          title={`Revoke ${revoking.name}?`}
          confirmLabel="Revoke"
          onConfirm={() => revoke.mutate(revoking)}
          pending={revoke.isPending}
          error={revoke.error}
        >
          <Facts>
            <Fact label="Revokes">
              1 token<Key>{revoking.name}</Key>
            </Fact>
            {summary.sessions.length > 0 && (
              <Fact label="Closes">
                {count(summary.sessions.length, "Session")}
                {summary.sessions.map((s) => (
                  <Key key={s.id}>{shortSessionId(s.id)}</Key>
                ))}
              </Fact>
            )}
            {summary.claims.length > 0 && (
              <Fact label="Ends">
                {count(summary.claims.length, "Claim")}
                {summary.claims.map((h) => (
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

/**
 * A Member's open Sessions: the id, what it holds, and Close Session in its ⋯, which asks first.
 * On Account, `current` marks this browser, whose row has Log out instead.
 */
export function SessionRows({ member, sessions, held, current }: { member: Member; sessions: Session[]; held: Held[]; current?: string }) {
  const [closing, setClosing] = useState<Session | null>(null);
  const close = useMutation({
    mutationFn: (s: Session) => closeSession(s.id, current ? undefined : member.id),
    onSuccess: () => setClosing(null),
  });
  const qc = useQueryClient();
  // Forget everything read as this Member; /v1/me then answers 401 and the shell logs out.
  const signOut = useMutation({ mutationFn: logout, onSuccess: () => qc.resetQueries() });
  if (sessions.length === 0) return <span className="text-muted-foreground">None open</span>;
  const ends = closing ? boundToSession(held, closing.id) : [];
  return (
    <div role="list" aria-label="Sessions" className="flex w-full min-w-0 flex-col gap-1.5">
      {sessions.map((s) => {
        const here = s.id === current;
        return (
          <RecordRow
            key={s.id}
            label={here ? "This browser" : `Session ${s.id}`}
            icon={s.kind === "browser" ? <MonitorIcon /> : <ZapIcon />}
            action={
              // This browser logs out; any other Session is closed from its ⋯, which asks first.
              here ? (
                <Button variant="outline" size="xs" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
                  <LogOutIcon />
                  Log out
                </Button>
              ) : (
                <MoreMenu label={`More for Session ${s.id}`} size="icon-xs">
                  <DropdownMenuItem variant="destructive" onSelect={() => setClosing(s)}>
                    <XIcon />
                    Close Session
                  </DropdownMenuItem>
                </MoreMenu>
              )
            }
          >
            {here && <b className="font-medium">This browser</b>}
            <SessionId id={s.id} className="text-foreground" />
            <SessionWork session={s} held={held} />
          </RecordRow>
        );
      })}
      <Refusal error={signOut.error} />
      {closing && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (o) return;
            setClosing(null);
            close.reset();
          }}
          title={`Close ${closing.id}?`}
          confirmLabel="Close Session"
          onConfirm={() => close.mutate(closing)}
          pending={close.isPending}
          error={close.error}
        >
          <Facts>
            <Fact label="Closes">
              1 Session<Key>{shortSessionId(closing.id)}</Key>
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

/** What a Session is doing: the Tasks it holds, the Heartbeat due and the model label; else when it signed in. */
function SessionWork({ session, held }: { session: Session; held: Held[] }) {
  const holds = madeThrough(held, session.id);
  if (holds.length === 0) {
    return (
      <span className="text-muted-foreground">
        {session.kind === "browser" ? "signed in " : "started "}
        <Stamp at={session.started_at} />
      </span>
    );
  }
  const labels = [...new Set(holds.flatMap((h) => (h.claim.model_label ? [h.claim.model_label] : [])))];
  return (
    <>
      {holds.map((h) => (
        <Pill key={h.task.id} tone="claimed">
          Holding {h.task.key}
        </Pill>
      ))}
      {holds[0].claim.heartbeat_timeout_seconds ? <HeartbeatMeter claim={holds[0].claim} variant="compact" /> : null}
      {labels.length > 0 && <span className="truncate text-muted-foreground">· {labels.join(", ")}</span>}
    </>
  );
}
