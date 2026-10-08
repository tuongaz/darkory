/** "15 min", "40 s", "2 h": how long until `ms` from now, rounded up so it never reads 0 while it holds. */
export function untilText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 120) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/** "40 s", "4 min", "2 h": how long something has lasted, rounded down, at least a second. */
export function lastedText(ms: number): string {
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** A time as a row shows it: "22:18" today, "6 Oct" this year, "6 Oct 2025" before. */
export function shortWhen(at: string, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return clock.format(d);
  return d.getFullYear() === n.getFullYear() ? day.format(d) : dayYear.format(d);
}

/** "40 s ago", "3 min ago", "5 h ago", "2 d ago": short enough for a narrow column; the exact time on hover. */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
