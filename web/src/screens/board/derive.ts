// What the Board screens compute from /v1 records: Status glyphs, the order and grouping of Tasks,
// the marks a row or card carries, what a refused drag says, and the Features' Task bars. Pure, so
// Vitest checks them without rendering.
import type { Activity, Feature, Task, TaskBrief, TaskCounts } from "@/api/client";
import type { components } from "@/api/schema.gen";
import { glyphFor, type Glyph } from "@/lib/status";
import { liveClaim } from "@/work";

export type Status = components["schemas"]["Status"];
export type StatusKind = Status["kind"];

/** The kinds a Task can be moved between by hand; done and dropped are reached by Complete and Drop. */
export const openKinds: readonly StatusKind[] = ["backlog", "todo", "in_progress"];

export function isOpenKind(kind: StatusKind): boolean {
  return openKinds.includes(kind);
}

/** The Organisation's Statuses in their order, position 1 first. */
export function inOrder(statuses: Status[]): Status[] {
  return [...statuses].sort((a, b) => a.position - b.position);
}

/**
 * The glyph of every Status, by id: the first In-progress-kind Status draws half full, any later
 * one (In review) three quarters.
 */
export function statusGlyphs(statuses: Status[]): Map<string, Glyph> {
  const seen = new Map<StatusKind, number>();
  const out = new Map<string, Glyph>();
  for (const s of inOrder(statuses)) {
    const nth = seen.get(s.kind) ?? 0;
    seen.set(s.kind, nth + 1);
    out.set(s.id, glyphFor(s.kind, nth));
  }
  return out;
}

/** The Status a Task is filed in unless another is chosen: the first of kind todo. */
export function defaultFileStatus(statuses: Status[]): Status | undefined {
  return inOrder(statuses).find((s) => s.kind === "todo");
}

export type Order = "rank" | "waiting";

const keyNumber = (key: string) => Number(key.slice(key.lastIndexOf("-") + 1)) || 0;
const time = (at: string | undefined) => (at ? new Date(at).getTime() : 0);

/**
 * Orders Tasks as `next` offers them: by their Feature's Rank, then the one that has waited
 * longest; or, for "waiting", by waiting time alone. Ties go to the older key.
 */
export function compareTasks(order: Order, features: Map<string, Pick<Feature, "rank">>) {
  const rank = (t: Task) => features.get(t.feature_id)?.rank ?? Number.MAX_SAFE_INTEGER;
  return (a: Task, b: Task): number => {
    const byRank = rank(a) - rank(b);
    const byWait = time(a.waiting_since) - time(b.waiting_since);
    const first = order === "rank" ? byRank || byWait : byWait || byRank;
    return first || keyNumber(a.key) - keyNumber(b.key);
  };
}

export type GroupBy = "status" | "feature" | "holder";

export type Group =
  | { by: "status"; id: string; status: Status; tasks: Task[] }
  | { by: "feature"; id: string; feature: Feature | undefined; tasks: Task[] }
  | { by: "holder"; id: string; holderId: string | undefined; tasks: Task[] };

/**
 * Groups Tasks already in order, keeping that order inside each group. Statuses come in the
 * Organisation's order and Features in Rank order; holders by name, then the Tasks nobody holds.
 * Empty groups are left out.
 */
export function groupTasks(
  tasks: Task[],
  by: GroupBy,
  ctx: { statuses: Status[]; features: Feature[]; holderName: (id: string) => string; now: number },
): Group[] {
  const buckets = new Map<string, Task[]>();
  const keyOf = (t: Task): string => {
    if (by === "status") return t.status_id;
    if (by === "feature") return t.feature_id;
    return liveClaim(t, ctx.now)?.holder_id ?? "";
  };
  for (const t of tasks) {
    const k = keyOf(t);
    const list = buckets.get(k);
    if (list) list.push(t);
    else buckets.set(k, [t]);
  }
  if (by === "status") {
    return inOrder(ctx.statuses)
      .filter((s) => buckets.has(s.id))
      .map((s) => ({ by, id: s.id, status: s, tasks: buckets.get(s.id)! }));
  }
  if (by === "feature") {
    const ranked = [...ctx.features].sort((a, b) => a.rank - b.rank);
    const known = new Set(ranked.map((f) => f.id));
    const groups: Group[] = ranked.filter((f) => buckets.has(f.id)).map((f) => ({ by, id: f.id, feature: f, tasks: buckets.get(f.id)! }));
    for (const [id, list] of buckets) if (!known.has(id)) groups.push({ by, id, feature: undefined, tasks: list });
    return groups;
  }
  const holders = [...buckets.keys()].filter((id) => id !== "").sort((a, b) => ctx.holderName(a).localeCompare(ctx.holderName(b)));
  const groups: Group[] = holders.map((id) => ({ by, id, holderId: id, tasks: buckets.get(id)! }));
  if (buckets.has("")) groups.push({ by, id: "", holderId: undefined, tasks: buckets.get("")! });
  return groups;
}

export type Display = {
  group: GroupBy;
  order: Order;
  showDone: boolean;
  showDropped: boolean;
  /** The Tasks of shipped and dropped Features. */
  showEndedFeatures: boolean;
};

export const defaultDisplay: Display = { group: "status", order: "rank", showDone: true, showDropped: false, showEndedFeatures: true };

export type Filters = { skill?: string; holder?: string; blocked?: boolean };

/** Whether a Task passes the Filter popover's choices: the Skill it needs, who holds it, blocked. */
export function passesFilters(task: Task, filters: Filters, now: number): boolean {
  if (filters.skill && task.skill_id !== filters.skill) return false;
  if (filters.holder && liveClaim(task, now)?.holder_id !== filters.holder) return false;
  if (filters.blocked && !task.blocked) return false;
  return true;
}

/**
 * The Tasks a view shows: the Filter's choices, then the Display's: the Tasks of ended Features,
 * and (when `kinds` is given, as the list does) those in a Done or Dropped Status.
 */
export function visibleTasks(
  tasks: Task[],
  ctx: { display: Display; filters: Filters; features: Map<string, Feature>; statuses: Map<string, Status>; now: number; byKind: boolean },
): Task[] {
  const { display } = ctx;
  return tasks.filter((t) => {
    if (!passesFilters(t, ctx.filters, ctx.now)) return false;
    const f = ctx.features.get(t.feature_id);
    if (!display.showEndedFeatures && f && f.state !== "open") return false;
    if (ctx.byKind) {
      const kind = ctx.statuses.get(t.status_id)?.kind;
      if (kind === "done" && !display.showDone) return false;
      if (kind === "dropped" && !display.showDropped) return false;
    }
    return true;
  });
}

/** What the Activity says about a Task's Claims that a Task in a list does not carry. */
export type ClaimTrail = {
  /** When its last Claim lapsed, if the last Claim it had ended by a lapse. */
  lapsedAt?: string;
  /** Who completed it. */
  completedBy?: string;
};

/** The Activity kinds `claimTrails` reads. */
export const trailKinds = ["task.claimed", "task.lapsed", "task.completed"] as const;

/**
 * Reads a Task's Claim history from the Activity, since /v1/tasks gives a Task's Claim only while
 * it is live: a Task whose latest Claim entry is a lapse lapsed at that entry's time; a later
 * claim clears it. `entries` may come in any order and may repeat.
 */
export function claimTrails(entries: Activity[]): Map<string, ClaimTrail> {
  const seen = new Set<number>();
  const sorted = entries.filter((e) => !seen.has(e.seq) && seen.add(e.seq)).sort((a, b) => a.seq - b.seq);
  const out = new Map<string, ClaimTrail>();
  for (const e of sorted) {
    const t = out.get(e.subject_id) ?? {};
    if (e.kind === "task.claimed") t.lapsedAt = undefined;
    else if (e.kind === "task.lapsed") t.lapsedAt = e.at;
    else if (e.kind === "task.completed") t.completedBy = e.actor_id;
    else continue;
    out.set(e.subject_id, t);
  }
  return out;
}

/** When the Task's last Claim lapsed, for an open Task nobody holds now. */
export function lapsedAt(task: Task, trail: ClaimTrail | undefined, now: number): string | undefined {
  if (task.state !== "open" || liveClaim(task, now)) return undefined;
  return trail?.lapsedAt;
}

/** The open Tasks each Task blocks, read off the `open_blockers` of the Tasks in view. */
export function blocking(tasks: Task[]): Map<string, TaskBrief[]> {
  const out = new Map<string, TaskBrief[]>();
  for (const t of tasks) {
    if (t.state !== "open") continue;
    for (const b of t.open_blockers ?? []) {
      const list = out.get(b.id);
      if (list) list.push({ id: t.id, key: t.key });
      else out.set(b.id, [{ id: t.id, key: t.key }]);
    }
  }
  return out;
}

export type Mark =
  | { kind: "blocked"; by: string }
  | { kind: "lapsed"; at: string }
  | { kind: "task-kind"; label: "Break down" | "Retrospective" };

/** The marks a Task carries, most pressing first; a card shows the first, a row all of them. */
export function marksOf(task: Task, trail: ClaimTrail | undefined, now: number): Mark[] {
  const marks: Mark[] = [];
  if (task.state === "open" && task.blocked) marks.push({ kind: "blocked", by: task.open_blockers?.[0]?.key ?? "" });
  const lapsed = lapsedAt(task, trail, now);
  if (lapsed) marks.push({ kind: "lapsed", at: lapsed });
  if (task.kind === "breakdown") marks.push({ kind: "task-kind", label: "Break down" });
  if (task.kind === "retrospective") marks.push({ kind: "task-kind", label: "Retrospective" });
  return marks;
}

/** What a toast says when a drag is refused, and the action that resolves it. */
export type RefusalNote = {
  title: string;
  body: string;
  action?: { kind: "claim" | "open"; label: string };
};

/**
 * Words for a refused move of `task` to `target`, from the refusal's stable code. Claim is offered
 * when the Task is takeable by the mover; the holder is sent to the Task to Complete it, the
 * Feature owner to Drop it.
 */
export function refusalNote(
  code: string,
  ctx: {
    task: Pick<Task, "key">;
    target: Pick<Status, "name">;
    takeable: boolean;
    holds: boolean;
    owns: boolean;
    ownerName?: string;
    teamName: string;
    message: string;
  },
): RefusalNote {
  const key = ctx.task.key;
  const title = `Not moved to ${ctx.target.name}`;
  switch (code) {
    case "use_complete":
      if (ctx.holds) return { title, body: `Complete ${key} to move it to ${ctx.target.name}.`, action: { kind: "open", label: `Open ${key}` } };
      return {
        title,
        body: `${ctx.target.name} is reached by completing a Task you hold.`,
        action: ctx.takeable ? { kind: "claim", label: `Claim ${key}` } : undefined,
      };
    case "use_drop":
      if (ctx.owns) return { title, body: `Drop ${key} to move it to ${ctx.target.name}.`, action: { kind: "open", label: `Open ${key}` } };
      return { title, body: `Only the Feature owner${ctx.ownerName ? `, ${ctx.ownerName},` : ""} can drop ${key}.` };
    case "forbidden":
      return { title, body: `Only Members of ${ctx.teamName} move its Tasks.` };
    case "conflict":
      return { title, body: `${key} has ended and stays where it is.` };
    default:
      return { title, body: ctx.message };
  }
}

/** The 1-based position a Feature dropped onto `overId` takes in the Team's whole Rank, ended Features counted. */
export function rankPosition(ranked: Pick<Feature, "id">[], overId: string): number {
  const i = ranked.findIndex((f) => f.id === overId);
  return i < 0 ? ranked.length : i + 1;
}

/** The Team's Features after moving `activeId` to `position`, renumbered as the server ranks them. */
export function moveFeature<T extends Pick<Feature, "id" | "rank">>(ranked: T[], activeId: string, position: number): T[] {
  const list = [...ranked].sort((a, b) => a.rank - b.rank);
  const from = list.findIndex((f) => f.id === activeId);
  if (from < 0) return list;
  const [moved] = list.splice(from, 1);
  list.splice(Math.min(Math.max(position - 1, 0), list.length), 0, moved);
  return list.map((f, i) => ({ ...f, rank: i + 1 }));
}

/** A Feature's Task bar: the share of its Tasks done, held, and open but not held, in percent. */
export function taskBar(counts: TaskCounts): { done: number; held: number; waiting: number } {
  const total = counts.open + counts.done + counts.dropped;
  if (total === 0) return { done: 0, held: 0, waiting: 0 };
  const pct = (n: number) => (n / total) * 100;
  return { done: pct(counts.done), held: pct(counts.claimed), waiting: pct(counts.open - counts.claimed) };
}

/** "1 done · 2 open · 1 dropped": dropped only when there are any. */
export function countsText(counts: TaskCounts): string {
  const parts = [`${counts.done} done`, `${counts.open} open`];
  if (counts.dropped > 0) parts.push(`${counts.dropped} dropped`);
  return parts.join(" · ");
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** A time as a row shows it: "22:18" today, "6 Oct" this year, "6 Oct 2025" before. */
export function shortWhen(at: string, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return clock.format(d);
  return d.getFullYear() === n.getFullYear() ? day.format(d) : dayYear.format(d);
}
