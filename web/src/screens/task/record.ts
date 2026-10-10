import type { Activity, Claim, Evidence, Note, Observation, SkillProposal, Task, TaskDetail } from "@/api/client";

/**
 * One entry of a Task's record, as the peek and the page draw it: from the Task's detail, and
 * from its path entries in the Activity (an advance's outcome and Step, a move, a split).
 */
export type RecordEntry = { at: string } & (
  | { kind: "filed"; by?: string }
  | { kind: "claimed"; claim: Claim }
  | { kind: "claim-ended"; claim: Claim; advanced?: { outcome: string; to?: string }; logs?: Evidence[] }
  | { kind: "moved"; by?: string; from?: string; to?: string }
  | { kind: "became-parent"; by?: string }
  | { kind: "note"; note: Note }
  | { kind: "observation"; observation: Observation }
  | { kind: "evidence"; evidence: Evidence }
  /** A Shift's log whose Claim the record cannot find: a row of its own at its time. */
  | { kind: "log"; evidence: Evidence }
  | { kind: "question"; question: Task }
  | { kind: "proposal"; proposal: SkillProposal }
  | { kind: "ended"; state: "done" | "dropped"; by?: string; auto?: boolean; after?: string; logs?: Evidence[] }
);

const time = (at: string) => Date.parse(at);

/** How long after its Claim ends a Shift's log may still arrive and be its own: the Runner attaches it once the Session has exited. */
const logGrace = 30 * 60_000;

/**
 * The Claim a Shift's log belongs to: one of the holder who attached it (the Runner attaches as
 * the agent), ended at most `logGrace` before it, the latest such; else the holder's Claim whose
 * span contains it. The Runner attaches the log after the Claim ends, sometimes minutes later
 * when the next holder already holds the Task or the same holder took it again, so a Claim that
 * just ended comes before one held now.
 */
export function logClaim(log: Pick<Evidence, "attached_by" | "created_at">, claims: readonly Claim[]): Claim | undefined {
  const at = time(log.created_at);
  const mine = claims.filter((c) => c.holder_id === log.attached_by && time(c.started_at) <= at);
  const endedBefore = mine
    .filter((c) => c.ended_at && time(c.ended_at) <= at && at - time(c.ended_at) <= logGrace)
    .sort((a, b) => time(b.ended_at!) - time(a.ended_at!));
  if (endedBefore.length) return endedBefore[0];
  return mine.filter((c) => !c.ended_at || time(c.ended_at) > at).sort((a, b) => time(b.started_at) - time(a.started_at))[0];
}
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * The Task's record in time order: its filing, each Claim's start and end (an advance naming its
 * outcome and where it led), moves by hand, becoming a Parent, the Notes, Observations and
 * Evidence, the questions filed to block it, its proposals (one per Skill), and how it ended.
 * Entries at the same instant keep the order a write makes them in: a Note written with an
 * advance comes before it.
 */
export function taskRecord(detail: TaskDetail, entries: readonly Activity[] = []): RecordEntry[] {
  const { task, claims } = detail;
  // A Parent's trail carries its Subtasks' entries too: the record is of the Task's own.
  const path = entries.filter((e) => e.subject_id === task.id);
  const out: RecordEntry[] = [{ kind: "filed", at: task.created_at, by: task.filed_by }];
  const advances = path.filter((e) => e.kind === "task.advanced");
  for (const claim of claims) out.push({ kind: "claimed", at: claim.started_at, claim });
  for (const note of detail.notes) out.push({ kind: "note", at: note.created_at, note });
  for (const observation of detail.observations) out.push({ kind: "observation", at: observation.created_at, observation });
  // A Shift's log is its Claim's, not the Task's Evidence: it rides on the row that ends the Claim.
  const logs = new Map<string, Evidence[]>();
  // Each log's Claim, found once: the end rows take them, and a log left over stands on its own.
  const logClaims = new Map<string, Claim | undefined>();
  for (const evidence of detail.evidence) {
    if (evidence.kind !== "log") {
      out.push({ kind: "evidence", at: evidence.created_at, evidence });
      continue;
    }
    const claim = logClaim(evidence, claims);
    logClaims.set(evidence.id, claim);
    if (claim) logs.set(claim.id, [...(logs.get(claim.id) ?? []), evidence]);
  }
  const placed = new Set<string>();
  const logsOf = (claim: Claim | undefined) => {
    const l = claim && logs.get(claim.id);
    if (!l) return {};
    placed.add(claim.id);
    return { logs: l };
  };
  // A question or Escalation filed to block this Task: its filing is when the block began. A
  // blocker that was there before the Task was filed shows only in the properties.
  for (const b of detail.blockers) {
    if (b.created_at >= task.created_at) out.push({ kind: "question", at: b.created_at, question: b });
  }
  for (const proposal of detail.proposals) out.push({ kind: "proposal", at: proposal.created_at, proposal });
  for (const e of path) {
    if (e.kind === "task.moved") out.push({ kind: "moved", at: e.at, by: e.actor_id, from: str(e.payload.from), to: str(e.payload.to) });
    // A holder's split ends their Claim, which says so; a Subtask filed under an unheld Task does not.
    if (e.kind === "task.became_parent" && !claims.some((c) => c.how_ended === "split")) out.push({ kind: "became-parent", at: e.at, by: e.actor_id });
  }
  for (const claim of claims) {
    // A drop ends the Claim with it; the drop's own entry says so. A move ends it as taken back.
    if (!claim.ended_at || claim.how_ended === "dropped") continue;
    const entry: RecordEntry = { kind: "claim-ended", at: claim.ended_at, claim, ...logsOf(claim) };
    if (claim.how_ended === "advanced") {
      const ended = time(claim.ended_at);
      const e = advances.reduce<Activity | undefined>((best, a) => (Math.abs(time(a.at) - ended) < Math.abs(time(best?.at ?? "0") - ended) ? a : best), undefined);
      if (e && Math.abs(time(e.at) - ended) < 5_000) entry.advanced = { outcome: str(e.payload.outcome) ?? "", to: str(e.payload.to) };
    }
    out.push(entry);
  }
  // A Task its holder completed says so with the Claim's end.
  if (task.state !== "open" && task.ended_at && !(task.state === "done" && claims.some((c) => c.how_ended === "completed"))) {
    const end = path.find((e) => e.kind === (task.state === "done" ? "task.completed" : "task.dropped"));
    // A Parent with Auto-complete completed itself when its last Subtask ended Done; the entry's
    // actor is whoever ended that Subtask.
    if (end?.payload.auto_complete === true) {
      const ended = time(task.ended_at);
      const subtasks = new Map(detail.subtasks.map((t) => [t.id, t.key]));
      const last = entries
        .filter((e) => e.kind === "task.completed" && subtasks.has(e.subject_id) && time(e.at) <= ended)
        .reduce<Activity | undefined>((a, e) => (!a || e.seq > a.seq ? e : a), undefined);
      out.push({ kind: "ended", at: task.ended_at, state: task.state, auto: true, after: last && subtasks.get(last.subject_id) });
    }
    // A drop ends the holder's Claim with it, and says so for the Claim: its log rides here.
    else out.push({ kind: "ended", at: task.ended_at, state: task.state, by: end?.actor_id, ...logsOf(claims.find((c) => c.how_ended === "dropped")) });
  }
  // A log whose Claim has no row ending it (still held, or none found) stands on its own.
  for (const [id, claim] of logClaims) {
    if (claim && placed.has(claim.id)) continue;
    const evidence = detail.evidence.find((e) => e.id === id)!;
    out.push({ kind: "log", at: evidence.created_at, evidence });
  }
  // A stable sort on the instant keeps the insertion order above for ties.
  return out
    .map((e, i) => [e, i] as const)
    .sort(([a, i], [b, j]) => time(a.at) - time(b.at) || i - j)
    .map(([e]) => e);
}

/** The last Claim's end when it lapsed and nobody holds the Task since: the reason a row is dimmed. */
export function lapsedClaim(detail: Pick<TaskDetail, "claims" | "task">): Claim | undefined {
  const last = detail.claims.at(-1);
  if (detail.task.state !== "open" || !last || last.how_ended !== "lapsed") return undefined;
  return last;
}
