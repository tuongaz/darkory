import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link } from "react-router";
import type { Project, Task } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { useActivity, useDirectory, useRunnerSession } from "@/api/queries";
import { projectPath } from "@/app/currentProject";
import { usePeekLink } from "@/app/peek";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { TaskGlyph } from "@/screens/inbox/parts";
import { liveClaim } from "@/work";
import { startOfDay } from "@/screens/inbox/derive";
import type { FlowContext } from "../flowEvents";
import { ageText } from "./needs";
import { entriesOf, segmentsOf, type Story } from "./stories";
import { useMarkSeenOnLeave } from "./useSeen";
import { useStories } from "./useStories";

type Hover = (taskId: string | null) => void;

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const seconds = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dayClock = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "13:12" today, "yesterday 17:02", "6 Oct 17:02" before. */
function whenText(at: string, now: number): string {
  const d = new Date(at);
  const today = startOfDay(now);
  if (d.getTime() >= today) return clock.format(d);
  if (d.getTime() >= startOfDay(today - 1)) return `yesterday ${clock.format(d)}`;
  return dayClock.format(d);
}

/**
 * What's happening, beside Needs you: one story per Task that changed today, newest change first,
 * each leading with its holder's mark (or its Task's glyph), its latest change in the glossary's
 * words and its path today ("Build 31m → QA · waited 7m"). The rows since the Member last looked
 * sit above "Since you looked · HH:MM" on two lines, the older ones below on one. A row opens in
 * place into its Task's path; hovering one tells the page which Task to ring on the line. When
 * nothing has changed for an hour nor since they looked, it folds to one line, which opens it.
 */
export function StoriesPanel({ project, onHover, onOpen }: { project: Project; onHover: Hover; onOpen?: (taskId: string | null) => void }) {
  const s = useStories(project);
  const now = useNow();
  const mobile = useIsMobile();
  useMarkSeenOnLeave(project.key, s.newestSeq);
  const [opened, setOpenedRow] = useState<string | null>(null);
  const open = (id: string | null) => {
    setOpenedRow(id);
    onOpen?.(id);
  };
  useEffect(() => {
    if (!opened) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenedRow(null);
        onOpen?.(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opened, onOpen]);
  // Leaving the page forgets that the quiet column was opened by hand.
  const setOpened = s.setOpened;
  useEffect(() => () => setOpened(false), [setOpened]);

  const all = <Link to={projectPath(project, "activity")} className="ml-auto text-xs font-medium whitespace-nowrap underline underline-offset-2 hover:text-foreground">{mobile ? "All →" : "All activity →"}</Link>;

  if (s.error && s.stories.length === 0) return <Refusal error={s.error} className="p-4" />;
  if (s.loading) {
    return (
      <section aria-label="What's happening" aria-busy className="flex flex-col gap-2 px-4 py-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-10 w-full" />
      </section>
    );
  }

  if (s.quiet) {
    const l = s.latest;
    return (
      <section aria-label="What's happening" className="flex h-10 items-center gap-2.5 border-b px-5 text-[12.5px] whitespace-nowrap max-sm:px-4">
        <button
          type="button"
          onClick={() => s.setOpened(true)}
          aria-label="Open What's happening"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:underline focus-visible:outline-none"
        >
          <b className="font-semibold">What's happening</b>
          <span className="text-muted-foreground">{l ? `Quiet since ${whenText(l.latest.at, now)}` : "Nothing has happened yet"}</span>
          {l && (
            <>
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
              <StoryMark story={l} />
              <Key>{l.key}</Key>
              <span className="truncate">{l.title}</span>
              <span className="truncate text-muted-foreground max-sm:hidden">
                {l.verb}
                {l.path.at(-1)?.current && ` → ${l.path.at(-1)!.name}`}
              </span>
            </>
          )}
        </button>
        {all}
      </section>
    );
  }

  const fresh = s.stories.filter((x) => x.fresh);
  const older = s.stories.filter((x) => !x.fresh);
  const divider = s.seen?.seq != null && s.seen.at;
  const row = (x: Story, compact: boolean) =>
    opened === x.taskId ? (
      <OpenedStory key={x.taskId} project={project} story={x} ctx={s.ctx} tasks={s.tasks} onClose={() => open(null)} onHover={onHover} />
    ) : (
      <StoryRow key={x.taskId} story={x} compact={compact} trim={mobile} onHover={onHover} onClick={() => open(x.taskId)} />
    );
  return (
    <section aria-label="What's happening" className="flex h-full min-h-0 flex-col px-4 pt-3 pb-2">
      <h2 className="mb-1.5 flex h-[22px] items-center gap-2 text-[13px] font-semibold">
        What's happening
        <span className="font-medium text-muted-foreground tabular-nums">
          {mobile ? `${fresh.length} new` : `${s.stories.length} Task${s.stories.length === 1 ? "" : "s"}`}
        </span>
        {all}
      </h2>
      <ol aria-label="Stories" className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2">
        {s.stories.length === 0 && <li className="py-2 text-xs text-muted-foreground">Nothing has moved today.</li>}
        {fresh.map((x) => row(x, false))}
        {divider && (
          <li role="separator" aria-label={`Since you looked at ${clock.format(new Date(s.seen!.at!))}`} className="my-0.5 flex h-[22px] items-center gap-2 text-[11px] text-muted-foreground before:flex-1 before:border-t after:flex-1 after:border-t">
            Since you looked · <b className="font-semibold text-foreground">{clock.format(new Date(s.seen!.at!))}</b>
          </li>
        )}
        {older.map((x) => row(x, true))}
      </ol>
    </section>
  );
}

/** A story's lead: its holder's mark, ringed by how they work, or the Task's own glyph. */
function StoryMark({ story }: { story: Story }) {
  const now = useNow();
  const { members } = useDirectory();
  const session = useRunnerSession(story.task?.id);
  const claim = story.task && liveClaim(story.task, now);
  const holder = claim && members.get(claim.holder_id);
  if (holder) return <MemberAvatar member={holder} size="sm" working={holder.kind === "agent" ? (session?.state ?? "running") : "held"} />;
  if (story.task) return <TaskGlyph task={story.task} />;
  return <span className="size-3.5" />;
}

/** "Build 31m → QA 15m → Review": the Steps, the current one bold; on a phone the earliest give way to "…". */
function Path({ story, trim }: { story: Story; trim?: boolean }) {
  const steps = trim && story.path.length > 2 ? story.path.slice(-2) : story.path;
  return (
    <span className="min-w-0 truncate">
      {trim && steps.length < story.path.length && "… → "}
      {steps.map((p, i) => (
        <span key={`${p.stepId}-${i}`}>
          {i > 0 && " → "}
          {p.current ? <b className="font-medium text-foreground">{p.name}</b> : <span>{`${p.name}${p.ms !== undefined ? ` ${ageText(p.ms)}` : ""}`}</span>}
        </span>
      ))}
      {story.tail && `${steps.length ? " · " : ""}${story.tail}`}
    </span>
  );
}

function Time({ story }: { story: Story }) {
  if (story.now) return <span className="font-semibold text-state-claimed">now</span>;
  return <time dateTime={story.latest.at}>{clock.format(new Date(story.latest.at))}</time>;
}

function Nudged() {
  return <span className="rounded-full border px-1.5 text-[10.5px] leading-4 whitespace-nowrap text-muted-foreground">nudged</span>;
}

/** One story: two lines above the divider (key and title; the change and the path), one below. */
function StoryRow({ story, compact, trim, onHover, onClick }: { story: Story; compact: boolean; trim?: boolean; onHover: Hover; onClick: () => void }) {
  const label = `${story.key} ${story.title}: ${story.verb}`;
  const common = {
    "data-story": story.key,
    "data-fresh": story.fresh || undefined,
    tabIndex: 0,
    "aria-label": label,
    onMouseEnter: () => onHover(story.taskId),
    onMouseLeave: () => onHover(null),
    onFocus: () => onHover(story.taskId),
    onBlur: () => onHover(null),
    onClick,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      onClick();
    },
  };
  if (compact) {
    return (
      <li
        {...common}
        className="-mx-2 grid h-[30px] cursor-pointer grid-cols-[24px_minmax(0,1fr)_auto_44px] items-center gap-x-2 rounded-md px-2 text-[12.5px] outline-none hover:bg-muted focus-visible:bg-muted"
      >
        <span className="grid place-items-center">
          <StoryMark story={story} />
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
          <Key>{story.key}</Key>
          <span className="truncate text-muted-foreground">{story.title}</span>
        </span>
        <span className="flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-muted-foreground">
          {story.verb}
          {story.nudged && <Nudged />}
        </span>
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          <Time story={story} />
        </span>
      </li>
    );
  }
  return (
    <li
      {...common}
      className={cn(
        "-mx-2 grid h-[42px] cursor-pointer grid-cols-[24px_minmax(0,1fr)_44px] items-center gap-x-2 rounded-md px-2 outline-none hover:bg-muted focus-visible:bg-muted",
        story.now && "bg-state-claimed-bg hover:bg-state-claimed-bg",
      )}
    >
      <span className="grid place-items-center">
        <StoryMark story={story} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
          <Key>{story.key}</Key>
          <span className="truncate">{story.title}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap text-muted-foreground">
          <span className="font-medium text-foreground">{story.verb}</span>
          {story.nudged && <Nudged />}
          <Path story={story} trim={trim} />
        </span>
      </span>
      <span className="self-start pt-[5px] text-right text-xs text-muted-foreground tabular-nums">
        <Time story={story} />
      </span>
    </li>
  );
}

const hatch = (color: string): CSSProperties => ({
  border: `1px solid var(${color})`,
  background: `repeating-linear-gradient(135deg, var(${color}) 0 1.2px, var(--background) 1.2px 4px)`,
});

/**
 * A story opened into its Task's path: a bar from its first change today to now, each Step's stay
 * hatched while it waited (red while blocked) and solid while it was worked, the live edge marked;
 * under it the entries with their clocks, and "Open KEY →".
 */
function OpenedStory({
  project,
  story,
  ctx,
  tasks,
  onClose,
  onHover,
}: {
  project: Project;
  story: Story;
  ctx: FlowContext;
  tasks: Map<string, Task>;
  onClose: () => void;
  onHover: Hover;
}) {
  const now = useNow();
  const peek = usePeekLink();
  const history = useActivity({ project: project.key, task: story.key, limit: 200 });
  const live = useLiveEntries();
  const own = useMemo(() => {
    const bySeq = new Map((history.data?.items ?? []).map((e) => [e.seq, e]));
    // What the stream brought since: the Task's entries, and a Parent's Subtasks', as `?task=` keeps them.
    for (const e of live) if (e.subject_id === story.taskId || tasks.get(e.subject_id)?.parent_id === story.taskId) bySeq.set(e.seq, e);
    return [...bySeq.values()];
  }, [history.data, live, story.taskId, tasks]);
  const from = startOfDay(now);
  const { segments, stays } = useMemo(() => segmentsOf(own, story.task, ctx, now, from), [own, story.task, ctx, now, from]);
  const entries = useMemo(() => entriesOf(own, story.task, ctx, now).filter((e) => Date.parse(e.at) >= from || e.live), [own, story.task, ctx, now, from]);
  const start = Math.min(...segments.map((g) => g.from), now);
  const span = Math.max(1, now - start);
  const at = (t: number) => `${((t - start) / span) * 100}%`;
  return (
    <li
      data-story={story.key}
      data-opened
      aria-label={`${story.key} ${story.title}: its path`}
      onMouseEnter={() => onHover(story.taskId)}
      onMouseLeave={() => onHover(null)}
      className="-mx-2 my-0.5 rounded-lg bg-muted px-2 pb-2.5"
    >
      <button type="button" onClick={onClose} aria-expanded className="grid h-[42px] w-full grid-cols-[24px_minmax(0,1fr)_44px] items-center gap-x-2 text-left outline-none focus-visible:underline">
        <span className="grid place-items-center">
          <StoryMark story={story} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
            <Key>{story.key}</Key>
            <span className="truncate">{story.title}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap text-muted-foreground">
            <span className="font-medium text-foreground">{story.verb}</span>
            <Path story={story} />
          </span>
        </span>
        <span className="self-start pt-[5px] text-right text-xs text-muted-foreground tabular-nums">
          <Time story={story} />
        </span>
      </button>
      {history.isPending ? (
        <Skeleton className="h-6 w-full" />
      ) : history.isError ? (
        <Refusal error={history.error} />
      ) : (
        <>
          <div aria-hidden className="relative mt-1 h-[26px]">
            {stays.map((s, i) => (
              <span key={`l-${i}`} className="absolute top-0 text-[10.5px] font-medium whitespace-nowrap" style={{ left: at(s.from) }}>
                {s.name}
                <i className="ml-[3px] text-muted-foreground not-italic font-normal">{ageText(s.to - s.from)}</i>
              </span>
            ))}
            {segments.map((g, i) => (
              <span
                key={`s-${i}`}
                data-segment={g.kind}
                className={cn("absolute top-[13px] h-2.5 rounded-[2px]", g.kind === "work" && "bg-state-claimed", g.live && "shadow-[inset_-2px_0_0_var(--foreground)]")}
                style={{ left: at(g.from), width: `calc(${at(g.to)} - ${at(g.from)})`, ...(g.kind === "wait" ? hatch("--state-waiting") : g.kind === "blocked" ? hatch("--state-blocked") : {}) }}
              />
            ))}
          </div>
          <ol aria-label={`${story.key}'s entries`} className="mt-1.5 flex flex-col gap-1 text-xs">
            {entries.map((e) => (
              <li key={e.seq} className={cn("grid grid-cols-[66px_minmax(0,1fr)] gap-2", e.live && story.task && liveClaim(story.task, now) && "text-state-claimed")}>
                <span className="text-muted-foreground tabular-nums">{e.live && !e.text.endsWith("picked up") ? seconds.format(now) : seconds.format(new Date(e.at))}</span>
                <span className="min-w-0">
                  {e.text}
                  {e.count && e.count > 1 && ` ×${e.count}`}
                  {e.detail && <span className="text-muted-foreground"> · {e.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-1.5 flex justify-end">
            <Link to={peek(story.key)} className="text-[11.5px] font-medium underline underline-offset-2">
              Open {story.key} →
            </Link>
          </div>
        </>
      )}
    </li>
  );
}
