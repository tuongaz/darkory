import type { Activity } from "@/api/client";
// The same grace the Task's record gives a Shift's log after its Claim ends.
import { logGrace } from "@/screens/task/record";

/**
 * One row of the Activity: an entry, with what its actor wrote on the Task inside the Claim it
 * ends folded into it (oldest first). A Shift's log that has no Claim end to ride on names the
 * end of the Shift it belongs to when that end was read (`shiftEnded`).
 */
export type ActivityRow = { entry: Activity; folded: Activity[]; shiftEnded?: string };


/** The entries that end a Claim and say so; each carries the Claim's id. */
const ends = new Set<string>(["task.released", "task.advanced", "task.completed", "task.split", "task.lapsed", "task.taken_back", "task.claim_ended"]);
/** Ends written by someone other than the holder (Darkory, an admin), who are named in the payload. */
const endedForHolder = new Set<string>(["task.lapsed", "task.taken_back", "task.claim_ended"]);
/** What a holder writes inside a Claim that its end can carry. */
const inside = new Set<string>(["task.note_added", "task.observed", "task.evidence_attached", "task.filed"]);

const str = (p: Record<string, unknown>, key: string) => (typeof p[key] === "string" ? (p[key] as string) : undefined);

/**
 * A `task.evidence_attached` entry for a Shift's log. Entries written before Evidence had a kind
 * carry none: the Runner's file name says it, as migration 0008 read it.
 */
export function isShiftLog(e: Activity): boolean {
  if (e.kind !== "task.evidence_attached") return false;
  const kind = str(e.payload, "kind");
  if (kind) return kind === "log";
  return /^shift-.+-.+\.log$/.test(str(e.payload, "filename") ?? "");
}

/** Whose Claim on which Task an entry is about: a lapse's, take-back's or revocation's holder; a question's the Task it blocks. */
function claimKey(e: Activity): string | undefined {
  if (e.subject_type !== "task") return undefined;
  if (endedForHolder.has(e.kind)) {
    const holder = str(e.payload, "holder_id");
    return holder && `${holder} ${e.subject_id}`;
  }
  if (!e.actor_id) return undefined;
  if (e.kind === "task.filed") {
    const blocks = str(e.payload, "blocks");
    return blocks && `${e.actor_id} ${blocks}`;
  }
  return `${e.actor_id} ${e.subject_id}`;
}

/**
 * Folds the entries (newest first, the filters already applied) into rows, newest first. The
 * entries one actor writes on one Task after its `task.claimed` — the Notes, the Observations,
 * the Evidence, the questions it files to block the Task — ride on the entry that ends that Claim
 * (released, advanced, completed, split, lapsed, taken back, ended by a revoked token). Evidence
 * naming its Claim (`claim_id`) rides on that Claim's end, however late it came. A Shift's log
 * from before Evidence named its Claim rides on its holder's latest Claim end on that Task at
 * most 30 minutes before it, as the Task's record places it, else on the Claim it falls inside,
 * else it is its own row. What lies inside a Claim still held, or one whose end is not among the
 * entries, stays as rows. When the Claim's start was not read (an older page), the window runs
 * from the oldest entry read.
 */
export function foldActivity(entries: readonly Activity[]): ActivityRow[] {
  const asc = [...entries].sort((a, b) => a.seq - b.seq);
  const rows: ActivityRow[] = [];
  // What each actor has written on each Task since the last Claim start or end read.
  const open = new Map<string, { claim?: string; pending: Activity[] }>();
  // The Claim ends read so far, by actor and Task, for the logs that come after them, and by Claim.
  const ended = new Map<string, ActivityRow[]>();
  const endOf = new Map<string, ActivityRow>();
  const flush = (key: string) => {
    for (const e of open.get(key)?.pending ?? []) rows.push({ entry: e, folded: [] });
    open.delete(key);
  };

  for (const e of asc) {
    const key = claimKey(e);
    if (!key) {
      rows.push({ entry: e, folded: [] });
      continue;
    }
    if (e.kind === "task.claimed") {
      flush(key);
      open.set(key, { claim: str(e.payload, "claim_id"), pending: [] });
      rows.push({ entry: e, folded: [] });
      continue;
    }
    // Evidence that names its Claim is that Claim's, however late it came; only an entry from
    // before Evidence named its Claim is placed by its time.
    const named = e.kind === "task.evidence_attached" ? str(e.payload, "claim_id") : undefined;
    if (named) {
      const end = endOf.get(named);
      if (end) {
        end.folded.push(e);
        continue;
      }
      const window = open.get(key) ?? { pending: [] };
      if (!window.claim || window.claim === named) {
        window.pending.push(e);
        open.set(key, window);
      } else rows.push({ entry: e, folded: [] });
      continue;
    }
    if (isShiftLog(e)) {
      const at = Date.parse(e.at);
      const last = ended.get(key)?.at(-1);
      if (last && at - Date.parse(last.entry.at) <= logGrace) {
        last.folded.push(e);
        continue;
      }
      const window = open.get(key);
      if (window?.claim) window.pending.push(e);
      else rows.push({ entry: e, folded: [], shiftEnded: last?.entry.at });
      continue;
    }
    const claim = str(e.payload, "claim_id");
    if (ends.has(e.kind) && claim) {
      const window = open.get(key);
      // A window that started at another Claim's start: what it holds was not this Claim's.
      if (window?.claim && window.claim !== claim) flush(key);
      // What names another Claim stays a row of its own.
      const pending = open.get(key)?.pending ?? [];
      const theirs = (p: Activity) => [undefined, claim].includes(p.kind === "task.evidence_attached" ? str(p.payload, "claim_id") : undefined);
      for (const p of pending.filter((p) => !theirs(p))) rows.push({ entry: p, folded: [] });
      const row: ActivityRow = { entry: e, folded: pending.filter(theirs) };
      open.delete(key);
      rows.push(row);
      ended.set(key, [...(ended.get(key) ?? []), row]);
      endOf.set(claim, row);
      continue;
    }
    if (inside.has(e.kind) && (e.kind !== "task.filed" || str(e.payload, "blocks"))) {
      const window = open.get(key) ?? { pending: [] };
      window.pending.push(e);
      open.set(key, window);
      continue;
    }
    rows.push({ entry: e, folded: [] });
  }
  for (const key of [...open.keys()]) flush(key);
  return rows.sort((a, b) => b.entry.seq - a.entry.seq);
}
