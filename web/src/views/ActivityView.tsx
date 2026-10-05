import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { Link } from "react-router";
import { api, call, type Activity } from "../api/client";
import { useLiveEntries } from "../api/live";
import { keys } from "../api/queries";
import { Refusal, Time } from "../components/ui";
import { MemberName } from "../components/work";

const pageSize = 100;

/**
 * Activity, newest first: what the stream delivered since the page loaded, and history read
 * forward from the start with `after`. The API pages Activity only forward, so where the history
 * read so far ends before the stream began, a button reads the next page into the gap.
 */
export function ActivityView() {
  const live = useLiveEntries();
  const history = useInfiniteQuery({
    queryKey: keys.activity,
    queryFn: ({ pageParam }) =>
      call(api.GET("/v1/activity", { params: { query: { after: pageParam, limit: pageSize } } })),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.items.length < pageSize ? undefined : last.last_seq),
  });

  const bySeq = new Map<number, Activity>();
  for (const page of history.data?.pages ?? []) for (const e of page.items) bySeq.set(e.seq, e);
  for (const e of live) bySeq.set(e.seq, e);
  const entries = [...bySeq.values()].sort((a, b) => b.seq - a.seq);

  const pages = history.data?.pages;
  const readTo = pages?.[pages.length - 1].last_seq ?? 0;
  const firstLive = live.length > 0 ? live[live.length - 1].seq : undefined;
  const gap = history.hasNextPage && (firstLive === undefined || firstLive > readTo + 1);
  // The button sits where the history read so far ends, above the oldest entries.
  const gapAt = gap ? entries.findIndex((e) => e.seq <= readTo) : -1;
  const loadMore = (
    <li className="gap">
      <button type="button" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
        Load entries after #{readTo}
      </button>
    </li>
  );

  return (
    <>
      <h1>Activity</h1>
      <p className="muted">Every change to the record, as it happens.</p>
      <Refusal error={history.error} />
      {history.isPending && <p className="muted">Loading…</p>}
      {history.isSuccess && entries.length === 0 && <p className="muted">Nothing has happened yet.</p>}
      <ol className="list activity" aria-live="polite" aria-relevant="additions">
        {entries.map((e, i) => (
          <Fragment key={e.seq}>
            {i === gapAt && loadMore}
            <ActivityItem entry={e} />
          </Fragment>
        ))}
      </ol>
    </>
  );
}

function ActivityItem({ entry }: { entry: Activity }) {
  const area = entry.kind.split(".")[0];
  const subject =
    area === "task" ? `/tasks/${entry.subject_id}` : area === "feature" ? `/features/${entry.subject_id}` : undefined;
  const summary = summarise(entry.payload);
  return (
    <li>
      <span className="seq">#{entry.seq}</span>
      <div className="grow">
        <MemberName id={entry.actor_id} /> <code>{entry.kind}</code>{" "}
        {subject ? <Link to={subject}>{summary || "open"}</Link> : summary}
        <div className="meta">
          <Time at={entry.at} />
        </div>
      </div>
    </li>
  );
}

/** A short line from an Activity payload: its key and title when it has them. */
function summarise(payload: Record<string, unknown>): string {
  const pick = ["key", "title", "name"].map((k) => payload[k]).filter((v) => typeof v === "string");
  if (pick.length > 0) return pick.join(" ");
  return Object.entries(payload)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ");
}
