import { useMutation } from "@tanstack/react-query";
import { BanIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import type { Token } from "@/api/client";
import { revokeToken } from "@/api/writes";
import { Key } from "@/components/Key";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { count, revokeSummary, type Held, type Session } from "./model";
import { ConfirmDialog, Fact, Facts, MoreMenu, RecordRow } from "./parts";

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
                  <Key key={s.id}>{s.id}</Key>
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
