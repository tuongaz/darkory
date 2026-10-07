// The Filter on Team › Tasks: its axes, and the values each offers, read from the board's model.
// derive.ts's `matches` says what each axis means for a Task.
import {
  AtSignIcon,
  BanIcon,
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarPlusIcon,
  CircleDashedIcon,
  FolderGit2Icon,
  HandIcon,
  LayersIcon,
  RocketIcon,
  ShapesIcon,
  TimerIcon,
  UserRoundCheckIcon,
  UserRoundIcon,
  UserRoundPenIcon,
  WrenchIcon,
} from "lucide-react";
import type { Feature, Member, Skill, Task, Workspace } from "@/api/client";
import type { FilterField, FilterOption } from "@/components/filters/operators";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { StatusGlyph } from "@/components/StatusGlyph";
import type { Glyph } from "@/lib/status";
import { nobody, type KindValue, type Status, type StatusKind } from "./derive";

const polarity = ["is", "not", "in", "nin"];
/** A date axis' operators: a span (one day is a span of one), its two open ends, a window. */
export const dateOps = ["btw", "after", "before", "gte", "lte", "last"];

/** The axes of `?filter.tasks=`, in the order the Filters menu lists them. */
export const taskFields: FilterField[] = [
  { key: "status", type: "enum", ops: polarity, label: "Status", icon: <CircleDashedIcon /> },
  { key: "skill", type: "ref", ops: polarity, label: "Needs", icon: <WrenchIcon /> },
  { key: "holder", type: "ref", ops: polarity, label: "Held by", icon: <UserRoundIcon /> },
  { key: "claim", type: "enum", ops: ["is", "in"], label: "Claim", icon: <HandIcon /> },
  { key: "aimed_at", type: "ref", ops: ["is", "not", "in"], label: "Aimed at", icon: <AtSignIcon /> },
  { key: "feature", type: "ref", ops: polarity, label: "Feature", icon: <LayersIcon /> },
  { key: "owner", type: "ref", ops: ["is", "not", "in"], label: "Feature owner", icon: <UserRoundCheckIcon /> },
  { key: "filed_by", type: "ref", ops: ["is", "not", "in"], label: "Filed by", icon: <UserRoundPenIcon /> },
  { key: "blocked", type: "boolean", ops: ["is"], label: "Blocked", icon: <BanIcon /> },
  { key: "kind", type: "enum", ops: ["is", "not", "in"], label: "Kind", icon: <ShapesIcon /> },
  { key: "workspace", type: "ref", ops: ["is", "in"], label: "Workspace", icon: <FolderGit2Icon /> },
  { key: "filed_at", type: "date", ops: dateOps, label: "Filed", icon: <CalendarPlusIcon /> },
  { key: "updated_at", type: "date", ops: dateOps, label: "Updated", icon: <CalendarClockIcon /> },
  { key: "completed_at", type: "date", ops: dateOps, label: "Completed", icon: <CalendarCheckIcon /> },
  { key: "q", type: "text", ops: ["contains"], label: "Search" },
];

/** The axes of `?filter.features=` on Team › Features. */
export const featureFields: FilterField[] = [
  { key: "owner", type: "ref", ops: ["is", "not", "in"], label: "Owner", icon: <UserRoundCheckIcon /> },
  { key: "state", type: "enum", ops: ["is", "not", "in"], label: "State", icon: <CircleDashedIcon /> },
  { key: "quick", type: "boolean", ops: ["is"], label: "Quick", icon: <TimerIcon /> },
  { key: "ship_when_done", type: "boolean", ops: ["is"], label: "Ships when done", icon: <RocketIcon /> },
  { key: "filed_at", type: "date", ops: dateOps, label: "Filed", icon: <CalendarPlusIcon /> },
  { key: "ended_at", type: "date", ops: dateOps, label: "Ended", icon: <CalendarCheckIcon /> },
  { key: "q", type: "text", ops: ["contains"], label: "Search" },
];

/** Every axis' values for a Team's Features. */
export function featureFilterOptions(ctx: { members: Map<string, Member>; me: string }): Map<string, FilterOption[]> {
  return new Map<string, FilterOption[]>([
    ["owner", memberOptions(ctx.members.values(), ctx.me)],
    [
      "state",
      [
        { value: "open", label: "Open" },
        { value: "shipped", label: "Shipped" },
        { value: "dropped", label: "Dropped" },
      ],
    ],
    [
      "quick",
      [
        { value: "true", label: "Quick" },
        { value: "false", label: "Not quick" },
      ],
    ],
    [
      "ship_when_done",
      [
        { value: "true", label: "Ships when done" },
        { value: "false", label: "Its owner ships it" },
      ],
    ],
  ]);
}

const kindOrder: StatusKind[] = ["backlog", "todo", "in_progress", "done", "dropped"];

/**
 * The Statuses in the Organisation's order, grouped by kind, each with its glyph. The sections go
 * unheaded: the glyph says the kind, and a heading over a lone Status of the same name repeats it.
 */
export function statusOptions(statuses: Status[], glyphs: Map<string, Glyph>): FilterOption[] {
  return [...statuses]
    .sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.position - b.position)
    .map((s) => ({ value: s.id, label: s.name, icon: <StatusGlyph glyph={glyphs.get(s.id) ?? "todo"} />, group: s.kind }));
}

/** The active Members, the signed-in one first and marked Me, then by name. */
export function memberOptions(members: Iterable<Member>, me: string): FilterOption[] {
  return [...members]
    .filter((m) => !m.deactivated_at)
    .sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name))
    .map((m) => ({ value: m.id, label: m.name, icon: <MemberAvatar member={m} />, hint: m.id === me ? "Me" : undefined }));
}

const claimOptions: FilterOption[] = [
  { value: "held", label: "Held" },
  { value: "unheld", label: "Unheld" },
  { value: "lapsed", label: "Lapsed in 24 h" },
  { value: "session", label: "Live session" },
];

const kindOptions: { value: KindValue; label: string }[] = [
  { value: "work", label: "Work" },
  { value: "breakdown", label: "Break down" },
  { value: "retrospective", label: "Retrospective" },
  { value: "question", label: "Question" },
];

/**
 * Every axis' values for a Team's Tasks: the Skills its Tasks need, the Organisation's Members
 * (Nobody first for Held by), its open Features by Rank and then its ended ones, which the board
 * shows unless the Display hides them, and the Install's Workspaces.
 */
export function taskFilterOptions(ctx: {
  tasks: Task[];
  statuses: Status[];
  glyphs: Map<string, Glyph>;
  features: Feature[];
  members: Map<string, Member>;
  skills: Map<string, Skill>;
  workspaces: Workspace[];
  me: string;
}): Map<string, FilterOption[]> {
  const members = memberOptions(ctx.members.values(), ctx.me);
  const skillIds = new Set(ctx.tasks.flatMap((t) => (t.skill_id ? [t.skill_id] : [])));
  const ranked = [...ctx.features].sort((a, b) => a.rank - b.rank);
  const feature = (f: Feature): FilterOption =>
    f.state === "open"
      ? { value: f.id, label: f.title, icon: <Key>{f.key}</Key>, group: "open" }
      : { value: f.id, label: f.title, icon: <Key>{f.key}</Key>, group: "ended", groupLabel: "Shipped and dropped" };
  return new Map<string, FilterOption[]>([
    ["status", statusOptions(ctx.statuses, ctx.glyphs)],
    [
      "skill",
      [...skillIds]
        .flatMap((id) => {
          const s = ctx.skills.get(id);
          return s ? [{ value: id, label: s.name }] : [];
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    ["holder", [{ value: nobody, label: "Nobody", icon: <CircleDashedIcon className="size-4 text-muted-foreground" /> }, ...members]],
    ["aimed_at", members],
    [
      "feature",
      [
        ...ranked.filter((f) => f.state === "open").map(feature),
        ...ranked.filter((f) => f.state !== "open").map(feature),
      ],
    ],
    ["owner", members],
    ["filed_by", members],
    [
      "blocked",
      [
        { value: "true", label: "Blocked" },
        { value: "false", label: "Not blocked" },
      ],
    ],
    ["kind", kindOptions],
    ["claim", claimOptions],
    ["workspace", [...ctx.workspaces].sort((a, b) => a.name.localeCompare(b.name)).map((w) => ({ value: w.id, label: w.name }))],
  ]);
}
