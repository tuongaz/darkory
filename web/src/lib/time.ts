/** "15 min", "40 s", "2 h": how long until `ms` from now, rounded up so it never reads 0 while it holds. */
export function untilText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 120) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}
