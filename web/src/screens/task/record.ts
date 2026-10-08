import type { Activity, Claim, Evidence, Note, Observation, SkillProposal, Task, TaskDetail } from "@/api/client";

/**
 * One entry of a Task's record, as the peek and the page draw it: from the Task's detail, and
 * from its path entries in the Activity (an advance's outcome and Step, a move, a split).
 */
export type RecordEntry = { at: string } & (
  | { kind: "filed"; by?: string }
  | { kind: "claimed"; claim: Claim }
  | { kind: "claim-ended"; claim: Claim; advanced?: { outcome: string; to?: string } }
  | { kind: "moved"; by?: string; from?: string; to?: string }
  | { kind: "became-parent"; by?: string }
  | { kind: "note"; note: Note }
  | { kind: "observation"; observation: Observation }
  | { kind: "evidence"; evidence: Evidence }
  | { kind: "question"; question: Task }
  | { kind: "proposal"; proposal: SkillProposal }
  | { kind: "ended"; state: "done" | "dropped"; by?: string; auto?: boolean }
);

const time = (at: string) => Date.parse(at);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * The Task's record in time order: its filing, each Claim's start and end (an advance naming its
 * outcome and where it led), moves by hand, becoming a Parent, the Notes, Observations and
 * Evidence, the questions filed to block it, its proposals (one per Skill), and how it ended.
 * Entries at the same instant keep the order a write makes them in: a Note written with an
 * advance comes before it.
 */
export function taskRecord(detail: TaskDetail, path: readonly Activity[] = []): RecordEntry[] {
  const { task, claims } = detail;
  const out: RecordEntry[] = [{ kind: "filed", at: task.created_at, by: task.filed_by }];
  const advances = path.filter((e) => e.kind === "task.advanced");
  for (const claim of claims) out.push({ kind: "claimed", at: claim.started_at, claim });
  for (const note of detail.notes) out.push({ kind: "note", at: note.created_at, note });
  for (const observation of detail.observations) out.push({ kind: "observation", at: observation.created_at, observation });
  for (const evidence of detail.evidence) out.push({ kind: "evidence", at: evidence.created_at, evidence });
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
    const entry: RecordEntry = { kind: "claim-ended", at: claim.ended_at, claim };
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
    // A Parent with Auto-complete completed itself; the entry's actor ended its last Subtask.
    if (end?.payload.auto_complete === true) out.push({ kind: "ended", at: task.ended_at, state: task.state, auto: true });
    else out.push({ kind: "ended", at: task.ended_at, state: task.state, by: end?.actor_id });
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
