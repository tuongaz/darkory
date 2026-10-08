// A Project's Tasks as 36px rows grouped by Step (or Parent, Owner, Label), a Parent's row
// opening to its Subtasks. Each row opens the Task's peek; J and K walk them (`data-task`).
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { Fragment } from "react";
import { Link } from "react-router";
import type { Task } from "@/api/client";
import { usePeekLink } from "@/app/peek";
import { useSelectedTask } from "@/app/selection";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { LabelPill, LabelPills } from "@/components/LabelPill";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { DayTime } from "@/components/Time";
import { WorkGlyph } from "@/components/WorkGlyph";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { liveClaim } from "@/work";
import { BlocksPill, EvidenceCount, MarkPill, People } from "./bits";
import { groupKey, isParent, marksOf, progressText, updatedAt, type Group } from "./derive";
import { aimedAt, holderOf, type TasksModel } from "./model";

// glyph · key · title and its marks · Labels, Evidence, Heartbeat · people · updated; a phone
// keeps the first three and the progress.
const columns = "grid-cols-[14px_56px_minmax(0,1fr)_auto] md:grid-cols-[14px_56px_minmax(0,1fr)_auto_48px_52px]";

export type ListProps = {
  model: TasksModel;
  groups: Group[];
  /** The ids of the Parents whose rows are open. */
  expanded: Set<string>;
  onExpand: (parentId: string, open: boolean) => void;
  /** The Subtasks a Parent's row opens to while the Filter narrows them; else all of them. */
  shownSubtasks?: Map<string, Task[]>;
  /** The ids of the folded groups. */
  folded: Set<string>;
  onFold: (groupId: string, folded: boolean) => void;
  /** Whether a Parent's row may open to its Subtasks (Display › Subtasks). */
  subtasks: boolean;
  /** Whether the rows say their Step: not when they are grouped by it. */
  showStep: boolean;
  onAdd: (stepId: string) => void;
  footer: string;
};

export function TaskList(props: ListProps) {
  const { model, groups, folded, onFold, footer } = props;
  return (
    <div className="flex flex-col">
      {/* The columns' names over the groups; a phone, which leaves those columns out, shows none. */}
      <div
        aria-hidden
        className={cn(columns, "sticky top-0 z-10 hidden h-8 items-center gap-2.5 border-b bg-background pr-4 pl-6 text-xs font-medium text-muted-foreground md:grid")}
      >
        <span className="col-span-4">Task</span>
        <span />
        <span className="text-right">Updated</span>
      </div>
      {groups.map((g) => {
        const id = groupKey(g);
        const isFolded = folded.has(id);
        return (
          <section key={id} aria-label={groupLabel(g, model)}>
            <GroupHeader group={g} model={model} folded={isFolded} onFold={(f) => onFold(id, f)} onAdd={props.onAdd} />
            {!isFolded &&
              g.tasks.map((t) => (
                <Fragment key={t.id}>
                  <TaskRow task={t} {...props} />
                  {isParent(t) && props.subtasks && props.expanded.has(t.id) && (
                    <div role="group" aria-label={`Subtasks of ${t.key}`}>
                      {((props.shownSubtasks ?? model.children).get(t.id) ?? []).map((s) => (
                        <TaskRow key={s.id} task={s} {...props} nested />
                      ))}
                    </div>
                  )}
                </Fragment>
              ))}
          </section>
        );
      })}
      <p className="flex h-10 items-center pr-4 pl-6 text-xs text-muted-foreground">{footer}</p>
    </div>
  );
}

function groupLabel(g: Group, model: TasksModel): string {
  switch (g.by) {
    case "step":
      return g.step.name;
    case "with":
      return `With ${g.member?.name ?? "a Member"}`;
    case "ended":
      return g.state === "done" ? "Done" : "Dropped";
    case "parent":
      return g.parent ? `${g.parent.key} ${g.parent.title}` : "No Parent";
    case "owner":
      return g.owner?.name ?? "Owner";
    case "label":
      return g.label?.name ?? "No Label";
    case "none":
      return `Tasks of ${model.project.name}`;
  }
}

function GroupHeader({
  group: g,
  model,
  folded,
  onFold,
  onAdd,
}: {
  group: Group;
  model: TasksModel;
  folded: boolean;
  onFold: (folded: boolean) => void;
  onAdd: (stepId: string) => void;
}) {
  if (g.by === "none") return null;
  let head;
  switch (g.by) {
    case "step": {
      const skill = g.step.skill_id ? model.skills.get(g.step.skill_id) : undefined;
      head = (
        <>
          <WorkGlyph glyph={{ glyph: skill ? "waiting" : "hold" }} label={skill ? g.step.name : `${g.step.name}, a hold`} />
          <h2 className="font-medium">{g.step.name}</h2>
          {skill ? <Pill tone="outline">{skill.name}</Pill> : <span className="text-xs text-muted-foreground">hold</span>}
        </>
      );
      break;
    }
    case "with":
      head = (
        <>
          {g.member && <MemberAvatar member={g.member} />}
          <h2 className="truncate font-medium">With {g.member?.name ?? "a Member"}</h2>
        </>
      );
      break;
    case "ended":
      head = (
        <>
          <WorkGlyph glyph={{ glyph: g.state }} />
          <h2 className="font-medium">{g.state === "done" ? "Done" : "Dropped"}</h2>
        </>
      );
      break;
    case "parent":
      head = g.parent ? (
        <>
          <WorkGlyph glyph={model.glyph(g.parent)} />
          <Key>{g.parent.key}</Key>
          <h2 className="truncate font-medium">{g.parent.title}</h2>
          {g.parent.subtask_counts && <span className="text-muted-foreground tabular-nums">{progressText(g.parent.subtask_counts)}</span>}
        </>
      ) : (
        <h2 className="font-medium">No Parent</h2>
      );
      break;
    case "owner":
      head = (
        <>
          {g.owner && <MemberAvatar member={g.owner} />}
          <h2 className="truncate font-medium">{g.owner?.name ?? "Owner"}</h2>
        </>
      );
      break;
    case "label":
      head = g.label ? <LabelPill label={g.label} className="h-6 text-xs" /> : <h2 className="font-medium">No Label</h2>;
      break;
  }
  return (
    <div className="flex h-[34px] items-center gap-2 border-b bg-muted pr-4 pl-1.5">
      <button
        type="button"
        aria-expanded={!folded}
        aria-label={folded ? `Show ${groupLabel(g, model)}` : `Fold ${groupLabel(g, model)}`}
        onClick={() => onFold(!folded)}
        className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", !folded && "rotate-90")} aria-hidden />
      </button>
      {head}
      <span className="text-muted-foreground tabular-nums">{g.tasks.length}</span>
      {g.by === "step" && (
        <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label={`File a Task at ${g.step.name}`} onClick={() => onAdd(g.step.id)}>
          <PlusIcon />
        </Button>
      )}
    </div>
  );
}

function TaskRow({ task, model, expanded, onExpand, subtasks, showStep, nested }: ListProps & { task: Task; nested?: boolean }) {
  const peek = usePeekLink();
  // The keys' ring: the row walked to, or the one whose peek is open.
  const selected = useSelectedTask() === task.key;
  const ended = task.state !== "open";
  const parent = isParent(task);
  const open = parent && expanded.has(task.id);
  const holder = holderOf(task, model);
  const aimed = aimedAt(task, model);
  const owner = model.members.get(task.owner_id);
  const claim = liveClaim(task, model.now);
  const trail = model.trails.get(task.id);
  const marks = marksOf(task, trail, model.now);
  const blocks = model.blocks.get(task.id) ?? [];
  const step = task.step_id ? model.stepById.get(task.step_id) : undefined;
  return (
    <div className="relative">
      {parent && subtasks && (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Close the Subtasks of ${task.key}` : `Open the Subtasks of ${task.key}`}
          onClick={() => onExpand(task.id, !open)}
          className="absolute top-2 left-1 z-[1] grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
        </button>
      )}
      <Link
        to={peek(task.key)}
        aria-label={`${task.key} ${task.title}`}
        data-task={task.key}
        data-selected={selected || undefined}
        className={cn(
          "grid h-9 items-center gap-2.5 border-b pr-4 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
          columns,
          nested ? "pl-11" : "pl-6",
          ended && "text-muted-foreground",
          selected && "ring-2 ring-ring ring-inset",
        )}
      >
        <WorkGlyph glyph={model.glyph(task)} />
        <Key>{task.key}</Key>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("min-w-0 truncate", ended ? "font-normal" : "font-medium")}>{task.title}</span>
          {marks.map((m, i) => (
            <MarkPill key={i} mark={m} now={model.now} />
          ))}
          {!ended && task.aimed_at_id && <BlocksPill blocks={blocks} />}
          {(showStep || nested) && step && !ended && (
            <Pill tone="outline" className="hidden sm:inline-flex">
              {step.name}
            </Pill>
          )}
        </span>
        <span className="flex min-w-0 items-center justify-end gap-2">
          <LabelPills ids={task.labels} labels={model.labelById} className="hidden md:flex" />
          <span className="hidden md:inline-flex">
            <EvidenceCount count={trail?.evidence ?? 0} />
          </span>
          {claim?.expires_at && (
            <span className="hidden text-xs text-muted-foreground lg:inline-flex">
              <HeartbeatMeter claim={claim} variant="compact" />
            </span>
          )}
          {task.subtask_counts && (
            <span className="text-xs text-muted-foreground tabular-nums" title={`${task.subtask_counts.done} of ${task.subtask_counts.open + task.subtask_counts.done} Subtasks done`}>
              {progressText(task.subtask_counts)}
            </span>
          )}
        </span>
        <span className="hidden md:flex">
          <People holder={holder} aimed={aimed} owner={owner} />
        </span>
        <span className="hidden text-right text-muted-foreground md:block">
          <DayTime at={updatedAt(task)} what={ended ? "Ended" : "Updated"} />
        </span>
      </Link>
    </div>
  );
}
