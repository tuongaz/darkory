const maxPages = 20;

/** Reads every page of a cursor-paged list, up to a bound. */
export async function allPages<T>(page: (cursor?: string) => Promise<{ items: T[]; next_cursor?: string }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const r = await page(cursor);
    items.push(...r.items);
    if (!r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return items;
}
