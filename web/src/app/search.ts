const shown = 8;

type Searchable = { key: string; title: string };

/** A record that matched, with how well: 0 its key itself, 1 a key starting with the query, 2 every word in its title. */
export type Hit<T> = { score: number; record: T };

/**
 * The records matching `query`, best first: the key itself, then keys starting with it, then
 * titles holding every word of it. An empty query matches nothing.
 */
export function rankRecords<T extends Searchable>(query: string, records: T[], limit = shown): Hit<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const hits: Hit<T>[] = [];
  for (const r of records) {
    const key = r.key.toLowerCase();
    const title = r.title.toLowerCase();
    let score = -1;
    if (key && key === q) score = 0;
    else if (key && key.startsWith(q)) score = 1;
    else if (words.every((w) => title.includes(w) || key === w)) score = 2;
    if (score >= 0) hits.push({ score, record: r });
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, limit);
}

export function matchRecords<T extends Searchable>(query: string, records: T[], limit = shown): T[] {
  return rankRecords(query, records, limit).map((h) => h.record);
}

/**
 * The order of ⌘K's groups: the group holding the best hit first (typing a Feature's key puts the
 * Feature above the Tasks whose keys merely start with it), else the order given.
 */
export function orderGroups<G extends { best: number }>(groups: G[]): G[] {
  return groups.map((g, i) => ({ g, i })).sort((a, b) => a.g.best - b.g.best || a.i - b.i).map(({ g }) => g);
}
