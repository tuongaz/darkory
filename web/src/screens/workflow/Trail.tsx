import { ActivityIcon, PanelRightCloseIcon } from "lucide-react";
import { useState } from "react";
import { useStreamState, type StreamState } from "@/api/live";
import { MemberAvatar } from "@/components/MemberAvatar";
import { SystemMark } from "@/components/Timeline";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { lineText, type TrailLine, type TrailPart } from "./flowEvents";
import type { TrailFocus, useTrail } from "./useTrail";

const streamWords: Record<StreamState, string> = { live: "Live", connecting: "Connecting", reconnecting: "Reconnecting", closed: "Offline" };

/** The trail's head: how many Tasks are worked now, and whether the stream is live. */
function Head({ working, onCollapse }: { working: number; onCollapse?: () => void }) {
  const state = useStreamState();
  return (
    <div className="flex h-10 flex-none items-center gap-2 border-b px-3">
      <span className="font-semibold">Live</span>
      <span className="text-xs text-muted-foreground tabular-nums">{working} working now</span>
      <span role="status" className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 rounded-full", state === "live" ? "bg-state-done" : "bg-state-claimed")} />
        {streamWords[state]}
      </span>
      {onCollapse && (
        <Button variant="ghost" size="icon-xs" aria-label="Hide the trail" onClick={onCollapse}>
          <PanelRightCloseIcon />
        </Button>
      )}
    </div>
  );
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function Part({ part, onOpenTask }: { part: TrailPart; onOpenTask: (key: string) => void }) {
  if (typeof part === "string") return <>{part}</>;
  if ("key" in part) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenTask(part.key);
        }}
        className="font-mono text-[11.5px] font-medium whitespace-nowrap text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {part.key}
      </button>
    );
  }
  if ("step" in part) return <span className="font-medium text-foreground">{part.name}</span>;
  return <span className="rounded-full border px-1.5 text-2xs leading-[16px] whitespace-nowrap">{part.outcome}</span>;
}

/** One line: the Member's mark (Darkory's when it acted), the words, the time. */
function Row({
  line,
  fresh,
  pinned,
  onFocus,
  onPin,
  onOpenTask,
}: {
  line: TrailLine;
  fresh: boolean;
  pinned: boolean;
  onFocus: (focus: TrailFocus | undefined) => void;
  onPin: () => void;
  onOpenTask: (key: string) => void;
}) {
  const focus = { steps: line.steps, taskId: line.taskId };
  const at = new Date(line.at);
  return (
    <li
      data-seq={line.seq}
      data-fresh={fresh || undefined}
      aria-label={lineText(line)}
      aria-current={pinned || undefined}
      tabIndex={0}
      onMouseEnter={() => onFocus(focus)}
      onMouseLeave={() => onFocus(undefined)}
      onFocus={() => onFocus(focus)}
      onBlur={() => onFocus(undefined)}
      onClick={onPin}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onPin();
      }}
      className={cn(
        "flow-trail-row grid cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-2 border-b px-3 py-2 text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        pinned && "bg-accent",
      )}
    >
      {line.who ? <MemberAvatar member={line.who} /> : <SystemMark />}
      <p className="min-w-0 leading-5 text-muted-foreground">
        {line.parts.map((part, i) => {
          const glue = i > 0 && !(typeof part === "string" && part.startsWith("'"));
          return (
            <span key={i}>
              {glue && " "}
              {i === 0 && typeof part === "string" ? <span className="font-medium text-foreground">{part}</span> : <Part part={part} onOpenTask={onOpenTask} />}
            </span>
          );
        })}
        {line.detail && <span> · {line.detail}</span>}
      </p>
      <time dateTime={line.at} title={full.format(at)} className="leading-5 whitespace-nowrap text-muted-foreground tabular-nums">
        {clock.format(at)}
      </time>
    </li>
  );
}

/** The lines, or that nothing has moved yet. */
function Lines({
  trail,
  onFocus,
  onOpenTask,
}: {
  trail: ReturnType<typeof useTrail>;
  onFocus: (focus: TrailFocus | undefined) => void;
  onOpenTask: (key: string) => void;
}) {
  const [pinned, setPinned] = useState<number | undefined>();
  const pinnedLine = trail.lines.find((l) => l.seq === pinned);
  // A pinned row keeps its Steps lit once the pointer leaves it.
  const focus = (f: TrailFocus | undefined) => onFocus(f ?? (pinnedLine ? { steps: pinnedLine.steps, taskId: pinnedLine.taskId } : undefined));
  if (trail.loading) return <Skeleton aria-label="Loading the trail" className="m-3 h-24" />;
  if (trail.lines.length === 0) return <p className="px-3 py-4 text-xs text-muted-foreground">No Task has moved yet. Each one shows here as it happens.</p>;
  return (
    <ol aria-label="Trail" className="flex min-h-0 flex-col overflow-y-auto">
      {trail.lines.map((l) => (
        <Row
          key={l.seq}
          line={l}
          fresh={trail.fresh.has(l.seq)}
          pinned={pinned === l.seq}
          onFocus={focus}
          onPin={() => {
            const next = pinned === l.seq ? undefined : l.seq;
            setPinned(next);
            onFocus(next === undefined ? undefined : { steps: l.steps, taskId: l.taskId });
          }}
          onOpenTask={onOpenTask}
        />
      ))}
    </ol>
  );
}

const collapsedKey = "darkory.workflow.trail.hidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(collapsedKey) === "1";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(collapsedKey, "1");
    else localStorage.removeItem(collapsedKey);
  } catch {
    // A browser that keeps nothing shows the trail each time.
  }
}

/**
 * The live trail beside the canvas: a rail on the right that hides to a button (remembered in this
 * browser); on a phone, a bottom sheet the "Live" button opens. Its head counts the Tasks worked
 * now and says whether the stream is live.
 */
export function Trail({
  trail,
  working,
  onFocus,
  onOpenTask,
}: {
  trail: ReturnType<typeof useTrail>;
  working: number;
  onFocus: (focus: TrailFocus | undefined) => void;
  onOpenTask: (key: string) => void;
}) {
  const mobile = useIsMobile();
  const [hidden, setHidden] = useState(readHidden);
  const [sheet, setSheet] = useState(false);
  const state = useStreamState();
  const hide = (h: boolean) => {
    setHidden(h);
    writeHidden(h);
    if (h) onFocus(undefined);
  };
  const newest = trail.lines[0];
  const opener = (onClick: () => void, label: string) => (
    <Button variant="outline" size="sm" aria-label={label} onClick={onClick} className="absolute right-3 bottom-3 z-10 gap-1.5 bg-background shadow-pop sm:top-3 sm:bottom-auto">
      <span aria-hidden className={cn("size-1.5 rounded-full", state === "live" ? "bg-state-done" : "bg-state-claimed")} />
      Live
      <span className="text-muted-foreground tabular-nums">· {working} working</span>
      {newest && trail.fresh.has(newest.seq) && <ActivityIcon aria-hidden className="text-muted-foreground" />}
    </Button>
  );

  if (mobile) {
    return (
      <>
        {opener(() => setSheet(true), "Show the trail")}
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent side="bottom" className="max-h-[70vh] gap-0 p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Live</SheetTitle>
              <SheetDescription>This Project's Tasks moving through its Workflow, newest first.</SheetDescription>
            </SheetHeader>
            <Head working={working} />
            <Lines
              trail={trail}
              onFocus={onFocus}
              onOpenTask={(key) => {
                setSheet(false);
                onOpenTask(key);
              }}
            />
          </SheetContent>
        </Sheet>
      </>
    );
  }
  if (hidden) return opener(() => hide(false), "Show the trail");
  return (
    <aside aria-label="Live trail" className="flex w-[320px] flex-none flex-col border-l bg-background">
      <Head working={working} onCollapse={() => hide(true)} />
      <Lines trail={trail} onFocus={onFocus} onOpenTask={onOpenTask} />
    </aside>
  );
}
