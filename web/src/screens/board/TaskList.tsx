// F-B2: a Team's Tasks as 36px rows, grouped by Status, Feature or holder.
import { LayersIcon } from "lucide-react";
import { Link } from "react-router";
import type { Task } from "@/api/client";
import { usePeekLink } from "@/app/peek";
import { useSelectedTask } from "@/app/selection";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { StatusGlyph } from "@/components/StatusGlyph";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { DayTime } from "@/components/Time";
import { cn } from "@/lib/utils";
import { liveClaim } from "@/work";
import { BlocksPill, FeatureRef, MarkPill, SkillPill } from "./bits";
import { marksOf, updatedAt, type Group } from "./derive";
import { aimedAt, featureOf, holderOf, type BoardModel } from "./model";

// glyph · key · title · marks · Feature · Skill · holder · updated (waiting since, or ended); on a
// phone the last four go.
const columns = "grid-cols-[14px_56px_minmax(0,1fr)_minmax(0,auto)] md:grid-cols-[14px_56px_minmax(0,1fr)_auto_200px_118px_28px_56px]";
const rowGrid = `grid ${columns}`;

export function TaskList({ model, groups, footer }: { model: BoardModel; groups: Group[]; footer: string }) {
  return (
    <div className="flex flex-col">
      {/* The columns' names, over the groups; a phone, which leaves those columns out, shows none. */}
      <div
        aria-hidden
        className={cn(
          columns,
          "sticky top-0 z-10 hidden h-8 items-center gap-2.5 border-b bg-background pr-4 pl-6 text-xs font-medium text-muted-foreground md:grid",
        )}
      >
        <span className="col-span-4">Task</span>
        <span>Feature</span>
        <span>Needs</span>
        <span />
        <span className="text-right">Updated</span>
      </div>
      {groups.map((g) => (
        <section key={`${g.by}:${g.id}`} aria-label={groupLabel(g, model)}>
          <GroupHeader group={g} model={model} />
          {g.tasks.map((t) => (
            <TaskRow key={t.id} task={t} model={model} />
          ))}
        </section>
      ))}
      <p className="flex h-10 items-center pr-4 pl-6 text-xs text-muted-foreground">{footer}</p>
    </div>
  );
}

function groupLabel(g: Group, model: BoardModel): string {
  if (g.by === "status") return g.status.name;
  if (g.by === "feature") return g.feature ? `${g.feature.key} ${g.feature.title}` : "Feature";
  return g.holderId ? (model.members.get(g.holderId)?.name ?? "Member") : "Not held";
}

function GroupHeader({ group: g, model }: { group: Group; model: BoardModel }) {
  let head;
  if (g.by === "status") {
    head = (
      <>
        <StatusGlyph glyph={model.glyphs.get(g.status.id) ?? "todo"} label={g.status.name} />
        <h2 className="font-medium">{g.status.name}</h2>
      </>
    );
  } else if (g.by === "feature") {
    head = (
      <>
        <LayersIcon className="size-3.5 text-muted-foreground" aria-hidden />
        {g.feature && <Key>{g.feature.key}</Key>}
        <h2 className="truncate font-medium">{g.feature?.title ?? "Feature"}</h2>
        {g.feature?.state === "shipped" && <Pill tone="done">Shipped</Pill>}
        {g.feature?.state === "dropped" && <Pill tone="dropped">Dropped</Pill>}
      </>
    );
  } else {
    const holder = g.holderId ? model.members.get(g.holderId) : undefined;
    head = (
      <>
        {holder && <MemberAvatar member={holder} />}
        <h2 className="truncate font-medium">{holder?.name ?? "Not held"}</h2>
      </>
    );
  }
  return (
    <div className="flex h-[34px] items-center gap-2 border-b bg-muted pr-4 pl-6">
      {head}
      <span className="text-muted-foreground tabular-nums">{g.tasks.length}</span>
    </div>
  );
}

function TaskRow({ task, model }: { task: Task; model: BoardModel }) {
  const peek = usePeekLink();
  // The keys' ring: the row walked to, or the one whose peek is open.
  const selected = useSelectedTask() === task.key;
  const ended = task.state !== "open";
  const feature = featureOf(model, task);
  const holder = holderOf(task, model);
  const aimed = aimedAt(task, model);
  // Who the row is with: its holder, or while nobody holds it the Member it is aimed at.
  const face = holder ?? aimed;
  const status = model.statusById.get(task.status_id);
  const claim = liveClaim(task, model.now);
  const marks = marksOf(task, model.trails.get(task.id), model.now);
  const blocks = model.blocks.get(task.id) ?? [];
  const when = updatedAt(task);
  return (
    <Link
      to={peek(task.key)}
      aria-label={`${task.key} ${task.title}`}
      data-task={task.key}
      data-selected={selected || undefined}
      className={cn(
        rowGrid,
        "h-9 items-center gap-2.5 border-b pr-4 pl-6 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        ended && "text-muted-foreground",
        selected && "ring-2 ring-ring ring-inset",
      )}
    >
      <StatusGlyph glyph={model.glyphs.get(task.status_id) ?? "todo"} label={status?.name} />
      <Key>{task.key}</Key>
      <span className={cn("truncate", ended ? "font-normal" : "font-medium")}>{task.title}</span>
      <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        {marks.map((m, i) => (
          <MarkPill key={i} mark={m} now={model.now} />
        ))}
        {!ended && !task.skill_id && <BlocksPill blocks={blocks} />}
        {claim?.expires_at && (
          <span className="hidden text-xs text-muted-foreground md:inline-flex">
            <HeartbeatMeter claim={claim} variant="compact" />
          </span>
        )}
      </span>
      <FeatureRef feature={feature} className="hidden text-sm md:flex" />
      <span className="hidden min-w-0 md:flex">
        {aimed ? <span className="truncate text-muted-foreground">aimed at {aimed.name}</span> : !ended && <SkillPill task={task} model={model} />}
      </span>
      <span className="hidden md:flex">{face && <MemberAvatar member={face} />}</span>
      <span className="hidden text-right text-muted-foreground md:block">
        <DayTime at={when} what={ended && task.ended_at ? "Ended" : "Waiting since"} />
      </span>
    </Link>
  );
}
