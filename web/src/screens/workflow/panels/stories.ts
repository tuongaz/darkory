import type { Activity, RunnerSession, Task } from "@/api/client";
import { progressText } from "@/screens/inbox/derive";
import { liveClaim } from "@/work";
import { flowKinds, storyVerb, type FlowContext } from "../flowEvents";
import { ageText } from "./needs";

// What's happening, kept free of React so the tests read it as data: one story per Task that
// changed, newest change first, each with its latest change in the glossary's words and its path
// today; a Task's history opened into a bar of waiting and worked time with its entries; and when
// the Project has gone quiet.

/** How long without a change before What's happening folds to one line. */
export const quietMs = 60 * 60_000;
/** How long a change reads "now", amber. */
export const nowMs = 60_000;

/** A Step the Task spent time at today, and how long; `current` is where it is now. */
export type PathStep = { stepId: string; name: string; ms?: number; current?: boolean };

export type Story = {
  taskId: string;
  key: string;
  title: string;
  task?: Task;
  /** The newest entry the row tells. */
  latest: Activity;
  /** That entry in words: "qa picked up". */
  verb: string;
  /** The Steps it was at today, the current one last. */
  path: PathStep[];
  /** The muted fact after the path: "waited 7m", "waiting 12m", "Blocked by 2", "1 of 6 done", "Done". */
  tail?: string;
  /** The Runner's session on it waits for the agent to end the Task (it nudges it). */
  nudged: boolean;
  /** Changed since the Member last looked: above the divider, on two lines. */
  fresh: boolean;
  /** Its latest change is less than a minute old. */
  now: boolean;
};

export type StoriesInput = {
  /** The Project's flow entries, any order. */
  entries: Activity[];
  /** The Project's Tasks by id, ended ones included. */
  tasks: Map<string, Task>;
  ctx: FlowContext;
  /** The Tasks Needs you lists: they get no row. */
  exclude: Set<string>;
  sessions: RunnerSession[];
  now: number;
  /** The earliest change a row tells: the start of the day. */
  from: number;
  /** The newest entry the Member has seen, or null before they first looked. */
  seenSeq: number | null;
};

const flow = new Set<string>(flowKinds);
// The entries by which a Subtask's story belongs to its Parent's row: its filing and its end.
const foldsIntoParent = new Set<string>(["task.filed", "task.completed", "task.dropped"]);
// The entries that end a Task's stay at a Step, carrying `from` and `since`.
const leaves = new Set<string>(["task.advanced", "task.moved", "task.completed", "task.dropped", "task.became_parent"]);

function str(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

function num(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" ? v : undefined;
}

/** The row an entry belongs to: its Task's, or its Parent's for a Subtask's filing and end. */
export function rowOf(e: Activity, tasks: Map<string, Task>): { rowId: string; sub?: string } {
  const t = tasks.get(e.subject_id);
  const parent = t?.parent_id ?? str(e.payload, "parent_id");
  if (parent && foldsIntoParent.has(e.kind)) return { rowId: parent, sub: t?.key ?? str(e.payload, "key") };
  return { rowId: e.subject_id };
}

const stepName = (ctx: FlowContext, id: string | undefined) => (id ? ctx.workflow.steps.find((s) => s.id === id)?.name : undefined);

/** The Steps a Task was at from `from` on, from the entries that left them, then where it is now. */
export function pathOf(own: Activity[], task: Task | undefined, ctx: FlowContext, from: number): PathStep[] {
  const out: PathStep[] = [];
  for (const e of [...own].sort((a, b) => a.seq - b.seq)) {
    if (!leaves.has(e.kind) || Date.parse(e.at) < from) continue;
    const at = str(e.payload, "from");
    const name = stepName(ctx, at);
    if (!at || !name) continue;
    const since = num(e.payload, "since");
    out.push({ stepId: at, name, ms: since !== undefined ? Date.parse(e.at) - since : undefined });
  }
  if (task?.state === "open" && task.step_id) {
    const name = stepName(ctx, task.step_id);
    if (name) out.push({ stepId: task.step_id, name, current: true });
  }
  return out;
}

/** The fact after the path: how long it waited or has waited at its Step, what blocks it, a Parent's progress, how it ended. */
export function tailOf(task: Task | undefined, now: number): string | undefined {
  if (!task) return undefined;
  if (task.state === "done") return "Done";
  if (task.state === "dropped") return "Dropped";
  if (task.subtask_counts) return progressText(task.subtask_counts);
  if (task.blocked) {
    const n = task.open_blockers?.length ?? 0;
    return n === 1 ? `Blocked by ${task.open_blockers![0].key}` : `Blocked by ${n || "another Task"}`;
  }
  if (!task.step_since) return undefined;
  const reached = Date.parse(task.step_since);
  const claim = liveClaim(task, now);
  if (claim) {
    const waited = Date.parse(claim.started_at) - reached;
    return waited >= 60_000 ? `waited ${ageText(waited)}` : undefined;
  }
  return now - reached >= 60_000 ? `waiting ${ageText(now - reached)}` : undefined;
}

/**
 * One row per Task with a change since `from` (or since the Member last looked, whichever is
 * earlier), newest change first. A Subtask's filing and end fold into its Parent's row; its other
 * moves are its own story. A Task Needs you lists gets no row. Only the entries that trace a Task
 * through the Workflow count: the Runner's housekeeping is not a story, and its nudge is a flag.
 */
export function storiesOf(input: StoriesInput): Story[] {
  const { entries, tasks, ctx, exclude, sessions, now, from, seenSeq } = input;
  const byRow = new Map<string, { latest: Activity; sub?: string; own: Activity[]; all: Activity[] }>();
  for (const e of entries) {
    if (e.subject_type !== "task" || !flow.has(e.kind)) continue;
    const { rowId, sub } = rowOf(e, tasks);
    const row = byRow.get(rowId) ?? { latest: e, sub, own: [], all: [] };
    row.all.push(e);
    if (e.seq >= row.latest.seq) {
      row.latest = e;
      row.sub = sub;
    }
    if (!sub) row.own.push(e);
    byRow.set(rowId, row);
  }
  const out: Story[] = [];
  for (const [taskId, row] of byRow) {
    if (exclude.has(taskId)) continue;
    const fresh = seenSeq === null ? true : row.latest.seq > seenSeq;
    if (Date.parse(row.latest.at) < from && !fresh) continue;
    const task = tasks.get(taskId);
    // A run of Subtasks filed (or ended) by one Member folds into one change: "ada filed 4 Subtasks".
    let run = 0;
    if (row.sub) {
      for (const e of [...row.all].sort((a, b) => b.seq - a.seq)) {
        if (e.kind !== row.latest.kind || e.actor_id !== row.latest.actor_id || e.subject_id === taskId) break;
        run++;
      }
    }
    const verb = storyVerb(row.latest, ctx, run > 1 ? `${run} Subtasks` : row.sub);
    if (!verb) continue;
    out.push({
      taskId,
      key: task?.key ?? str(row.latest.payload, "key") ?? "a Task",
      title: task?.title ?? str(row.latest.payload, "title") ?? "",
      task,
      latest: row.latest,
      verb,
      path: task?.subtask_counts ? [] : pathOf(row.own, task, ctx, from),
      tail: tailOf(task, now),
      nudged: sessions.some((s) => s.task_id === taskId && s.state === "waiting"),
      fresh,
      now: now - Date.parse(row.latest.at) < nowMs,
    });
  }
  return out.sort((a, b) => b.latest.seq - a.latest.seq);
}

/**
 * Whether What's happening folds to one line: nothing changed in the last hour, and nothing since
 * the Member last looked (before they first look, only the hour counts).
 */
export function isQuiet(entries: Activity[], now: number, seenSeq: number | null): boolean {
  for (const e of entries) {
    if (e.subject_type !== "task" || !flow.has(e.kind)) continue;
    if (now - Date.parse(e.at) < quietMs) return false;
    if (seenSeq !== null && e.seq > seenSeq) return false;
  }
  return true;
}

// ---------------------------------------------------------------- a story opened into its path

/** A stretch of the path bar: waiting at a Step (hatched), worked there (solid), or blocked (hatched red). */
export type Segment = { stepId: string; name: string; kind: "wait" | "work" | "blocked"; from: number; to: number; live?: boolean };

/** One line under the bar: the clock, the change in words, and the time it closed or has run. */
export type StoryEntry = { seq: number; at: string; text: string; detail?: string; live?: boolean; count?: number };

// What a line under the bar folds by: the same change by the same Member, and the Subtasks it named.
type Folding = { kind: string; actor?: string; subs: string[] };

/** The bar's stays: one label per Step visit, over its segments. */
export type Stay = { stepId: string; name: string; from: number; to: number };

/**
 * A Task's path today as the opened row draws it, from its own entries (`GET /v1/activity?task=`):
 * each stay at a Step split into the time it waited (hatched; red while blocked) and the time it
 * was worked (solid), from its first change today to now.
 */
export function segmentsOf(own: Activity[], task: Task | undefined, ctx: FlowContext, now: number, from: number): { segments: Segment[]; stays: Stay[] } {
  const sorted = [...own].filter((e) => e.subject_id === task?.id || !task).sort((a, b) => a.seq - b.seq);
  const segments: Segment[] = [];
  const stays: Stay[] = [];
  let step: string | undefined;
  let mark = 0;
  let worked = false;
  const close = (to: number) => {
    const name = stepName(ctx, step);
    if (step && name && to > mark) segments.push({ stepId: step, name, kind: worked ? "work" : "wait", from: mark, to });
  };
  const arrive = (to: string | undefined, at: number) => {
    const name = stepName(ctx, to);
    step = to && name ? to : undefined;
    mark = at;
    worked = false;
    if (step && name) stays.push({ stepId: step, name, from: at, to: at });
  };
  for (const e of sorted) {
    const at = Date.parse(e.at);
    switch (e.kind) {
      case "task.filed":
        arrive(str(e.payload, "step_id"), at);
        break;
      case "task.claimed":
        close(at);
        mark = at;
        worked = true;
        break;
      case "task.released":
      case "task.lapsed":
      case "task.taken_back":
      case "task.claim_ended":
        close(at);
        mark = at;
        worked = false;
        break;
      case "task.advanced":
      case "task.moved":
        if (!step) {
          // The first change read leaves a Step it reached earlier: start there, at its `since`.
          const since = num(e.payload, "since");
          arrive(str(e.payload, "from"), since ?? at);
        }
        close(at);
        if (stays.length) stays[stays.length - 1].to = at;
        arrive(str(e.payload, "to"), at);
        break;
      case "task.completed":
      case "task.dropped":
      case "task.became_parent":
        close(at);
        if (stays.length) stays[stays.length - 1].to = at;
        step = undefined;
        break;
    }
  }
  if (step && task?.state === "open") {
    const name = stepName(ctx, step)!;
    segments.push({ stepId: step, name, kind: worked ? "work" : task.blocked ? "blocked" : "wait", from: mark, to: now, live: true });
    if (stays.length) stays[stays.length - 1].to = now;
  } else if (!step && task?.state === "open" && task.step_id && task.step_since) {
    // Nothing read today moved it: it has been at its Step since `step_since`.
    const name = stepName(ctx, task.step_id);
    const reached = Date.parse(task.step_since);
    const claim = liveClaim(task, now);
    if (name) {
      if (claim && Date.parse(claim.started_at) > reached) segments.push({ stepId: task.step_id, name, kind: "wait", from: reached, to: Date.parse(claim.started_at) });
      segments.push({
        stepId: task.step_id,
        name,
        kind: claim ? "work" : task.blocked ? "blocked" : "wait",
        from: claim ? Math.max(reached, Date.parse(claim.started_at)) : reached,
        to: now,
        live: true,
      });
      stays.push({ stepId: task.step_id, name, from: reached, to: now });
    }
  }
  const clip = <T extends { from: number; to: number }>(xs: T[]) => xs.filter((x) => x.to > from).map((x) => ({ ...x, from: Math.max(x.from, from) }));
  return { segments: clip(segments), stays: clip(stays) };
}

/**
 * The opened row's entries, oldest first, in the trail's words with the time each closed: "builder
 * picked up · waited 22m", "builder advanced along pass · 8m"; a run of the same change by the same
 * Member folds into one line: the Subtasks it filed or ended named together ("ada filed WEB-18,
 * WEB-19"), any other change counted ("×3"). The Task's state now closes the list: "qa picked up ·
 * waited 7m · 5m so far", or "still waiting · 7m so far".
 */
export function entriesOf(own: Activity[], task: Task | undefined, ctx: FlowContext, now: number): StoryEntry[] {
  const sorted = [...own].filter((e) => flow.has(e.kind)).sort((a, b) => a.seq - b.seq);
  const out: StoryEntry[] = [];
  const folds: Folding[] = [];
  let reached: number | undefined;
  let claimed: number | undefined;
  for (const e of sorted) {
    const at = Date.parse(e.at);
    const sub = task && e.subject_id !== task.id ? (ctx.task(e.subject_id)?.key ?? str(e.payload, "key")) : undefined;
    const words = storyVerb(e, ctx, sub);
    if (!words) continue;
    let detail: string | undefined;
    if (!sub) {
      switch (e.kind) {
        case "task.filed":
          detail = stepName(ctx, str(e.payload, "step_id"));
          reached = at;
          break;
        case "task.claimed":
          if (reached !== undefined && at - reached >= 60_000) detail = `waited ${ageText(at - reached)}`;
          claimed = at;
          break;
        case "task.advanced":
        case "task.moved":
        case "task.completed": {
          const since = num(e.payload, "since");
          const start = claimed ?? since;
          if (start !== undefined && at - start >= 60_000) detail = ageText(at - start);
          if (e.kind !== "task.completed") detail = [detail, stepName(ctx, str(e.payload, "to")) && `to ${stepName(ctx, str(e.payload, "to"))}`].filter(Boolean).join(" · ");
          reached = at;
          claimed = undefined;
          break;
        }
        case "task.released":
        case "task.lapsed":
        case "task.taken_back":
          claimed = undefined;
          reached = at;
          break;
      }
    }
    const prev = out.at(-1);
    const fold = folds.at(-1);
    if (prev && fold && fold.kind === e.kind && fold.actor === e.actor_id && !detail && !prev.detail) {
      if (sub && fold.subs.length > 0) {
        fold.subs.push(sub);
        prev.text = storyVerb(e, ctx, fold.subs.join(", ")) ?? prev.text;
      } else if (!sub && fold.subs.length === 0) {
        prev.count = (prev.count ?? 1) + 1;
      } else {
        out.push({ seq: e.seq, at: e.at, text: words });
        folds.push({ kind: e.kind, actor: e.actor_id, subs: sub ? [sub] : [] });
        continue;
      }
      prev.at = e.at;
      prev.seq = e.seq;
      continue;
    }
    out.push({ seq: e.seq, at: e.at, text: words, detail: detail || undefined });
    folds.push({ kind: e.kind, actor: e.actor_id, subs: sub ? [sub] : [] });
  }
  if (task?.state === "open" && !task.subtask_counts) {
    const claim = liveClaim(task, now);
    const last = out.at(-1);
    if (claim && last?.text.endsWith("picked up")) {
      last.live = true;
      last.detail = [last.detail, `${ageText(now - Date.parse(claim.started_at))} so far`].filter(Boolean).join(" · ");
    } else if (!claim && task.step_since) {
      const words = task.blocked ? "still blocked" : "still waiting";
      out.push({ seq: Number.MAX_SAFE_INTEGER, at: new Date(now).toISOString(), text: words, detail: `${ageText(now - Date.parse(task.step_since))} so far`, live: true });
    }
  }
  return out;
}
