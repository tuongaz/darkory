import { HeartPulseIcon } from "lucide-react";
import type { Claim } from "@/api/client";
import { useNow } from "@/clock";
import { untilText } from "@/lib/time";
import { cn } from "@/lib/utils";

type Beat = Pick<Claim, "expires_at" | "heartbeat_timeout_seconds">;

const lapseTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/**
 * How long a Claim has until it lapses without a Heartbeat (kit `.hb`). `bar` (the peek and the
 * Agents table) draws the time left as a bar over the timeout, amber in the last third; `compact`
 * (a card, a row) draws the pulse icon instead. Both read "lapses in 15 min", "lapses in 36 s",
 * the exact time on hover; each Heartbeat moves it on. A Claim with no timeout reads "No expiry",
 * one past its expiry "Lapsed".
 */
export function HeartbeatMeter({ claim, variant = "bar", className }: { claim: Beat; variant?: "bar" | "compact"; className?: string }) {
  const now = useNow();
  const base = cn("inline-flex items-center gap-1.5 tabular-nums whitespace-nowrap", className);
  if (!claim.expires_at) return <span className={cn(base, "text-muted-foreground")}>No expiry</span>;
  const left = new Date(claim.expires_at).getTime() - now;
  if (left <= 0) return <span className={cn(base, "text-state-dropped")}>Lapsed</span>;
  const title = `Lapses at ${lapseTime.format(new Date(claim.expires_at))} unless a Heartbeat arrives`;
  if (variant === "compact") {
    return (
      <span className={base} title={title}>
        <HeartPulseIcon className="size-3 flex-none" aria-hidden />
        lapses in {untilText(left)}
      </span>
    );
  }
  const timeoutMs = (claim.heartbeat_timeout_seconds ?? 0) * 1000;
  const share = timeoutMs > 0 ? Math.min(1, left / timeoutMs) : 1;
  return (
    <span className={base} title={title}>
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
      lapses in {untilText(left)}
    </span>
  );
}
