const shown = 8;

type Searchable = { key: string; title: string };

/**
 * The records matching `query`, best first: the key itself, then keys starting with it, then
 * titles holding every word of it. An empty query matches nothing.
 */
export function matchRecords<T extends Searchable>(query: string, records: T[], limit = shown): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const scored: [number, T][] = [];
  for (const r of records) {
    const key = r.key.toLowerCase();
    const title = r.title.toLowerCase();
    let score = -1;
    if (key === q) score = 0;
    else if (key.startsWith(q)) score = 1;
    else if (words.every((w) => title.includes(w) || key === w)) score = 2;
    if (score >= 0) scored.push([score, r]);
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map(([, r]) => r);
}
