import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDownIcon, HeartPulseIcon, HistoryIcon, PaperclipIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { evidenceURL, type Activity, type ActivityKind, type Project } from "@/api/client";
import { useLiveEntries, useStreamState, type StreamState } from "@/api/live";
import { newestActivity, useDirectory, useLabels } from "@/api/queries";
import { projectPath, useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { usePeekLink } from "@/app/peek";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { stepFilterSearch } from "@/components/filters/filterState";
import { EmptyState } from "@/components/EmptyState";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { SystemMark } from "@/components/Timeline";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { sizeText } from "@/screens/task/format";
import { aboutProject, count, groupByDay, matchesFilter, type ActivityFilter } from "./derive";
import { foldActivity, type ActivityRow } from "./fold";
import { activityHistoryPage, useStepNames, useTaskMap } from "./queries";
import { chipText, isKnown, kindChoices, kindName, markWords, rowSentence, type FileChip, type Lookup, type Part, type Sentence } from "./wording";
import { toShort } from "@/lib/shortid";

const pageSize = 100;

/** The search parameter of the Task filter: `?task=` opens a peek, so the filter is `?about=`. */
const aboutParam = "about";

/**
 * /projects/:key/activity: the Project's trail, newest first, by day. ?member=, ?kind= and
 * ?about= (a name, a kind, a Task's key) narrow it through /v1's filters; a Parent's entries come
 * with its Subtasks'. The stream's new entries that pass the same filters arrive at the top. Each entry links its Task (its peek), its Workflow, and the Steps it names (the Tasks
 * at that Step).
 */
export function ActivityPage() {
  const project = useRouteProject();
  const [params, setParams] = useSearchParams();
  const now = useNow();
  const dir = useDirectory();
  const tasks = useTaskMap(project.key);
  const steps = useStepNames([project]);
  const labels = useLabels(project.key).data;
  const live = useLiveEntries();

  const memberRef = params.get("member") ?? undefined;
  const kindRef = params.get("kind") ?? undefined;
  const taskRef = params.get(aboutParam) ?? undefined;
  // An id from an old link may be a UUID's long text: the API writes it short (ADR 0017).
  const member = memberRef ? dir.memberList.find((m) => m.name === memberRef || m.id === toShort(memberRef)) : undefined;
  const kind = kindRef && isKnown(kindRef) ? kindRef : undefined;
  const task = taskRef ? [...tasks.values()].find((t) => t.key.toUpperCase() === taskRef.toUpperCase() || t.id === toShort(taskRef)) : undefined;
  const filtered = !!(memberRef || kindRef || taskRef);

  const history = useInfiniteQuery({
    queryKey: ["activity", "page", { project: project.key, member: memberRef, kind: kindRef, task: taskRef }],
    queryFn: ({ pageParam }) =>
      activityHistoryPage({ project: project.key, member: memberRef, kind: kindRef ? (kindRef as ActivityKind) : undefined, task: taskRef }, pageParam, pageSize),
    initialPageParam: newestActivity,
    getNextPageParam: (page) => (page.more ? page.first_seq : undefined),
  });

  // The stream's entries that pass the filters, matched by id as /v1 matches them.
  const want: ActivityFilter = { member: member?.id, kind, task: task?.id, parentOf: (id) => tasks.get(id)?.parent_id };
  const resolved = (!memberRef || member) && (!kindRef || kind) && (!taskRef || task);
  const where = { taskProject: (id: string) => tasks.get(id)?.project_id };
  const bySeq = new Map<number, Activity>();
  for (const page of history.data?.pages ?? []) for (const e of page.items) bySeq.set(e.seq, e);
  if (resolved) for (const e of live) if (aboutProject(e, project.id, where) && matchesFilter(e, want)) bySeq.set(e.seq, e);
  const entries = [...bySeq.values()].filter((e) => isKnown(e.kind)).sort((a, b) => b.seq - a.seq);

  // Entries are numbered per Organisation with gaps under a Project, so a missed entry cannot be
  // told by its number; after a stream that was refused, the shell refreshes the reads it can, and
  // this page's history is read again when the stream comes back.
  const state = useStreamState();
  const { refetch } = history;
  const lastState = useRef(state);
  useEffect(() => {
    if (lastState.current === "closed" && state === "live") void refetch();
    lastState.current = state;
  }, [state, refetch]);

  const lookup: Lookup = useMemo(
    () => ({
      members: dir.members,
      skills: dir.skills,
      projects: dir.projects,
      tasks,
      stepName: (id) => steps.get(id)?.name,
      labels: new Map((labels ?? []).map((l) => [l.id, l])),
      claims: new Map(entries.filter((e) => e.kind === "task.claimed").map((e) => [String(e.payload.claim_id), e])),
    }),
    [dir.members, dir.skills, dir.projects, tasks, steps, labels, entries],
  );
  // The filters apply to the entries; what one actor writes on a Task inside a Claim then folds
  // into the row that ends it.
  const rows = foldActivity(entries);
  const rowOf = new Map(rows.map((r) => [r.entry.seq, r]));

  const set = (key: string, value: string | undefined) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  const clearAll = () =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      for (const k of ["member", "kind", aboutParam]) next.delete(k);
      return next;
    });

  const taskList = useMemo(() => [...tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)), [tasks]);

  return (
    <>
      <TopBar
        crumbs={[projectCrumb(project), { label: "Activity" }]}
        // The filter chips sit on the bar's second row, at its left; the Live mark at its right.
        view={
          <div role="group" aria-label="Filters" className="flex items-center gap-1.5">
            <FilterChip label="Member" value={memberRef && (member?.name ?? memberRef)} onClear={() => set("member", undefined)}>
              <DropdownMenuRadioGroup value={member?.name ?? ""} onValueChange={(v) => set("member", v)}>
                {dir.memberList
                  .filter((m) => !m.deactivated_at)
                  .map((m) => (
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
            <TaskChip value={taskRef && (task?.key ?? taskRef)} tasks={taskList} onPick={(key) => set(aboutParam, key)} onClear={() => set(aboutParam, undefined)} />
          </div>
        }
        actions={<StreamMark />}
      />
      <Content>
        <h1 className="sr-only">Activity</h1>
        {history.isError ? (
          <Refusal error={history.error} className="px-6 py-5" />
        ) : history.isPending ? (
          <div className="flex flex-col gap-2 px-6 py-5" aria-busy>
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<HistoryIcon />}
            title={filtered ? "No entries" : "No Activity"}
            action={
              filtered ? (
                <div className="flex gap-2">
                  {history.hasNextPage && (
                    <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
                      Load older
                    </Button>
                  )}
                  <Button variant="outline" onClick={clearAll}>
                    Clear filters
                  </Button>
                </div>
              ) : undefined
            }
          >
            {filtered ? undefined : `Nothing has happened in ${project.name} yet.`}
          </EmptyState>
        ) : (
          <ol aria-label="Activity" aria-live="polite" aria-relevant="additions">
            {groupByDay(
              rows.map((r) => r.entry),
              now,
            ).map((g) => (
              <li key={g.key}>
                <h2 className="sticky top-0 z-10 flex h-[34px] items-center border-b bg-muted pr-4 pl-4 font-medium md:pl-6">{g.label}</h2>
                <ol>
                  {g.entries.map((e) => (
                    <EntryRow key={e.seq} row={rowOf.get(e.seq)!} lookup={lookup} project={project} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </Content>
      {history.isSuccess && entries.length > 0 && (
        // The same words whether or not there is more: "100 entries · Load older".
        <footer className="flex h-10 flex-none items-center gap-1.5 border-t pr-4 pl-4 text-xs text-muted-foreground md:pl-6">
          <span>
            {count(entries.length, "entry", "entries")}
            {rows.length < entries.length && ` · ${count(rows.length, "row")}`}
          </span>
          {history.hasNextPage && (
            <>
              <span aria-hidden>·</span>
              <Button
                size="xs"
                variant="link"
                className="h-auto px-0 text-xs text-foreground"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                Load older
              </Button>
            </>
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

/** The chip's face: "Member" ▾ unset; "Member is builder" once set. */
function ChipFace({ label, value }: { label: string; value: string | undefined }) {
  return value ? (
    <>
      {label} is <b className="font-medium">{value}</b>
    </>
  ) : (
    <>
      {label}
      <ChevronDownIcon className="size-3 text-muted-foreground" aria-hidden />
    </>
  );
}

/** The × beside a set chip. */
function ClearChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button type="button" aria-label={`Clear ${label}`} onClick={onClear} className={cn(chip, "cursor-pointer rounded-l-none border-l-0 bg-accent px-1.5")}>
      <XIcon className="size-3 text-muted-foreground" aria-hidden />
    </button>
  );
}

/** A filter (kit `.chip`): "Member" with a one-select menu; once set, "Member is builder" and × to clear it. */
function FilterChip({ label, value, onClear, children }: { label: string; value: string | undefined; onClear: () => void; children: ReactNode }) {
  return (
    <span className={cn("inline-flex flex-none items-center", value && "rounded-md bg-accent")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={cn(chip, "cursor-pointer hover:bg-accent", value && "rounded-r-none border-r-0 bg-accent")}>
            <ChipFace label={label} value={value} />
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
      {value && <ClearChip label={label} onClear={onClear} />}
    </span>
  );
}

/** The Task filter: the Project's Tasks, searched by key or title. */
function TaskChip({
  value,
  tasks,
  onPick,
  onClear,
}: {
  value: string | undefined;
  tasks: { id: string; key: string; title: string }[];
  onPick: (key: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className={cn("inline-flex flex-none items-center", value && "rounded-md bg-accent")}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={cn(chip, "cursor-pointer hover:bg-accent", value && "rounded-r-none border-r-0 bg-accent")}>
            <ChipFace label="Task" value={value} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Task" className="w-80 p-0">
          <Command>
            <CommandInput placeholder="Search keys and titles" />
            <CommandList className="max-h-[min(360px,60vh)]">
              <CommandEmpty>No matches</CommandEmpty>
              <CommandGroup>
                {tasks.map((t) => (
                  <CommandItem
                    key={t.id}
                    value={`${t.key} ${t.title}`}
                    onSelect={() => {
                      onPick(t.key);
                      setOpen(false);
                    }}
                  >
                    <Key>{t.key}</Key>
                    <span className="truncate">{t.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && <ClearChip label="Task" onClear={onClear} />}
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

const seconds = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** One row: who, what in words (with what the Claim it ends carried), when. */
function EntryRow({ row, lookup, project }: { row: ActivityRow; lookup: Lookup; project: Project }) {
  const entry = row.entry;
  const s = rowSentence(row, lookup);
  if (!s) return null;
  const actor = s.actorId ? lookup.members.get(s.actorId) : undefined;
  const at = new Date(entry.at);
  return (
    <li className="grid min-h-[34px] grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 border-b py-1 pr-4 pl-4 hover:bg-accent md:pl-6" data-seq={entry.seq}>
      {actor ? <MemberAvatar member={actor} /> : s.actorId ? <span /> : <SystemMark />}
      <Words s={s} project={project} />
      <time dateTime={entry.at} title={full.format(at)} className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {seconds.format(at)}
      </time>
    </li>
  );
}

const markIcons = { lapsed: HeartPulseIcon, taken_back: RotateCcwIcon } as const;
const markTones = { lapsed: "dropped", taken_back: "claimed" } as const;

/** The Tasks at a Step: the Project's list filtered by it. */
function stepLink(project: Project, step: string): string {
  return `${projectPath(project, "tasks")}?${stepFilterSearch(step)}`;
}

function AfterPart({ part, project }: { part: Part; project: Project }) {
  if (typeof part === "string") return <>{part} </>;
  if ("step" in part) {
    return (
      <>
        <Link to={stepLink(project, part.step)} className="font-medium hover:underline">
          {part.name}
        </Link>{" "}
      </>
    );
  }
  return (
    <>
      <Pill tone="outline" className="align-[1px]">
        {part.outcome}
      </Pill>{" "}
    </>
  );
}

function Words({ s, project }: { s: Sentence; project: Project }) {
  const peek = usePeekLink();
  const Icon = s.mark && markIcons[s.mark];
  return (
    <span className="min-w-0 truncate md:whitespace-nowrap">
      <b className="font-medium">{s.actorName}</b>{" "}
      {s.log && (
        <>
          <span className="text-muted-foreground">·</span> <FileLink chip={{ id: s.log.id, filename: "", size: s.log.size, log: true }} /> on{" "}
        </>
      )}
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
      {s.subject?.type === "workflow" && (
        <>
          <Link to={projectPath(project, "workflows")} className="font-medium hover:underline">
            the Workflows
          </Link>{" "}
        </>
      )}
      {s.subject?.type === "task" && (
        <>
          <Link to={peek(s.subject.key)} className="group/subject hover:underline">
            <Key className="group-hover/subject:text-foreground">{s.subject.key}</Key> <span className="font-medium">{s.subject.title}</span>
          </Link>{" "}
        </>
      )}
      {s.after.map((part, i) => (
        <AfterPart key={i} part={part} project={project} />
      ))}
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
      {s.files?.map((f) => (
        <span key={f.id}>
          {" "}
          <span className="text-muted-foreground">·</span> <FileLink chip={f} />
        </span>
      ))}
    </span>
  );
}

/** A file a row links, as a chip: "📎 wc.log 753 B", "📎 Shift log · 56.8 kB". */
function FileLink({ chip: c }: { chip: FileChip }) {
  return (
    <a
      href={evidenceURL(c.id)}
      target="_blank"
      rel="noreferrer"
      title={c.log ? c.filename || undefined : undefined}
      className="inline-flex h-[22px] items-center gap-1 rounded-md border px-2 align-middle text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <PaperclipIcon className="size-3" aria-hidden />
      {chipText(c)}
    </a>
  );
}
