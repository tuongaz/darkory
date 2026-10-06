// /teams/:team/features (F-B3): a Team's Features in Rank order with their owner and Task bar.
// Dragging the grip re-ranks; the Display shows ended Features, dimmed, in their places.
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { EllipsisIcon, FilterIcon, GripVerticalIcon, LayersIcon, PlusIcon, SearchXIcon, SlidersHorizontalIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { Feature } from "@/api/client";
import { useDirectory, useTeams } from "@/api/queries";
import { sendIntent } from "@/app/intents";
import { Content, TopBar } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { TeamMark } from "@/components/TeamMark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { countsText, moveFeature, rankPosition, taskBar } from "./derive";
import { useRankFeature, useTeamFeatures } from "./queries";
import { FilterChips } from "./ViewMenus";

// grip · # · key · title · owner · Task bar · counts · ⋯; on a phone the owner, bar and counts go.
const rowGrid =
  "grid grid-cols-[16px_24px_56px_minmax(0,1fr)_28px] md:grid-cols-[16px_24px_56px_minmax(0,1fr)_150px_160px_176px_28px]";

export function TeamFeaturesPage() {
  const { team: teamRef = "" } = useParams();
  const teams = useTeams();
  const team = teams.data?.find((t) => t.key === teamRef || t.id === teamRef);
  const features = useTeamFeatures(team?.key);
  const { members, memberList } = useDirectory();
  const me = useCurrentMe();
  const [params, setParams] = useSearchParams();
  const showEnded = params.get("ended") === "1";
  const ownerName = params.get("owner") ?? undefined;
  const setParam = (k: string, v: string | undefined) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (v) next.set(k, v);
        else next.delete(k);
        return next;
      },
      { replace: true },
    );

  const ranked = useMemo(() => features.data ?? [], [features.data]);
  const ownerId = ownerName ? (memberList.find((m) => m.name === ownerName)?.id ?? "?") : undefined;
  const shown = ranked.filter((f) => (showEnded || f.state === "open") && (!ownerId || f.owner_id === ownerId));
  const owners = [...new Set(ranked.map((f) => f.owner_id))].flatMap((id) => {
    const m = members.get(id);
    return m ? [m] : [];
  });
  const inTeam = !!team && me.teams.some((t) => t.id === team.id);

  const top = (
    <>
      <h1 className="sr-only">Features</h1>
      <TopBar
        crumbs={[{ label: team?.name ?? teamRef, icon: team ? <TeamMark team={team} /> : undefined }, { label: "Features" }]}
        actions={
          team && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" aria-label="Filter" className={cn(ownerName && "bg-accent")}>
                    <FilterIcon />
                    <span className="hidden sm:inline">Filter</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <div className="px-2 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground">Owner</div>
                  <DropdownMenuRadioGroup value={ownerName ?? ""} onValueChange={(v) => setParam("owner", v || undefined)}>
                    {owners.map((m) => (
                      <DropdownMenuRadioItem key={m.id} value={m.name}>
                        <MemberAvatar member={m} />
                        {m.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  {ownerName && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setParam("owner", undefined)}>Clear</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" aria-label="Display" className="data-[state=open]:bg-accent">
                    <SlidersHorizontalIcon />
                    <span className="hidden sm:inline">Display</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" aria-label="Display" className="w-[260px] p-1">
                  <div className="px-2 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground">Show</div>
                  <label className="flex h-[30px] cursor-pointer items-center gap-2 rounded-[6px] px-2 hover:bg-accent">
                    Shipped and dropped
                    <Switch
                      aria-label="Shipped and dropped"
                      checked={showEnded}
                      onCheckedChange={(on) => setParam("ended", on ? "1" : undefined)}
                      className="ml-auto"
                    />
                  </label>
                </PopoverContent>
              </Popover>
            </>
          )
        }
        primary={
          <Button onClick={() => sendIntent({ kind: "file-feature", team: team?.key })} aria-label="File Feature">
            <PlusIcon />
            <span className="hidden sm:inline">File Feature</span>
          </Button>
        }
      />
      <FilterChips
        chips={[
          ...(showEnded ? [{ label: "Shipped and dropped: shown", clear: () => setParam("ended", undefined) }] : []),
          ...(ownerName ? [{ label: `Owner: ${ownerName}`, clear: () => setParam("owner", undefined) }] : []),
        ]}
      />
    </>
  );

  let body: ReactNode;
  if (!teams.isPending && !team) {
    body = (
      <EmptyState icon={<SearchXIcon />} title="No such Team">
        No Team has the key {teamRef}.
      </EmptyState>
    );
  } else if (features.isError) {
    body = <Refusal error={features.error} className="p-6" />;
  } else if (!features.data) {
    body = (
      <div className="flex flex-col gap-2 p-6" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  } else if (ranked.length === 0) {
    body = (
      <EmptyState icon={<LayersIcon />} title="No Features yet">
        A Feature comes with its Break down Task.
      </EmptyState>
    );
  } else {
    body = (
      <RankedFeatures
        team={team!.key}
        ranked={ranked}
        shown={shown}
        canRank={(f) => inTeam || f.owner_id === me.member.id}
        isOwner={(f) => f.owner_id === me.member.id}
        ownerOf={(f) => members.get(f.owner_id)}
      />
    );
  }
  return (
    <>
      {top}
      <Content>{body}</Content>
    </>
  );
}

function RankedFeatures({
  team,
  ranked,
  shown,
  canRank,
  isOwner,
  ownerOf,
}: {
  team: string;
  ranked: Feature[];
  shown: Feature[];
  canRank: (f: Feature) => boolean;
  isOwner: (f: Feature) => boolean;
  ownerOf: (f: Feature) => { name: string; kind: "human" | "agent" } | undefined;
}) {
  const rank = useRankFeature(team);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const end = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const feature = ranked.find((f) => f.id === active.id);
    if (!feature) return;
    // Ended Features keep their places even while hidden, so the position is in the whole Rank.
    const position = rankPosition(ranked, String(over.id));
    rank.mutate(
      { feature, position, next: moveFeature(ranked, feature.id, position) },
      { onError: (err) => toast(`Not moved: ${feature.key}`, { description: err instanceof Error ? err.message : String(err) }) },
    );
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={end}
      accessibility={{
        screenReaderInstructions: { draggable: "Press Space to pick up the Feature, Up and Down to move it in the Rank, Space to drop it, Escape to cancel." },
      }}
    >
      <div className="sticky top-0 z-10 flex h-8 items-center border-b bg-muted text-xs font-medium text-muted-foreground">
        <div className={cn(rowGrid, "w-full items-center gap-2.5 px-4")}>
          <span />
          <span className="text-right">#</span>
          <span />
          <span>Feature</span>
          <span className="hidden md:block">Owner</span>
          <span className="hidden md:block">Tasks</span>
          <span className="hidden md:block" />
          <span />
        </div>
      </div>
      <SortableContext items={shown.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        <ol aria-label="Features in Rank order">
          {shown.map((f) => (
            <FeatureRow key={f.id} feature={f} movable={canRank(f)} owner={isOwner(f)} ownerMember={ownerOf(f)} />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function FeatureRow({
  feature: f,
  movable,
  owner,
  ownerMember,
}: {
  feature: Feature;
  movable: boolean;
  owner: boolean;
  ownerMember: { name: string; kind: "human" | "agent" } | undefined;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: f.id, disabled: !movable });
  const ended = f.state !== "open";
  const bar = taskBar(f.task_counts);
  const page = `/features/${encodeURIComponent(f.key)}`;
  return (
    <li
      ref={setNodeRef}
      data-feature={f.key}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition }}
      className={cn(
        rowGrid,
        "group relative h-10 items-center gap-2.5 border-b bg-background px-4 hover:bg-accent",
        ended && "text-muted-foreground",
        isDragging && "z-10 opacity-50",
      )}
    >
      {movable ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={`Move ${f.key} in the Rank`}
          {...attributes}
          {...listeners}
          className="grid size-4 cursor-grab touch-none place-items-center text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
      ) : (
        <span />
      )}
      <span className="text-right text-muted-foreground tabular-nums">{f.rank}</span>
      <Key>{f.key}</Key>
      <Link to={page} className={cn("flex min-w-0 items-center gap-2", ended ? "font-normal" : "font-medium")}>
        <span className="truncate">{f.title}</span>
        {f.state === "shipped" && <Pill tone="done">Shipped</Pill>}
        {f.state === "dropped" && <Pill tone="dropped">Dropped</Pill>}
      </Link>
      <span className="hidden min-w-0 items-center gap-1.5 text-muted-foreground md:flex">
        {ownerMember && <MemberAvatar member={ownerMember} />}
        <span className="truncate">{ownerMember?.name}</span>
      </span>
      <span
        role="img"
        aria-label={`${f.task_counts.done} done, ${f.task_counts.claimed} in progress, ${f.task_counts.open - f.task_counts.claimed} open`}
        className="hidden h-1.5 w-40 overflow-hidden rounded-[3px] bg-muted md:flex"
      >
        <i className="block h-full bg-state-done" style={{ width: `${bar.done}%` }} />
        <i className="block h-full bg-state-claimed" style={{ width: `${bar.held}%` }} />
        <i className="block h-full bg-muted-foreground/35" style={{ width: `${bar.waiting}%` }} />
      </span>
      <span className="hidden whitespace-nowrap text-muted-foreground tabular-nums md:block">{countsText(f.task_counts)}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={`${f.key} actions`}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => navigate(page)}>Open</DropdownMenuItem>
          {owner && !ended && (
            <>
              <DropdownMenuItem onSelect={() => navigate(page)}>Ship…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate(page)} variant="destructive">
                Drop…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
