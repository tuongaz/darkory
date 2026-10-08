import { EllipsisIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { Project } from "@/api/client";
import { usePeekLink } from "@/app/peek";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkGlyph } from "@/components/WorkGlyph";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useAgentActions } from "@/screens/inbox/useAgentActions";
import { useTakeBack } from "./acts";
import { AnsweredLine, NeedCard, type Answered } from "./NeedCard";
import { ageText, type AgentNeed, type NeedItem } from "./needs";
import { useNeeds } from "./useNeeds";

/** How many cards Needs you shows at rest; the rest wait behind "+N more". */
export const atRest = 3;
/** How long the green "Answered" line stands in for a question. */
const answeredMs = 6_000;

type Hover = (taskId: string | null) => void;

/**
 * Needs you, under the Workflow's line: the decisions in this Project that wait on the signed-in
 * Member, as cards in the order to act on them (what unblocks most first, then what only they can
 * move, then the rest, oldest first), three at rest with "+N more" in the header; under them the
 * agents whose sessions wait on someone, with Take back and Stop session. On a phone, the first
 * card and a line that opens the rest as a sheet. Hovering a card or an agent's row tells the page
 * which Task to ring on the line.
 */
export function NeedsYouPanel({ project, onHover }: { project: Project; onHover: Hover }) {
  const needs = useNeeds(project);
  const mobile = useIsMobile();
  const [more, setMore] = useState(false);
  const [answered, setAnswered] = useState<Answered[]>([]);
  useEffect(() => {
    if (answered.length === 0) return;
    const t = setTimeout(() => setAnswered((list) => list.slice(1)), Math.max(0, Date.parse(answered[0].at) + answeredMs - Date.now()));
    return () => clearTimeout(t);
  }, [answered]);
  const onAnswered = (a: Answered) => {
    setAnswered((list) => [...list, a]);
    onHover(null);
  };
  // An answered question leaves the list as its line arrives.
  const items = needs.items.filter((i) => !answered.some((a) => a.key === i.task.key));
  const hidden = Math.max(0, items.length - atRest);

  if (needs.error) return <Refusal error={needs.error} className="p-5" />;
  if (needs.loading) {
    return (
      <section aria-label="Needs you" aria-busy className="flex flex-col gap-2 px-5 py-3.5">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-20 w-full" />
      </section>
    );
  }
  const nothing = items.length === 0 && needs.agents.length === 0 && answered.length === 0;
  const head = (
    <h2 className="flex h-[22px] items-center gap-2 text-[13px] font-semibold">
      Needs you
      {!nothing && <span className="font-medium text-muted-foreground tabular-nums">{items.length}</span>}
      {hidden > 0 && !mobile && (
        <Button variant="link" size="xs" className="ml-auto h-auto px-0 text-xs font-medium text-foreground" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          {more ? "Show fewer" : `+${hidden} more`}
        </Button>
      )}
    </h2>
  );

  if (nothing) {
    return (
      <section aria-label="Needs you" className="px-5 py-3.5 max-sm:px-4">
        {head}
        <p className="mt-2 flex h-10 items-center gap-2.5 text-muted-foreground">
          <WorkGlyph glyph={{ glyph: "done" }} label="Done" />
          <b className="font-medium text-foreground">Nothing needs you</b>
        </p>
      </section>
    );
  }

  const lines = answered.map((a) => <AnsweredLine key={a.key} answered={a} />);

  if (mobile) {
    return (
      <section aria-label="Needs you" className="border-b px-4 py-3">
        <div className="mb-1.5">{head}</div>
        <div className="flex flex-col gap-2">
          {lines}
          {items[0] && <NeedCard item={items[0]} primary onHover={onHover} onAnswered={onAnswered} />}
        </div>
        {(items.length > 1 || needs.agents.length > 0) && (
          <PhoneMore items={items} agents={needs.agents} onHover={onHover} onAnswered={onAnswered} />
        )}
      </section>
    );
  }

  const shown = more ? items : items.slice(0, atRest);
  return (
    <section aria-label="Needs you" className="flex h-full min-h-0 flex-col px-5 pt-3.5 pb-2.5">
      <div className="mb-2">{head}</div>
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        {lines.length > 0 && <div className="mb-2 flex flex-col gap-2">{lines}</div>}
        <CardGrid items={shown} onHover={onHover} onAnswered={onAnswered} />
        {needs.agents.length > 0 && <Agents agents={needs.agents} onHover={onHover} />}
      </div>
    </section>
  );
}

/**
 * The cards as the final frame lays them: the first tall on the left, the next two stacked on the
 * right; more, when opened, follow two by two.
 */
function CardGrid({ items, onHover, onAnswered }: { items: NeedItem[]; onHover: Hover; onAnswered: (a: Answered) => void }) {
  if (items.length === 0) return null;
  const [first, ...rest] = items;
  const card = (i: NeedItem, n: number) => <NeedCard key={i.task.id} item={i} primary={n === 0} onHover={onHover} onAnswered={onAnswered} />;
  if (rest.length === 0) return <div className="grid grid-cols-1 @lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">{card(first, 0)}</div>;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 items-start gap-2 @lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {card(first, 0)}
        <div className="flex min-w-0 flex-col gap-2">{rest.slice(0, 2).map((i, n) => card(i, n + 1))}</div>
      </div>
      {rest.length > 2 && <div className="grid grid-cols-1 items-start gap-2 @lg:grid-cols-2">{rest.slice(2).map((i, n) => card(i, n + 3))}</div>}
    </div>
  );
}

/** "Agents need you": the sessions waiting on a decision or stalled on this Project's Tasks. */
function Agents({ agents, onHover }: { agents: AgentNeed[]; onHover: Hover }) {
  return (
    <section aria-label="Agents need you">
      <h3 className="mt-3 mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-muted-foreground">
        Agents need you <span className="font-medium tabular-nums">{agents.length}</span>
      </h3>
      {agents.map((a) => (
        <AgentRow key={`${a.agent.id}-${a.task.id}`} need={a} onHover={onHover} />
      ))}
    </section>
  );
}

/**
 * One agent's session in trouble: "reviewer · waiting on MAIN-6 · nudged", how long it has held
 * the Task, Take back when the caller may, and Stop session (an admin) under ⋯.
 */
function AgentRow({ need, onHover }: { need: AgentNeed; onHover: Hover }) {
  const now = useNow();
  const peek = usePeekLink();
  const takeBack = useTakeBack(need.task, need.agent);
  const actions = useAgentActions(need.agent);
  const since = need.task.claim?.started_at ?? need.session.started_at;
  const waiting = need.session.state === "waiting";
  return (
    <div
      data-agent-need={need.task.key}
      onMouseEnter={() => onHover(need.task.id)}
      onMouseLeave={() => onHover(null)}
      className="flex h-9 items-center gap-2 border-t text-[12.5px]"
    >
      <MemberAvatar member={need.agent} working={need.session.state} />
      <span className="min-w-0 flex-1 truncate">
        <b className="font-semibold">{need.agent.name}</b>
        <span className="text-muted-foreground">
          {" "}
          · {waiting ? "waiting on" : "stalled on"} <Key to={peek(need.task.key)}>{need.task.key}</Key>
          {waiting && " · nudged"}
        </span>
      </span>
      <span title="Held for" className="text-xs font-semibold tabular-nums">
        {ageText(now - Date.parse(since))}
      </span>
      {need.canTakeBack ? (
        <Button size="sm" variant="outline" aria-label={`Take back ${need.task.key}`} disabled={takeBack.isPending} onClick={() => takeBack.mutate()}>
          Take back
        </Button>
      ) : (
        <Button asChild size="sm" variant="outline">
          <Link to={peek(need.task.key)} aria-label={`Open ${need.task.key}`}>
            Open
          </Link>
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="outline" aria-label={`More about ${need.agent.name}'s session`}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link to={peek(need.task.key)}>Open {need.task.key}</Link>
          </DropdownMenuItem>
          {need.canStop && (
            <DropdownMenuItem variant="destructive" onSelect={() => actions.run({ label: "Stop session", session: "stop", taskKey: need.task.key })}>
              Stop session
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {actions.dialog}
    </div>
  );
}

/** On a phone: "+2 more · MAIN-5, MAIN-14 · 1 agent waiting", which opens the whole list as a sheet. */
function PhoneMore({ items, agents, onHover, onAnswered }: { items: NeedItem[]; agents: AgentNeed[]; onHover: Hover; onAnswered: (a: Answered) => void }) {
  const [open, setOpen] = useState(false);
  const rest = items.slice(1);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex h-6 w-full items-center gap-1.5 text-left text-xs text-muted-foreground focus-visible:underline focus-visible:outline-none"
      >
        {rest.length > 0 && (
          <>
            <b className="font-medium text-foreground">+{rest.length} more</b>
            <span className="truncate">· {rest.map((i) => i.task.key).join(", ")}</span>
          </>
        )}
        {agents.length > 0 && (
          <span className={cn("whitespace-nowrap", "ml-auto")}>
            {agents.length} agent{agents.length === 1 ? "" : "s"} waiting
          </span>
        )}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[80vh] gap-0 overflow-y-auto p-4">
          <SheetHeader className="p-0 pb-2">
            <SheetTitle>Needs you</SheetTitle>
            <SheetDescription className="sr-only">Every decision in this Project waiting on you, in the order to act on them.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2">
            {rest.map((i) => (
              <NeedCard key={i.task.id} item={i} onHover={onHover} onAnswered={onAnswered} />
            ))}
          </div>
          {agents.length > 0 && <Agents agents={agents} onHover={onHover} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
