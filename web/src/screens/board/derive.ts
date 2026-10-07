// What the Board screens compute from /v1 records: Status glyphs, the order and grouping of Tasks,
// the marks a row or card carries, what a refused drag says, and the Features' Task bars. Pure, so
// Vitest checks them without rendering.
import type { Activity, Feature, Task, TaskBrief, TaskCounts } from "@/api/client";
import type { components } from "@/api/schema.gen";
import { passesDate } from "@/components/filters/dates";
import type { FilterPill } from "@/components/filters/filterState";
import { glyphFor, type Glyph } from "@/lib/status";
import { kindLabel, liveClaim } from "@/work";

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

/** The Held by value of a Task nobody holds. */
export const nobody = "none";

/** The Kind axis' values: a Task's kind, with a work Task aimed at a Member by name as a question. */
export type KindValue = Task["kind"] | "question";

export function kindValue(task: Pick<Task, "kind" | "aimed_at_id">): KindValue {
  return task.kind === "work" && task.aimed_at_id ? "question" : task.kind;
}

/**
 * What `matches` reads beyond the Task: the clock, the Team's Features, and for the Claim axis
 * the Claim trails (lapses) and the Tasks a Runner session works now.
 */
export type FilterContext = {
  now: number;
  features: Map<string, Pick<Feature, "owner_id">>;
  trails?: Map<string, ClaimTrail>;
  sessions?: ReadonlySet<string>;
};

/** The time the list's Updated column shows: when the Task ended, else when it began waiting. */
export function updatedAt(task: Pick<Task, "state" | "ended_at" | "waiting_since">): string {
  return task.state !== "open" ? (task.ended_at ?? task.waiting_since) : task.waiting_since;
}

/** A Task's time on each date axis; a Task not completed has no Completed time. */
const taskTimes: Record<string, (t: Task) => string | undefined> = {
  filed_at: (t) => t.created_at,
  updated_at: updatedAt,
  completed_at: (t) => (t.state === "done" ? t.ended_at : undefined),
};

/** How long a lapse counts as recent on the Claim axis. */
const lapseWindowMs = 24 * 60 * 60 * 1000;

/**
 * The Claim axis' values of a Task, as many as hold: held (a live Claim), unheld (open, nobody
 * holding it), lapsed (its last Claim lapsed in the past 24 hours), session (a Runner session
 * works it now).
 */
export function claimValues(task: Task, ctx: FilterContext): string[] {
  const out: string[] = [];
  const held = !!liveClaim(task, ctx.now);
  if (held) out.push("held");
  else if (task.state === "open") out.push("unheld");
  const lapsed = lapsedAt(task, ctx.trails?.get(task.id), ctx.now);
  if (lapsed && ctx.now - Date.parse(lapsed) <= lapseWindowMs) out.push("lapsed");
  if (ctx.sessions?.has(task.id)) out.push("session");
  return out;
}

/**
 * A Task's values on an axis of the Filter: one for most, as many as it names for its Workspaces,
 * none when it has none (a Task aimed at a Member needs no Skill). Undefined for an axis the
 * Tasks do not have.
 */
export function taskValues(task: Task, field: string, ctx: FilterContext): string[] | undefined {
  const one = (v: string | undefined) => (v ? [v] : []);
  switch (field) {
    case "status":
      return [task.status_id];
    case "skill":
      return one(task.skill_id);
    case "holder":
      return [liveClaim(task, ctx.now)?.holder_id ?? nobody];
    case "aimed_at":
      return one(task.aimed_at_id);
    case "feature":
      return [task.feature_id];
    case "owner":
      return one(ctx.features.get(task.feature_id)?.owner_id);
    case "filed_by":
      return [task.filed_by];
    case "blocked":
      return [String(task.state === "open" && task.blocked)];
    case "kind":
      return [kindValue(task)];
    case "workspace":
      return task.workspace_ids ?? [];
    case "claim":
      return claimValues(task, ctx);
    default:
      return undefined;
  }
}

/**
 * Whether values pass a pill: `is` and `in` when any value is one of the pill's, `not` and `nin`
 * when none is. So on an axis with several values (Workspaces) "is not X" means none of them is X,
 * and on an axis with none, every "not" passes and every "is" fails.
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
  const words = (pill.values[0] ?? "").trim().toLowerCase();
  return !words || record.key.toLowerCase().includes(words) || record.title.toLowerCase().includes(words);
}

/**
 * Whether a Task passes every pill of the Filter: the axes are ANDed, the values of one axis ORed.
 * Search (`q`) matches the key or the title, ignoring case. A pill for an axis the Tasks do not
 * have narrows nothing.
 */
export function matches(task: Task, pills: readonly FilterPill[], ctx: FilterContext): boolean {
  return pills.every((pill) => {
    if (pill.field === "q") return searchMatches(task, pill);
    const time = taskTimes[pill.field];
    if (time) return passesDate(time(task), pill, ctx.now);
    const values = taskValues(task, pill.field, ctx);
    return values === undefined || passes(values, pill);
  });
}

/**
 * The Tasks a view shows: the Filter's pills, then the Display's: the Tasks of ended Features,
 * and (when `byKind` is set, as the list does) those in a Done or Dropped Status. A Status the
 * Filter asks for by name ("Status is Done") is shown whatever the Display says.
 */
export function visibleTasks(
  tasks: Task[],
  ctx: Omit<FilterContext, "features"> & {
    display: Display;
    pills: readonly FilterPill[];
    features: Map<string, Feature>;
    statuses: Map<string, Status>;
    byKind: boolean;
  },
): Task[] {
  const { display } = ctx;
  const status = ctx.pills.find((p) => p.field === "status" && (p.op === "is" || p.op === "in"));
  const asked = new Set(status?.values ?? []);
  return tasks.filter((t) => {
    if (!matches(t, ctx.pills, ctx)) return false;
    const f = ctx.features.get(t.feature_id);
    if (!display.showEndedFeatures && f && f.state !== "open") return false;
    if (ctx.byKind && !asked.has(t.status_id)) {
      const kind = ctx.statuses.get(t.status_id)?.kind;
      if (kind === "done" && !display.showDone) return false;
      if (kind === "dropped" && !display.showDropped) return false;
    }
    return true;
  });
}

/** A Feature's values on an axis of Team › Features' Filter; undefined for an axis it lacks. */
export function featureValues(feature: Feature, field: string): string[] | undefined {
  switch (field) {
    case "owner":
      return [feature.owner_id];
    case "state":
      return [feature.state];
    case "quick":
      return [String(feature.quick)];
    case "ship_when_done":
      return [String(feature.ship_when_done)];
    default:
      return undefined;
  }
}

/** A Feature's time on each date axis; an open Feature has no Ended time. */
const featureTimes: Record<string, (f: Feature) => string | undefined> = {
  filed_at: (f) => f.created_at,
  ended_at: (f) => f.ended_at,
};

/** Whether a Feature passes every pill, as `matches` reads them for a Task. */
export function matchesFeature(feature: Feature, pills: readonly FilterPill[], now: number): boolean {
  return pills.every((pill) => {
    if (pill.field === "q") return searchMatches(feature, pill);
    const time = featureTimes[pill.field];
    if (time) return passesDate(time(feature), pill, now);
    const values = featureValues(feature, pill.field);
    return values === undefined || passes(values, pill);
  });
}

/**
 * The Features a list shows, in Rank order: the Filter's pills, then the Display's "Shipped and
 * dropped", unless the Filter asks for the ended state by name.
 */
export function visibleFeatures(ranked: Feature[], ctx: { pills: readonly FilterPill[]; showEnded: boolean; now: number }): Feature[] {
  const state = ctx.pills.find((p) => p.field === "state" && (p.op === "is" || p.op === "in"));
  const asked = new Set(state?.values ?? []);
  return ranked.filter((f) => matchesFeature(f, ctx.pills, ctx.now) && (ctx.showEnded || f.state === "open" || asked.has(f.state)));
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
  // The kind, unless the title already says it ("Break down: Checkout").
  const label = kindLabel(task);
  if (label) marks.push({ kind: "task-kind", label });
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
      return { title, body: `Only Members of ${ctx.teamName}, the Feature owner or its holder move ${key}.` };
    case "ended":
    case "conflict":
      return { title, body: `${key} has ended and stays where it is.` };
    default:
      return { title, body: ctx.message };
  }
}

/**
 * Whether `member` may move the Task between open Statuses, as setTaskStatus allows: an open Task,
 * moved by a Member of its Feature's Team, the Feature's owner, or the Member holding it.
 */
export function mayMove(task: Task, ctx: { member: string; inTeam: boolean; feature: Pick<Feature, "owner_id"> | undefined; now: number }): boolean {
  if (task.state !== "open") return false;
  return ctx.inTeam || ctx.feature?.owner_id === ctx.member || liveClaim(task, ctx.now)?.holder_id === ctx.member;
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
