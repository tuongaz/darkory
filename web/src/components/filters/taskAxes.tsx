// The Filter's axes for a list of Tasks (`?filter.tasks=`), the values each offers, and what each
// means for a Task. The tokens are the server's, word for word and meaning for meaning (the
// `filter` parameter of `GET /v1/tasks` in api/openapi.yaml): ids on the wire, never names, so a
// list may filter in the browser through `matches` or pass the same tokens on as `filter=`.
import {
  AtSignIcon,
  BanIcon,
  BotIcon,
  CalendarCheckIcon,
  CalendarPlusIcon,
  CircleDashedIcon,
  FolderGit2Icon,
  FolderIcon,
  HandIcon,
  ListTreeIcon,
  RouteIcon,
  ShapesIcon,
  TagIcon,
  UserRoundCheckIcon,
  UserRoundIcon,
  UserRoundPenIcon,
} from "lucide-react";
import type { Activity, Label, Member, Project, Skill, Task, Taker, Workflow, Workspace } from "@/api/client";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { ProjectMark } from "@/components/ProjectMark";
import { WorkGlyph } from "@/components/WorkGlyph";
import { liveClaim } from "@/work";
import { passesDate } from "./dates";
import { LabelDot } from "@/components/LabelPill";
import type { FilterPill } from "./filterState";
import type { FilterField, FilterOption } from "./operators";

const polarity = ["is", "not", "in", "nin"];
/** A date axis' operators: a span (one day is a span of one), its two open ends, a window. */
export const dateOps = ["btw", "after", "before", "gte", "lte", "last"];

/** The value of Held by and Parent that means none: a Task nobody holds, a Task with no Parent. */
export const nobody = "none";

/**
 * The axes of `?filter.tasks=`, in the order the Filters menu lists them. Project is for a list
 * across Projects; a Project's own list leaves it out (`projectTaskFields`).
 */
export const taskFields: FilterField[] = [
  { key: "step", type: "enum", ops: polarity, label: "Step", icon: <RouteIcon /> },
  { key: "label", type: "ref", ops: polarity, label: "Label", icon: <TagIcon /> },
  { key: "parent", type: "ref", ops: polarity, label: "Parent", icon: <ListTreeIcon /> },
  { key: "kind", type: "enum", ops: polarity, label: "Kind", icon: <ShapesIcon /> },
  { key: "claim", type: "enum", ops: ["is", "in"], label: "Claim", icon: <HandIcon /> },
  { key: "blocked", type: "boolean", ops: ["is"], label: "Blocked", icon: <BanIcon /> },
  { key: "holder", type: "ref", ops: polarity, label: "Held by", icon: <UserRoundIcon /> },
  { key: "aimed_at", type: "ref", ops: polarity, label: "Aimed at", icon: <AtSignIcon /> },
  { key: "owner", type: "ref", ops: polarity, label: "Owner", icon: <UserRoundCheckIcon /> },
  { key: "filed_by", type: "ref", ops: polarity, label: "Filed by", icon: <UserRoundPenIcon /> },
  { key: "takeable_by", type: "enum", ops: polarity, label: "Takeable by", icon: <BotIcon /> },
  { key: "project", type: "ref", ops: polarity, label: "Project", icon: <FolderIcon /> },
  { key: "workspace", type: "ref", ops: ["is", "in"], label: "Workspace", icon: <FolderGit2Icon /> },
  { key: "filed_at", type: "date", ops: dateOps, label: "Filed", icon: <CalendarPlusIcon /> },
  { key: "completed_at", type: "date", ops: dateOps, label: "Completed", icon: <CalendarCheckIcon /> },
  { key: "q", type: "text", ops: ["contains"], label: "Search" },
];

/** A Project's own Tasks: every axis but Project. */
export const projectTaskFields: FilterField[] = taskFields.filter((f) => f.key !== "project");

/** Kind's values: the record's kinds, and Question, a work Task aimed at a Member. */
export type KindValue = Task["kind"] | "question";

/** A Task's Kind value: a work Task aimed at a Member is a question; one aimed at nobody is work. */
export function kindValue(task: Pick<Task, "kind" | "aimed_at_id">): KindValue {
  return task.kind === "work" && task.aimed_at_id ? "question" : task.kind;
}

/** A Step as `matches` reads it: the Skill it carries and who could take a Task there by it. */
export type StepInfo = { skill_id?: string; takers: Pick<Taker, "kind">[] };

/** The Steps of the Workflows `workflows` holds, by id. */
export function stepsOf(workflows: Iterable<Workflow | undefined>): Map<string, StepInfo> {
  const out = new Map<string, StepInfo>();
  for (const wf of workflows) for (const s of wf?.steps ?? []) out.set(s.id, { skill_id: s.skill_id, takers: s.takers });
  return out;
}

/**
 * What `matches` reads beyond the Task: the clock; the Steps of the Tasks' Workflows (Takeable
 * by); for the Claim axis the Claim trails (recorded lapses) and the Tasks the Runner runs a
 * session for now.
 */
export type FilterContext = {
  now: number;
  steps?: ReadonlyMap<string, StepInfo>;
  trails?: ReadonlyMap<string, ClaimTrail>;
  sessions?: ReadonlySet<string>;
};

/**
 * A Task's time on each date axis: Filed, Completed for a Task that ended done, Ended for one that
 * ended either way. The record has no updated time the server and a list share, so Updated is no
 * axis.
 */
const taskTimes: Record<string, (t: Task) => string | undefined> = {
  filed_at: (t) => t.created_at,
  completed_at: (t) => (t.state === "done" ? t.ended_at : undefined),
  ended_at: (t) => (t.state !== "open" ? t.ended_at : undefined),
};

/** How long a lapse counts as recent on the Claim axis. */
const lapseWindowMs = 24 * 60 * 60 * 1000;

/**
 * The Claim axis' values of a Task, as many as hold, as the server's `filter` reads them: `held`, a
 * live Claim; `unheld`, none, in any state; `lapsed`, a Claim of the Task lapsed within the last
 * 24 hours, recorded or only past its expiry, whether or not it was claimed again since;
 * `session`, the Runner beside the server runs a session for it now.
 */
export function claimValues(task: Task, ctx: FilterContext): string[] {
  const out = [liveClaim(task, ctx.now) ? "held" : "unheld"];
  const claim = task.claim;
  // A Claim past its expiry that the sweep has not ended yet lapsed at its expiry.
  const expired = claim && !claim.ended_at && claim.expires_at && Date.parse(claim.expires_at) <= ctx.now ? claim.expires_at : undefined;
  const lapses = [expired, ctx.trails?.get(task.id)?.lastLapseAt].filter((at): at is string => !!at);
  if (lapses.some((at) => ctx.now - Date.parse(at) <= lapseWindowMs)) out.push("lapsed");
  if (ctx.sessions?.has(task.id)) out.push("session");
  return out;
}

/**
 * Takeable by's values of a Task, as many as hold: `agents` when an agent could take it by its
 * Step's Skill, `humans` when a human could, `both` when both could. A Task at no Step (a Parent,
 * one aimed at a Member, an ended one) or at a hold has none.
 */
export function takeableByValues(task: Pick<Task, "step_id">, steps: ReadonlyMap<string, StepInfo> | undefined): string[] {
  const step = task.step_id ? steps?.get(task.step_id) : undefined;
  if (!step?.skill_id) return [];
  const agents = step.takers.some((t) => t.kind === "agent");
  const humans = step.takers.some((t) => t.kind === "human");
  return [...(agents ? ["agents"] : []), ...(humans ? ["humans"] : []), ...(agents && humans ? ["both"] : [])];
}

/**
 * A Task's values on an axis of the Filter: one for most, as many as it carries for Labels and
 * Workspaces, none where it has none (a Task at no Step has no Step). Undefined for an axis the
 * Tasks do not have.
 */
export function taskValues(task: Task, field: string, ctx: FilterContext): string[] | undefined {
  const one = (v: string | undefined) => (v ? [v] : []);
  switch (field) {
    case "project":
      return [task.project_id];
    case "step":
      return one(task.step_id);
    case "skill":
      return one(task.skill_id);
    case "label":
      return task.labels ?? [];
    case "parent":
      return [task.parent_id ?? nobody];
    case "top":
      return [String(!task.parent_id)];
    case "holder":
      return [liveClaim(task, ctx.now)?.holder_id ?? nobody];
    case "aimed_at":
      return one(task.aimed_at_id);
    case "owner":
      return [task.owner_id];
    case "filed_by":
      return one(task.filed_by);
    case "blocked":
      return [String(task.blocked)];
    case "kind":
      return [kindValue(task)];
    case "claim":
      return claimValues(task, ctx);
    case "takeable_by":
      return takeableByValues(task, ctx.steps);
    case "workspace":
      return task.workspace_ids ?? [];
    case "auto_complete":
      return [String(task.auto_complete)];
    case "acceptance":
      return [String(task.acceptance)];
    case "model": {
      const label = liveClaim(task, ctx.now)?.model_label;
      return one(label);
    }
    default:
      return undefined;
  }
}

/**
 * Whether values pass a pill: `is` and `in` when any value is one of the pill's, `not` and `nin`
 * when none is. So on an axis with several values (Labels) "is not X" means none of them is X, and
 * on an axis with none, every "not" passes and every "is" fails, as the server reads them.
 */
export function passes(values: string[], pill: FilterPill): boolean {
  const hit = values.some((v) => pill.values.includes(v));
  switch (pill.op) {
    case "is":
    case "in":
      return hit;
    case "not":
    case "nin":
      return !hit;
    default:
      return true;
  }
}

/** Whether a key or a title holds a Search pill's words, ignoring case. */
function searchMatches(record: { key: string; title: string }, pill: FilterPill): boolean {
  const words = (pill.values[0] ?? "").toLowerCase();
  return [record.key, record.title].some((text) => text.toLowerCase().includes(words));
}

/** Whether a number passes a pill on Rank: the polarity operators, and `lte` and `gte`. */
function passesNumber(value: number | undefined, pill: FilterPill): boolean {
  const n = Number(pill.values[0]);
  switch (pill.op) {
    case "lte":
      return value !== undefined && value <= n;
    case "gte":
      return value !== undefined && value >= n;
    default:
      return passes(value === undefined ? [] : [String(value)], pill);
  }
}

/**
 * Whether a Task passes every pill of the Filter, as `GET /v1/tasks?filter=` would answer: the
 * axes are ANDed, the values of one axis ORed. Search (`q`) matches the key or the title, ignoring
 * case, as the server's does. A pill for an axis the Tasks do not have narrows nothing.
 */
export function matches(task: Task, pills: readonly FilterPill[], ctx: FilterContext): boolean {
  return pills.every((pill) => {
    if (pill.field === "q") return searchMatches(task, pill);
    if (pill.field === "rank") return passesNumber(task.rank, pill);
    const time = taskTimes[pill.field];
    if (time) return passesDate(time(task), pill, ctx.now);
    const values = taskValues(task, pill.field, ctx);
    return values === undefined || passes(values, pill);
  });
}

// ---------------------------------------------------------------- the Claim trail

/** What the Activity says about a Task's Claims that a Task in a list does not carry. */
export type ClaimTrail = {
  /** When its last Claim lapsed, if the last Claim it had ended by a lapse. */
  lapsedAt?: string;
  /** When a Claim of it last lapsed, though it was claimed again since. */
  lastLapseAt?: string;
  /** Who completed it. */
  completedBy?: string;
  /** How much Evidence was attached to it, as far as the read reaches. */
  evidence?: number;
};

/** The Activity kinds `claimTrails` reads. */
export const trailKinds = ["task.claimed", "task.lapsed", "task.completed", "task.evidence_attached"] as const satisfies Activity["kind"][];

/**
 * Reads each Task's Claim history from the Activity, since `/v1/tasks` gives a Task's Claim only
 * while it is live: a Task whose latest Claim entry is a lapse lapsed at that entry's time; a
 * later claim clears it. `entries` may come in any order and may repeat.
 */
export function claimTrails(entries: readonly Activity[]): Map<string, ClaimTrail> {
  const seen = new Set<number>();
  const sorted = entries.filter((e) => !seen.has(e.seq) && seen.add(e.seq)).sort((a, b) => a.seq - b.seq);
  const out = new Map<string, ClaimTrail>();
  for (const e of sorted) {
    const t = out.get(e.subject_id) ?? {};
    if (e.kind === "task.claimed") t.lapsedAt = undefined;
    else if (e.kind === "task.lapsed") t.lapsedAt = t.lastLapseAt = e.at;
    else if (e.kind === "task.completed") t.completedBy = e.actor_id;
    else if (e.kind === "task.evidence_attached") t.evidence = (t.evidence ?? 0) + 1;
    else continue;
    out.set(e.subject_id, t);
  }
  return out;
}

// ---------------------------------------------------------------- the values each axis offers

/** The active Members, the signed-in one first and marked Me, then by name. */
export function memberOptions(members: Iterable<Member>, me: string): FilterOption[] {
  return [...members]
    .filter((m) => !m.deactivated_at)
    .sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name))
    .map((m) => ({ value: m.id, label: m.name, icon: <MemberAvatar member={m} card={false} />, hint: m.id === me ? "Me" : undefined }));
}

const claimOptions: FilterOption[] = [
  { value: "held", label: "Held" },
  { value: "unheld", label: "Unheld" },
  { value: "lapsed", label: "Lapsed in 24 h" },
  { value: "session", label: "Live session" },
];

const kindOptions: FilterOption[] = [
  { value: "work", label: "Work" },
  { value: "question", label: "Question" },
  { value: "breakdown", label: "Break down" },
  { value: "acceptance", label: "Acceptance" },
  { value: "retrospective", label: "Retrospective" },
];

const takeableOptions: FilterOption[] = [
  { value: "agents", label: "Agents" },
  { value: "humans", label: "Humans" },
  { value: "both", label: "Both" },
];

const holdGlyph = { glyph: "hold" } as const;
const waitingGlyph = { glyph: "waiting" } as const;

/**
 * The Steps of each Project's Workflow in its order, each named with the Skill it carries (or Hold),
 * grouped by Project, each group headed by its Project's name when there is more than one.
 */
export function stepOptions(projects: readonly Project[], workflows: ReadonlyMap<string, Workflow | undefined>, skills: ReadonlyMap<string, Pick<Skill, "name">>): FilterOption[] {
  const many = projects.length > 1;
  return projects.flatMap((p) =>
    [...(workflows.get(p.id)?.steps ?? [])]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        value: s.id,
        label: s.name,
        icon: <WorkGlyph glyph={s.skill_id ? waitingGlyph : holdGlyph} label={s.skill_id ? "Step" : "Hold"} />,
        hint: s.skill_id ? (skills.get(s.skill_id)?.name ?? "a Skill") : "Hold",
        group: p.id,
        groupLabel: many ? p.name : undefined,
      })),
  );
}

/**
 * The Labels a Task of `projects` can carry: each Project's own, headed by its name when there is
 * more than one, then the Organisation's.
 */
export function labelOptions(projects: readonly Project[], labels: readonly Label[]): FilterOption[] {
  const many = projects.length > 1;
  const seen = new Set<string>();
  const option = (l: Label, group: string, groupLabel?: string): FilterOption => ({ value: l.id, label: l.name, icon: <LabelDot label={l} />, group, groupLabel });
  const byName = (a: Label, b: Label) => a.name.localeCompare(b.name);
  const own = projects.flatMap((p) =>
    labels
      .filter((l) => l.project_id === p.id && !seen.has(l.id) && seen.add(l.id))
      .sort(byName)
      .map((l) => option(l, p.id, many ? p.name : undefined)),
  );
  const org = labels
    .filter((l) => !l.project_id && !seen.has(l.id) && seen.add(l.id))
    .sort(byName)
    .map((l) => option(l, "organisation", own.length > 0 ? "Organisation" : undefined));
  return [...own, ...org];
}

/**
 * Parent's values: No Parent first, then the Parents among `tasks`, the open ones by Rank and then
 * the ended ones, under their own heading.
 */
export function parentOptions(tasks: readonly Task[]): FilterOption[] {
  const parents = tasks.filter((t) => t.subtask_counts).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.key.localeCompare(b.key));
  const option = (t: Task): FilterOption =>
    t.state === "open"
      ? { value: t.id, label: t.title, icon: <Key>{t.key}</Key>, group: "open" }
      : { value: t.id, label: t.title, icon: <Key>{t.key}</Key>, group: "ended", groupLabel: "Done and dropped" };
  return [
    { value: nobody, label: "No Parent", icon: <CircleDashedIcon className="size-4 text-muted-foreground" />, group: "none" },
    ...parents.filter((t) => t.state === "open").map(option),
    ...parents.filter((t) => t.state !== "open").map(option),
  ];
}

/** What `taskFilterOptions` reads: the list's Projects and their Workflows, and the names. */
export type TaskOptionsContext = {
  /** The Projects whose Tasks the list holds, in the order their Steps are listed. */
  projects: readonly Project[];
  /** Each Project's Workflow, by Project id. */
  workflows: ReadonlyMap<string, Workflow | undefined>;
  /** The Tasks the list holds: their Parents are Parent's values. */
  tasks: readonly Task[];
  /** The Labels the Projects' Tasks can carry: the Projects' own and the Organisation's. */
  labels: readonly Label[];
  members: ReadonlyMap<string, Member>;
  skills: ReadonlyMap<string, Pick<Skill, "name">>;
  workspaces: readonly Workspace[];
  /** Every Project of the Organisation, for Project's values. */
  allProjects?: readonly Project[];
  /** The signed-in Member's id. */
  me: string;
};

/** Every axis' values for a list of Tasks, in the order each offers them. */
export function taskFilterOptions(ctx: TaskOptionsContext): Map<string, FilterOption[]> {
  const members = memberOptions(ctx.members.values(), ctx.me);
  return new Map<string, FilterOption[]>([
    ["step", stepOptions(ctx.projects, ctx.workflows, ctx.skills)],
    ["label", labelOptions(ctx.projects, ctx.labels)],
    ["parent", parentOptions(ctx.tasks)],
    ["kind", kindOptions],
    ["claim", claimOptions],
    [
      "blocked",
      [
        { value: "true", label: "Blocked" },
        { value: "false", label: "Not blocked" },
      ],
    ],
    ["holder", [{ value: nobody, label: "Nobody", icon: <CircleDashedIcon className="size-4 text-muted-foreground" /> }, ...members]],
    ["aimed_at", members],
    ["owner", members],
    ["filed_by", members],
    ["takeable_by", takeableOptions],
    [
      "project",
      [...(ctx.allProjects ?? ctx.projects)].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, icon: <ProjectMark project={p} />, sublabel: p.key })),
    ],
    ["workspace", [...ctx.workspaces].sort((a, b) => a.name.localeCompare(b.name)).map((w) => ({ value: w.id, label: w.name }))],
  ]);
}
