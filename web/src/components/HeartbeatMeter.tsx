import type { Claim } from "@/api/client";
import { useNow } from "@/clock";
import { lastedText, untilText } from "@/lib/time";
import { cn } from "@/lib/utils";

type Beat = Pick<Claim, "started_at" | "expires_at" | "heartbeat_timeout_seconds">;

const lapseTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
/** The last stretch of a Claim, when the lapse is the fact that matters. */
const lastMinute = 60_000;

/**
 * A held Task's hold, in plain words (kit `.hb`): "● working 2m", green, the hold's age; "● lapses
 * in 40s", amber, in the Claim's last minute without a Heartbeat; "Lapsed" past it. A Claim with
 * no expiry is working as long as its holder holds it. `bar` (the rail, the Agents peek) keeps the
 * time left as a bar over the timeout beside the words; `compact` (a card, a row) is the words
 * alone. The exact lapse time on hover; each Heartbeat moves it on.
 */
export function HeartbeatMeter({ claim, variant = "bar", className }: { claim: Beat; variant?: "bar" | "compact"; className?: string }) {
  const now = useNow();
  const base = cn("inline-flex items-center gap-1.5 tabular-nums whitespace-nowrap", className);
  const left = claim.expires_at ? Date.parse(claim.expires_at) - now : undefined;
  if (left !== undefined && left <= 0) return <span className={cn(base, "text-state-dropped")}>Lapsed</span>;
  const lapsing = left !== undefined && left <= lastMinute;
  const title = claim.expires_at
    ? `Lapses at ${lapseTime.format(new Date(claim.expires_at))} unless a Heartbeat arrives`
    : `Held since ${lapseTime.format(new Date(claim.started_at))}`;
  const timeoutMs = (claim.heartbeat_timeout_seconds ?? 0) * 1000;
  const share = left !== undefined && timeoutMs > 0 ? Math.min(1, left / timeoutMs) : undefined;
  return (
    <span className={base} title={title}>
      {variant === "bar" && share !== undefined && (
        <span
          role="meter"
          aria-label="Time left before the Claim lapses"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
          className="h-1 w-10 flex-none overflow-hidden rounded-[2px] bg-muted"
        >
          <i className={cn("block h-full", share < 1 / 3 ? "bg-state-claimed" : "bg-state-done")} style={{ width: `${share * 100}%` }} />
        </span>
      )}
      <span className={cn("inline-flex items-center gap-1.5", lapsing ? "text-state-claimed" : "text-state-done")}>
        <span aria-hidden className="size-1.5 flex-none rounded-full bg-current" />
        <span>{lapsing ? `lapses in ${untilText(left)}` : `working ${lastedText(now - Date.parse(claim.started_at))}`}</span>
      </span>
    </span>
  );
}
