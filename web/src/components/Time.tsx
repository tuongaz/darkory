import { useNow } from "@/clock";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** A date and time, "6 Oct 2026, 22:18". */
export function Time({ at }: { at: string | undefined }) {
  if (!at) return null;
  return <time dateTime={at}>{dateTime.format(new Date(at))}</time>;
}

/** The time of day, "22:18", with the full date on hover: rows and the Timeline use it. */
export function ClockTime({ at }: { at: string }) {
  const d = new Date(at);
  return (
    <time dateTime={at} title={dateTime.format(d)} className="tabular-nums">
      {clock.format(d)}
    </time>
  );
}

/** A time as "in 4 minutes" or "2 hours ago", re-rendered as the clock moves, with the full time on hover. */
export function RelativeTime({ at }: { at: string }) {
  const now = useNow();
  const seconds = (new Date(at).getTime() - now) / 1000;
  const abs = Math.abs(seconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60 ? [seconds, "second"] : abs < 3600 ? [seconds / 60, "minute"] : abs < 86400 ? [seconds / 3600, "hour"] : [seconds / 86400, "day"];
  return (
    <time dateTime={at} title={dateTime.format(new Date(at))}>
      {relative.format(Math.round(value), unit)}
    </time>
  );
}
