import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDownIcon, HandIcon, HeartPulseIcon, HistoryIcon, PaperclipIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api, call, evidenceURL, type Activity, type ActivityKind } from "@/api/client";
import { useLiveEntries, useStreamState, type StreamState } from "@/api/live";
import { useDirectory } from "@/api/queries";
import { usePeekLink } from "@/app/peek";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { EmptyState } from "@/components/EmptyState";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { count, groupByMinute, matchesFilter, sizeText, type ActivityFilter } from "./derive";
import { newest, useFeatureMap, useStatuses, useTaskMap } from "./queries";
import { describe, isKnown, kindChoices, kindName, markWords, type Lookup, type Sentence } from "./wording";

const pageSize = 100;

/**
 * /activity: the trail, newest first, in runs of a minute under the day. ?member=, ?kind= and
 * ?team= (a name, a kind, a Team key) narrow it through /v1's filters; the stream's new entries
 * that pass the same filter arrive at the top.
 */
export function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const now = useNow();
  const dir = useDirectory();
  const tasks = useTaskMap();
  const features = useFeatureMap();
  const statuses = useStatuses();
  const live = useLiveEntries();

  const memberRef = params.get("member") ?? undefined;
  const kindRef = params.get("kind") ?? undefined;
  const teamRef = params.get("team") ?? undefined;
  const member = memberRef ? dir.memberList.find((m) => m.name === memberRef || m.id === memberRef) : undefined;
  const team = teamRef ? dir.teamList.find((t) => t.key === teamRef || t.id === teamRef) : undefined;
  const kind = kindRef && isKnown(kindRef) ? kindRef : undefined;
  const filtered = !!(memberRef || kindRef || teamRef);

  const history = useInfiniteQuery({
    queryKey: ["activity", "page", { member: memberRef, kind: kindRef, team: teamRef }],
    queryFn: ({ pageParam }) =>
      call(
        api.GET("/v1/activity", {
          params: {
            query: { before: pageParam, limit: pageSize, member: memberRef, kind: kindRef ? [kindRef as ActivityKind] : undefined, team: teamRef },
          },
        }),
      ),
    initialPageParam: newest,
    getNextPageParam: (page) => (page.items.length < pageSize || page.first_seq === undefined || page.first_seq <= 1 ? undefined : page.first_seq),
  });

  // The stream's entries that pass the filter, matched by id as /v1 matches them.
  const want: ActivityFilter = { member: member?.id, kind, team: team?.id };
  const resolved = (!memberRef || member) && (!kindRef || kind) && (!teamRef || team);
  const where = { taskFeature: (id: string) => tasks.get(id)?.feature_id, featureTeam: (id: string) => features.get(id)?.team_id };
  const bySeq = new Map<number, Activity>();
  for (const page of history.data?.pages ?? []) for (const e of page.items) bySeq.set(e.seq, e);
  if (resolved) for (const e of live) if (matchesFilter(e, want, where)) bySeq.set(e.seq, e);
  const entries = [...bySeq.values()].filter((e) => isKnown(e.kind)).sort((a, b) => b.seq - a.seq);

  // Entries are numbered without gaps, so an unfiltered stream entry more than one past the newest
  // one read means some arrived between the read and the stream opening; the history is read again.
  const newestRead = history.data?.pages[0]?.items.at(-1)?.seq ?? 0;
  const oldestLive = live.at(-1)?.seq;
  const missed = !filtered && history.isSuccess && oldestLive !== undefined && oldestLive > newestRead + 1;
  const { refetch, isFetching } = history;
  useEffect(() => {
    if (missed && !isFetching) void refetch();
  }, [missed, isFetching, refetch]);

  const lookup: Lookup = {
    members: dir.members,
    teams: dir.teams,
    skills: dir.skills,
    tasks,
    features,
    statuses,
    claims: new Map(entries.filter((e) => e.kind === "task.claimed").map((e) => [String(e.payload.claim_id), e])),
  };

  const set = (key: string, value: string | undefined) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });

  return (
    <>
      <TopBar crumbs={[{ label: "Activity" }]} actions={<StreamMark />} />
      <div className="flex h-10 flex-none items-center gap-1.5 overflow-x-auto border-b px-4" role="toolbar" aria-label="Filters">
        <FilterChip label="Member" value={memberRef && (member?.name ?? memberRef)} onClear={() => set("member", undefined)}>
          <DropdownMenuRadioGroup value={member?.name ?? ""} onValueChange={(v) => set("member", v)}>
            {dir.memberList.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.name}>
                <MemberAvatar member={m} />
                {m.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </FilterChip>
        <FilterChip label="Kind" value={kindRef && kindName(kindRef)} onClear={() => set("kind", undefined)}>
          <DropdownMenuRadioGroup value={kind ?? ""} onValueChange={(v) => set("kind", v)}>
            {kindChoices.map((k, i) => (
              <KindItem key={k.kind} choice={k} first={i === 0 || kindChoices[i - 1].group !== k.group} />
            ))}
          </DropdownMenuRadioGroup>
        </FilterChip>
        <FilterChip label="Team" value={teamRef && (team?.name ?? teamRef)} onClear={() => set("team", undefined)}>
          <DropdownMenuRadioGroup value={team?.key ?? ""} onValueChange={(v) => set("team", v)}>
            {dir.teamList.map((t) => (
              <DropdownMenuRadioItem key={t.id} value={t.key}>
                {t.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </FilterChip>
      </div>
      <Content>
        <h1 className="sr-only">Activity</h1>
        {history.isError ? (
          <Refusal error={history.error} className="px-6 py-5" />
        ) : history.isPending ? (
          <div className="flex flex-col gap-2 px-6 py-5">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<HistoryIcon />}
            title={filtered ? "No entries" : "No Activity"}
            action={
              filtered && (
                <Button variant="outline" onClick={() => setParams(new URLSearchParams())}>
                  Clear filters
                </Button>
              )
            }
          />
        ) : (
          <ol aria-label="Activity" aria-live="polite" aria-relevant="additions">
            {groupByMinute(entries, now).map((g) => (
              <li key={g.key}>
                <h2 className="flex h-[34px] items-center border-b bg-muted pr-4 pl-6 font-medium">{g.label}</h2>
                <ol>
                  {g.entries.map((e) => (
                    <EntryRow key={e.seq} entry={e} lookup={lookup} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </Content>
      {history.isSuccess && entries.length > 0 && (
        <footer className="flex h-10 flex-none items-center gap-2 border-t pr-4 pl-6 text-xs text-muted-foreground">
          {history.hasNextPage ? `${entries.length} entries loaded` : count(entries.length, "entry", "entries")}
          {history.hasNextPage && (
            <Button
              size="xs"
              variant="outline"
              className="ml-auto"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Load older
            </Button>
          )}
        </footer>
      )}
    </>
  );
}

function KindItem({ choice, first }: { choice: (typeof kindChoices)[number]; first: boolean }) {
  return (
    <>
      {first && (
        <>
          {choice.group !== "Task" && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="text-2xs text-muted-foreground">{choice.group}</DropdownMenuLabel>
        </>
      )}
      <DropdownMenuRadioItem value={choice.kind}>{choice.label}</DropdownMenuRadioItem>
    </>
  );
}

const chip = "inline-flex h-6 flex-none items-center gap-1.5 rounded-md border bg-background px-2 text-xs whitespace-nowrap";

/** A filter (kit `.chip`): "Member" with a one-select menu; once set, "Member is builder-2" and × to clear it. */
function FilterChip({ label, value, onClear, children }: { label: string; value: string | undefined; onClear: () => void; children: ReactNode }) {
  return (
    <span className={cn("inline-flex flex-none items-center", value && "rounded-md bg-accent")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(chip, "cursor-pointer hover:bg-accent", value && "rounded-r-none border-r-0 bg-accent")}>
            {value ? (
              <>
                {label} is <b className="font-medium">{value}</b>
              </>
            ) : (
              <>
                {label}
                <ChevronDownIcon className="size-3 text-muted-foreground" aria-hidden />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] min-w-48">
          {value && (
            <>
              <DropdownMenuItem onSelect={onClear}>Clear</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
      {value && (
        <button type="button" aria-label={`Clear ${label}`} onClick={onClear} className={cn(chip, "cursor-pointer rounded-l-none border-l-0 bg-accent px-1.5")}>
          <XIcon className="size-3 text-muted-foreground" aria-hidden />
        </button>
      )}
    </span>
  );
}

const streamWords: Record<StreamState, string> = { live: "Live", connecting: "Connecting", reconnecting: "Reconnecting", closed: "Offline" };

/** Whether new entries are arriving: the Activity stream's state. */
function StreamMark() {
  const state = useStreamState();
  return (
    <span role="status" className="inline-flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 rounded-full", state === "live" ? "bg-state-done" : "bg-state-claimed")} />
      {streamWords[state]}
    </span>
  );
}

/** The mark for an entry no Member made, as when Darkory records a lapse: a square D. */
export function DarkoryMark() {
  return (
    <span
      role="img"
      aria-label="Darkory"
      className="inline-grid size-5 flex-none place-items-center rounded-[6px] border border-primary bg-primary text-[9px] leading-none font-semibold text-primary-foreground select-none"
    >
      D
    </span>
  );
}

const seconds = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** One entry: #seq, who, what in words, when. */
export function EntryRow({ entry, lookup }: { entry: Activity; lookup: Lookup }) {
  const s = describe(entry, lookup);
  if (!s) return null;
  const actor = s.actorId ? lookup.members.get(s.actorId) : undefined;
  const at = new Date(entry.at);
  return (
    <li
      className="grid h-[34px] grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 border-b pr-4 pl-6 hover:bg-accent md:grid-cols-[40px_20px_minmax(0,1fr)_auto]"
      data-seq={entry.seq}
    >
      <span className="hidden text-right font-mono text-[11px] text-muted-foreground tabular-nums md:block">#{entry.seq}</span>
      {actor ? <MemberAvatar member={actor} /> : s.actorId ? <span /> : <DarkoryMark />}
      <Words s={s} />
      <time dateTime={entry.at} title={full.format(at)} className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {seconds.format(at)}
      </time>
    </li>
  );
}

const markIcons = { lapsed: HeartPulseIcon, taken_back: RotateCcwIcon, handed_over: HandIcon } as const;
const markTones = { lapsed: "dropped", taken_back: "claimed", handed_over: "waiting" } as const;

function Words({ s }: { s: Sentence }) {
  const peek = usePeekLink();
  const Icon = s.mark && markIcons[s.mark];
  return (
    <span className="min-w-0 truncate">
      <b className="font-medium">{s.actorName}</b>{" "}
      {s.mark && Icon && (
        <>
          <Pill tone={markTones[s.mark]} className="align-[1px]">
            <Icon className="size-3" aria-hidden />
            {markWords[s.mark]}
          </Pill>{" "}
        </>
      )}
      {s.verb && <>{s.verb} </>}
      {s.subject?.type === "text" && <>{s.subject.text} </>}
      {s.subject && s.subject.type !== "text" && (
        <>
          <Link
            to={s.subject.type === "task" ? peek(s.subject.key) : `/features/${encodeURIComponent(s.subject.key)}`}
            className="group/subject hover:underline"
          >
            <Key className="group-hover/subject:text-foreground">{s.subject.key}</Key> <span className="font-medium">{s.subject.title}</span>
          </Link>{" "}
        </>
      )}
      {s.after && <>{s.after} </>}
      {s.outcome && (
        <>
          <Pill tone={s.outcome === "worked" ? "done" : "blocked"} className="align-[1px]">
            {s.outcome === "worked" ? "Worked" : "Didn't work"}
          </Pill>{" "}
        </>
      )}
      {s.evidence && (
        <a
          href={evidenceURL(s.evidence.id)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-[22px] items-center gap-1 rounded-md border px-2 align-middle text-xs hover:bg-accent"
        >
          <PaperclipIcon className="size-3" aria-hidden />
          {s.evidence.filename}
          {s.evidence.size !== undefined && <span className="ml-1 text-muted-foreground">{sizeText(s.evidence.size)}</span>}
        </a>
      )}
      {s.details.length > 0 && <span className="text-muted-foreground">· {s.details.join(" · ")}</span>}
    </span>
  );
}
