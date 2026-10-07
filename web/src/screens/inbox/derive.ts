import type { Activity, Feature, Member, RunnerSessionState, Task, TaskDetail } from "@/api/client";
import { liveClaim } from "@/work";

// The rules the four screens read, apart from rendering, so the tests can hold them to the mock.

/** How many Takeable Tasks the Inbox shows; My work shows them all. */
export const takeableCap = 3;

/**
 * The Inbox's Takeable now: the takeable Tasks in `next` order, less those already shown under
 * Aimed at me (a Task aimed at me is also takeable by me), and at most `takeableCap` of them.
 */
export function takeableNow(takeable: Task[], aimedAtMe: Task[]): { shown: Task[]; total: number } {
  const aimed = new Set(aimedAtMe.map((t) => t.id));
  const rest = takeable.filter((t) => !aimed.has(t.id));
  return { shown: rest.slice(0, takeableCap), total: rest.length };
}

/** The open Tasks `task` blocks: the question's "blocks WEB-3". */
export function blocksOf(task: Task, openTasks: Task[]): Task[] {
  return openTasks.filter((t) => t.open_blockers?.some((b) => b.id === task.id));
}

export type OwnedFeature = {
  feature: Feature;
  /** Open Tasks of the Feature that are blocked. */
  blocked: number;
  /** The open Break down Task, while the Feature has one. */
  breakdown?: Task;
  /** The open Retrospective of a shipped or dropped Feature. */
  retrospective?: Task;
};

/**
 * Features I own that still need something: every open one, and a shipped or dropped one while
 * its Retrospective is open. `features` is the owner's, in Team then Rank order.
 */
export function featuresIOwn(features: Feature[], openTasks: Task[]): OwnedFeature[] {
  const byFeature = new Map<string, Task[]>();
  for (const t of openTasks) byFeature.set(t.feature_id, [...(byFeature.get(t.feature_id) ?? []), t]);
  const out: OwnedFeature[] = [];
  for (const feature of features) {
    const tasks = byFeature.get(feature.id) ?? [];
    if (feature.state === "open") {
      out.push({
        feature,
        blocked: tasks.filter((t) => t.blocked).length,
        breakdown: tasks.find((t) => t.kind === "breakdown"),
      });
      continue;
    }
    const retrospective = tasks.find((t) => t.kind === "retrospective");
    if (retrospective) out.push({ feature, blocked: 0, retrospective });
  }
  return out;
}

/** The share of a Feature's Tasks in each part of its bar: done, held, open and not held, out of all of them. */
export function featureBar(f: Feature): { done: number; held: number; waiting: number } {
  const c = f.task_counts;
  const total = c.open + c.done + c.dropped;
  if (total === 0) return { done: 0, held: 0, waiting: 0 };
  return { done: c.done / total, held: c.claimed / total, waiting: (c.open - c.claimed) / total };
}

/** The open Retrospective Tasks of Features in `teamIds`: where a proposal of mine may wait. */
export function retrospectivesIn(openTasks: Task[], features: Map<string, Feature>, teamIds: Set<string>): Task[] {
  return openTasks.filter((t) => t.kind === "retrospective" && teamIds.has(features.get(t.feature_id)?.team_id ?? ""));
}

/** My proposals: the Retrospectives carrying a pending Skill proposal `memberId` wrote. */
export function myProposals(details: TaskDetail[], memberId: string): TaskDetail[] {
  return details.filter((d) => d.proposal?.state === "pending" && d.proposal.author_id === memberId);
}

// ---------------------------------------------------------------- Agents

/** The Claim kinds an agent's history is made of; the first starts a Claim, the rest end one. */
export const claimKinds = [
  "task.claimed",
  "task.completed",
  "task.handed_over",
  "task.released",
  "task.lapsed",
  "task.taken_back",
  "task.claim_ended",
  "task.dropped",
] as const satisfies Activity["kind"][];

// The holder acts these ends; the others name the holder in the payload (no one, or someone else, acted).
const endedByHolder = new Set<string>(["task.completed", "task.handed_over", "task.released"]);
const endedForHolder = new Set<string>(["task.lapsed", "task.taken_back", "task.claim_ended", "task.dropped"]);

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" ? v : undefined;
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === "number" ? v : undefined;
}

/** The Member whose Claim a Claim entry starts or ends, or undefined for any other entry. */
export function claimHolder(e: Activity): string | undefined {
  if (e.kind === "task.claimed" || endedByHolder.has(e.kind)) return e.actor_id;
  if (endedForHolder.has(e.kind)) return str(e.payload, "holder_id");
  return undefined;
}

const dayMs = 24 * 60 * 60 * 1000;

/** The lapses of `memberId`'s Claims in the 24 hours before `now`, newest first. */
export function lapsesIn24h(entries: Activity[], memberId: string, now: number): Activity[] {
  return entries
    .filter((e) => e.kind === "task.lapsed" && str(e.payload, "holder_id") === memberId && new Date(e.at).getTime() > now - dayMs)
    .sort((a, b) => b.seq - a.seq);
}

/** The newest entry that started or ended one of `memberId`'s Claims. */
export function lastClaimEntry(entries: Activity[], memberId: string): Activity | undefined {
  let last: Activity | undefined;
  for (const e of entries) if (claimHolder(e) === memberId && (!last || e.seq > last.seq)) last = e;
  return last;
}

export type AgentRow = {
  agent: Member;
  /** The Tasks it holds a live Claim on, the one lapsing first first. */
  held: Task[];
  /** When its first Claim lapses without a Heartbeat (Unix ms); absent when it holds none that can. */
  deadline?: number;
};

// Where a runner session's state puts its agent: a Stalled one first, then a Waiting one.
const stateBands: Partial<Record<RunnerSessionState, number>> = { stalled: -2, waiting: -1 };

/**
 * The agent Members for the Agents table: those whose runner session is Stalled, then Waiting
 * (`stateOf` says, by Member id); then those holding a live Claim, the one whose Heartbeat is due
 * first at the top and Member-bound Claims after the timed ones; then the idle ones; deactivated
 * agents last. Names break ties.
 */
export function agentRows(
  members: Member[],
  openTasks: Task[],
  now: number,
  stateOf: (memberId: string) => RunnerSessionState | undefined = () => undefined,
): AgentRow[] {
  const held = new Map<string, Task[]>();
  for (const t of openTasks) {
    const c = liveClaim(t, now);
    if (c) held.set(c.holder_id, [...(held.get(c.holder_id) ?? []), t]);
  }
  const expiry = (t: Task) => (t.claim?.expires_at ? new Date(t.claim.expires_at).getTime() : Infinity);
  const rows = members
    .filter((m) => m.kind === "agent")
    .map((agent): AgentRow => {
      const tasks = (held.get(agent.id) ?? []).sort((a, b) => expiry(a) - expiry(b));
      const first = tasks[0] ? expiry(tasks[0]) : Infinity;
      return { agent, held: tasks, deadline: Number.isFinite(first) ? first : undefined };
    });
  const band = (r: AgentRow) => {
    if (r.agent.deactivated_at) return 3;
    const state = stateOf(r.agent.id);
    if (state && stateBands[state] !== undefined) return stateBands[state];
    return r.held.length === 0 ? 2 : r.deadline === undefined ? 1 : 0;
  };
  return rows.sort(
    (a, b) => band(a) - band(b) || (a.deadline ?? 0) - (b.deadline ?? 0) || a.agent.name.localeCompare(b.agent.name),
  );
}

export type ClaimRecord = {
  claimId: string;
  taskId: string;
  claimedAt: string;
  skillId?: string;
  modelLabel?: string;
  timeoutSeconds?: number;
  /** The entry that ended the Claim, while known. */
  end?: Activity;
};

/** The Claims `memberId` made at or after `since` (Unix ms), oldest first, each with the entry that ended it. */
export function claimsSince(entries: Activity[], memberId: string, since: number): ClaimRecord[] {
  const records = new Map<string, ClaimRecord>();
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  for (const e of sorted) {
    const claimId = str(e.payload, "claim_id");
    if (!claimId) continue;
    if (e.kind === "task.claimed") {
      if (e.actor_id !== memberId || new Date(e.at).getTime() < since) continue;
      records.set(claimId, {
        claimId,
        taskId: e.subject_id,
        claimedAt: e.at,
        skillId: str(e.payload, "skill_id"),
        modelLabel: str(e.payload, "model_label"),
        timeoutSeconds: num(e.payload, "heartbeat_timeout_seconds"),
      });
    } else if (claimHolder(e) === memberId) {
      const r = records.get(claimId);
      if (r && !r.end) r.end = e;
    }
  }
  return [...records.values()];
}

/** The start of the local day `now` falls in (Unix ms). */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------- Activity

export type ActivityFilter = { member?: string; kind?: string; team?: string };

/** Where the Activity page finds a Task's Feature and a Feature's Team, for the Team filter. */
export type Placement = { taskFeature: (taskId: string) => string | undefined; featureTeam: (featureId: string) => string | undefined };

/**
 * Whether an entry from the stream belongs on a filtered Activity page, by the rule /v1 applies to
 * `member`, `kind` and `team` (ids): the Member acted in it or held the Claim it ended; it is of
 * the kind; it is about a Feature of the Team or a Task of one.
 */
export function matchesFilter(e: Activity, f: ActivityFilter, where: Placement): boolean {
  if (f.kind && e.kind !== f.kind) return false;
  if (f.member && e.actor_id !== f.member && !(endedForHolder.has(e.kind) && str(e.payload, "holder_id") === f.member)) return false;
  if (f.team) {
    let feature: string | undefined;
    if (e.subject_type === "feature") feature = e.subject_id;
    else if (e.subject_type === "task") feature = where.taskFeature(e.subject_id) ?? str(e.payload, "feature_id");
    if (!feature || where.featureTeam(feature) !== f.team) return false;
  }
  return true;
}

export type MinuteGroup = { key: string; label: string; entries: Activity[] };

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const shortDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "Today", "Yesterday", or the day as "Mon 6 Oct". */
export function dayLabel(at: Date, now: number): string {
  const today = startOfDay(now);
  const day = startOfDay(at.getTime());
  if (day === today) return "Today";
  if (day === startOfDay(today - 1)) return "Yesterday";
  return shortDay.format(at).replace(",", "");
}

/** Entries, newest first, in runs of one minute each, labelled "Today, 22:18". */
export function groupByMinute(entries: Activity[], now: number): MinuteGroup[] {
  const groups: MinuteGroup[] = [];
  for (const e of entries) {
    const at = new Date(e.at);
    const minute = new Date(at);
    minute.setSeconds(0, 0);
    const key = String(minute.getTime());
    const last = groups.at(-1);
    if (last?.key === key) last.entries.push(e);
    else groups.push({ key, label: `${dayLabel(at, now)}, ${clock.format(at)}`, entries: [e] });
  }
  return groups;
}

/** How long something has waited: "< 1 min", "4 min", "3 h", "2 d". */
export function sinceText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "< 1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** "1 Task", "3 Tasks": a number with its noun. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The Skill a Task needs now, or that its Claim was made under. */
export function skillOf(task: Task, skills: Map<string, { name: string }>): string | undefined {
  const id = task.claim?.skill_id ?? task.skill_id;
  return id ? skills.get(id)?.name : undefined;
}

/** "70 B", "1.2 kB", "3.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
