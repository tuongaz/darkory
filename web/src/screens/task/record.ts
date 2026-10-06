import type { Claim, Evidence, Note, Observation, SkillProposal, Task, TaskDetail } from "@/api/client";

/**
 * One entry of a Task's record, as the peek and the page draw it. Everything comes from the
 * Task's detail; Activity is not read, so an entry has a Member only where the detail names one.
 */
export type RecordEntry = { at: string } & (
  | { kind: "filed"; by: string }
  | { kind: "claimed"; claim: Claim }
  | { kind: "claim-ended"; claim: Claim; nextSkillId?: string }
  | { kind: "note"; note: Note }
  | { kind: "observation"; observation: Observation }
  | { kind: "evidence"; evidence: Evidence }
  | { kind: "question"; question: Task }
  | { kind: "proposal"; proposal: SkillProposal }
  | { kind: "ended"; state: "done" | "dropped" }
);

/**
 * The Task's record in time order: its filing, each Claim's start and end, the Notes,
 * Observations and Evidence, the questions filed to block it, its proposal, and how it ended.
 * Entries at the same instant keep the order a write makes them in: a Note written with a
 * Handover comes before the Handover.
 */
export function taskRecord(detail: TaskDetail): RecordEntry[] {
  const { task, claims } = detail;
  const out: RecordEntry[] = [{ kind: "filed", at: task.created_at, by: task.filed_by }];
  for (const claim of claims) out.push({ kind: "claimed", at: claim.started_at, claim });
  for (const note of detail.notes) out.push({ kind: "note", at: note.created_at, note });
  for (const observation of detail.observations) out.push({ kind: "observation", at: observation.created_at, observation });
  for (const evidence of detail.evidence) out.push({ kind: "evidence", at: evidence.created_at, evidence });
  // A question or Escalation filed to block this Task: its filing is when the block began. A
  // blocker that was there before the Task was filed shows only in the properties.
  for (const b of detail.blockers) {
    if (b.created_at >= task.created_at) out.push({ kind: "question", at: b.created_at, question: b });
  }
  if (detail.proposal) out.push({ kind: "proposal", at: detail.proposal.created_at, proposal: detail.proposal });
  claims.forEach((claim, i) => {
    // A drop ends the Claim with it; the drop's own entry says so.
    if (!claim.ended_at || claim.how_ended === "dropped") return;
    const entry: RecordEntry = { kind: "claim-ended", at: claim.ended_at, claim };
    // A Handover names the Skill the next Claim was made under, or the one the Task needs now.
    if (claim.how_ended === "handed_over") entry.nextSkillId = claims[i + 1]?.skill_id ?? task.skill_id;
    out.push(entry);
  });
  if (task.state !== "open" && task.ended_at && !claims.some((c) => c.how_ended === "completed")) {
    out.push({ kind: "ended", at: task.ended_at, state: task.state });
  }
  // A stable sort on the instant keeps the insertion order above for ties.
  return out.map((e, i) => [e, i] as const).sort(([a, i], [b, j]) => time(a.at) - time(b.at) || i - j).map(([e]) => e);
}

function time(at: string): number {
  return new Date(at).getTime();
}

/** The last Claim's end when it lapsed and nobody holds the Task since: the reason a row is dimmed. */
export function lapsedClaim(detail: Pick<TaskDetail, "claims" | "task">): Claim | undefined {
  const last = detail.claims.at(-1);
  if (detail.task.state !== "open" || !last || last.how_ended !== "lapsed") return undefined;
  return last;
}

/** "2 s", "15 min", "2 h": a Heartbeat timeout as it reads in a sentence. */
export function durationText(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}
