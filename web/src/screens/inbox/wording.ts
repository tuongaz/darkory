import type { Activity, ActivityKind, Member, Skill, Team } from "@/api/client";
import { untilText } from "@/lib/time";
import { count } from "./derive";

// What an Activity entry says, in CONTEXT.md's words: the actor, the verb (or, for a lapse, a
// take-back or a hand-over, a mark), the record it is about, and the one detail worth a glance.
// Ported from the old ActivityView; kept free of React so the tests read it as text.

/** Where an entry's ids become names. */
export type Lookup = {
  members: Map<string, Pick<Member, "name" | "kind">>;
  teams: Map<string, Pick<Team, "key" | "name">>;
  skills: Map<string, Pick<Skill, "name">>;
  tasks: Map<string, { key: string; title: string }>;
  features: Map<string, { key: string; title: string }>;
  statuses: Map<string, { name: string }>;
  /** The `task.claimed` entries read so far, by claim id: how long a lapsed Claim waited. */
  claims: Map<string, Activity>;
};

export type Mark = "lapsed" | "taken_back" | "handed_over";

export type Subject = { type: "task" | "feature"; key: string; title: string } | { type: "text"; text: string };

export type Sentence = {
  /** The Member who acted; absent when Darkory did, as on a lapse. */
  actorId?: string;
  actorName: string;
  verb?: string;
  mark?: Mark;
  subject?: Subject;
  /** Words after the subject that belong to the sentence ("for builder-2"). */
  after?: string;
  /** The muted facts after a "·". */
  details: string[];
  outcome?: "worked" | "didnt_work";
  evidence?: { id: string; filename: string; size?: number };
};

type KindWords = { group: string; label: string; verb: string };

// Each kind: the menu group and label the Kind filter shows, and the verb the row says.
const kinds: Record<ActivityKind, KindWords> = {
  "task.filed": { group: "Task", label: "Filed", verb: "filed" },
  "task.claimed": { group: "Task", label: "Claimed", verb: "claimed" },
  "task.lapsed": { group: "Task", label: "Lapsed", verb: "" },
  "task.released": { group: "Task", label: "Released", verb: "released" },
  "task.handed_over": { group: "Task", label: "Handed over", verb: "" },
  "task.completed": { group: "Task", label: "Completed", verb: "completed" },
  "task.dropped": { group: "Task", label: "Dropped", verb: "dropped" },
  "task.taken_back": { group: "Task", label: "Taken back", verb: "" },
  "task.claim_ended": { group: "Task", label: "Claim ended", verb: "ended a Claim on" },
  "task.note_added": { group: "Task", label: "Note added", verb: "added a Note to" },
  "task.observed": { group: "Task", label: "Observation added", verb: "added an Observation to" },
  "task.blocker_added": { group: "Task", label: "Blocker added", verb: "added a blocker to" },
  "task.blocker_removed": { group: "Task", label: "Blocker removed", verb: "removed a blocker from" },
  "task.evidence_attached": { group: "Task", label: "Evidence attached", verb: "attached Evidence to" },
  "task.skill_proposed": { group: "Task", label: "Proposal", verb: "proposed" },
  "task.status_set": { group: "Task", label: "Status set", verb: "set the Status of" },
  "feature.filed": { group: "Feature", label: "Filed", verb: "filed the Feature" },
  "feature.ranked": { group: "Feature", label: "Ranked", verb: "ranked" },
  "feature.shipped": { group: "Feature", label: "Shipped", verb: "shipped the Feature" },
  "feature.dropped": { group: "Feature", label: "Dropped", verb: "dropped the Feature" },
  "feature.owner_passed": { group: "Feature", label: "Owner passed", verb: "passed the ownership of" },
  "feature.evidence_attached": { group: "Feature", label: "Evidence attached", verb: "attached Evidence to" },
  "statuses.changed": { group: "Statuses", label: "Changed", verb: "changed the Statuses" },
  "skill.created": { group: "Skill", label: "Created", verb: "created the Skill" },
  "skill.version_published": { group: "Skill", label: "Version published", verb: "published" },
  "member.created": { group: "Member", label: "Created", verb: "created the Member" },
  "member.updated": { group: "Member", label: "Updated", verb: "updated the Member" },
  "member.manager_set": { group: "Member", label: "Reporting line set", verb: "set the Reporting line of" },
  "member.manager_cleared": { group: "Member", label: "Reporting line removed", verb: "removed the Reporting line of" },
  "member.skill_granted": { group: "Member", label: "Skill granted", verb: "granted a Skill to" },
  "member.skill_revoked": { group: "Member", label: "Skill taken away", verb: "took a Skill away from" },
  "member.deactivated": { group: "Member", label: "Deactivated", verb: "deactivated the Member" },
  "member.reactivated": { group: "Member", label: "Reactivated", verb: "reactivated the Member" },
  "team.created": { group: "Team", label: "Created", verb: "created the Team" },
  "team.member_added": { group: "Team", label: "Member added", verb: "added" },
  "team.member_removed": { group: "Team", label: "Member removed", verb: "removed" },
  "token.issued": { group: "Token", label: "Issued", verb: "issued the token" },
  "token.revoked": { group: "Token", label: "Revoked", verb: "revoked a token" },
  "session.closed": { group: "Session", label: "Closed", verb: "closed a Session" },
  "login_link.issued": { group: "Login link", label: "Issued", verb: "issued a login link for" },
  "login_link.redeemed": { group: "Login link", label: "Redeemed", verb: "signed in with a login link" },
};

/** The kinds the Kind filter offers, in menu order, with their group and label. */
export const kindChoices = Object.entries(kinds).map(([kind, w]) => ({ kind: kind as ActivityKind, group: w.group, label: w.label }));

/** A kind as the Kind chip names it: "Task lapsed". */
export function kindName(kind: string): string {
  const w = isKnown(kind) ? kinds[kind] : undefined;
  return w ? `${w.group} ${w.label.toLowerCase()}` : kind;
}

// /v1 adds kinds within the version and asks clients to skip those they do not know.
export function isKnown(kind: string): kind is ActivityKind {
  return Object.hasOwn(kinds, kind);
}

const claimEnds: Record<string, string> = {
  released: "released",
  handed_over: "handed over",
  completed: "completed",
  lapsed: "lapsed",
  taken_back: "taken back",
  dropped: "dropped",
  token_revoked: "token revoked",
  session_closed: "Session closed",
  member_deactivated: "Member deactivated",
};

function text(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

function number(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" ? v : undefined;
}

/** "2 s", "15 min": a Heartbeat timeout in seconds. */
export function timeoutText(seconds: number): string {
  return untilText(seconds * 1000);
}

/** The sentence an entry says, or null for a kind this app does not know. */
export function describe(e: Activity, l: Lookup): Sentence | null {
  if (!isKnown(e.kind)) return null;
  const p = e.payload;
  const member = (id: string | undefined) => (id ? (l.members.get(id)?.name ?? "a Member") : "a Member");
  const skill = (id: string | undefined) => (id ? (l.skills.get(id)?.name ?? "a Skill") : undefined);
  const s: Sentence = {
    actorId: e.actor_id,
    actorName: e.actor_id ? member(e.actor_id) : "Darkory",
    verb: kinds[e.kind].verb || undefined,
    details: [],
  };

  // The record the entry is about.
  switch (e.subject_type) {
    case "task": {
      const t = l.tasks.get(e.subject_id) ?? named(p);
      s.subject = t ? { type: "task", ...t } : { type: "text", text: "a Task" };
      break;
    }
    case "feature": {
      const f = l.features.get(e.subject_id) ?? named(p);
      s.subject = f ? { type: "feature", ...f } : { type: "text", text: "a Feature" };
      break;
    }
    case "member":
      s.subject = { type: "text", text: member(e.subject_id) };
      break;
    case "team":
      s.subject = { type: "text", text: l.teams.get(e.subject_id)?.name ?? text(p, "name") ?? "a Team" };
      break;
    case "skill":
      s.subject = { type: "text", text: l.skills.get(e.subject_id)?.name ?? text(p, "name") ?? "a Skill" };
      break;
  }

  switch (e.kind) {
    case "task.filed":
      if (p.aimed_at_id) s.details.push(`aimed at ${member(text(p, "aimed_at_id"))}`);
      else if (skill(text(p, "skill_id"))) s.details.push(skill(text(p, "skill_id"))!);
      if (text(p, "blocks")) s.details.push(`blocks ${l.tasks.get(text(p, "blocks")!)?.key ?? "a Task"}`);
      break;
    case "task.claimed": {
      const sk = skill(text(p, "skill_id"));
      if (sk) s.details.push(sk);
      const timeout = number(p, "heartbeat_timeout_seconds");
      if (text(p, "model_label")) s.details.push(text(p, "model_label")!);
      else if (timeout) s.details.push(`Heartbeat every ${timeoutText(timeout)}`);
      break;
    }
    case "task.lapsed": {
      s.mark = "lapsed";
      s.details.push(`held by ${member(text(p, "holder_id"))}`);
      const claimed = l.claims.get(text(p, "claim_id") ?? "");
      const timeout = claimed && number(claimed.payload, "heartbeat_timeout_seconds");
      if (timeout) s.details.push(`no Heartbeat in ${timeoutText(timeout)}`);
      break;
    }
    case "task.taken_back":
      s.mark = "taken_back";
      s.details.push(`held by ${member(text(p, "holder_id"))}`);
      break;
    case "task.handed_over": {
      s.mark = "handed_over";
      const from = skill(text(p, "from_skill_id"));
      const to = skill(text(p, "skill_id")) ?? "a Skill";
      s.details.push(from ? `${from} → ${to}` : `to ${to}`);
      break;
    }
    case "task.claim_ended":
      s.details.push(`held by ${member(text(p, "holder_id"))}`);
      if (text(p, "how_ended")) s.details.push(claimEnds[text(p, "how_ended")!] ?? text(p, "how_ended")!);
      break;
    case "task.dropped":
      if (p.feature_dropped) s.details.push("with its Feature");
      break;
    case "task.observed":
      s.outcome = text(p, "outcome") === "worked" ? "worked" : "didnt_work";
      break;
    case "task.blocker_added":
    case "task.blocker_removed":
      if (text(p, "blocker_key")) s.details.push(`blocked by ${text(p, "blocker_key")}`);
      break;
    case "task.evidence_attached":
    case "feature.evidence_attached":
      if (text(p, "filename")) s.evidence = { id: text(p, "evidence_id") ?? "", filename: text(p, "filename")!, size: number(p, "size") };
      break;
    case "task.skill_proposed":
      s.verb = `proposed ${skill(text(p, "skill_id")) ?? "a Skill"} v${(number(p, "based_on_version") ?? 0) + 1} on`;
      break;
    case "task.status_set": {
      const from = l.statuses.get(text(p, "from") ?? "")?.name;
      const to = l.statuses.get(text(p, "to") ?? "")?.name;
      if (from && to) s.details.push(`${from} → ${to}`);
      else if (to) s.details.push(`to ${to}`);
      break;
    }
    case "statuses.changed": {
      const moved = number(p, "tasks_moved");
      if (moved) s.details.push(`${count(moved, "Task")} moved`);
      break;
    }
    case "feature.filed":
      if (text(p, "owner_id")) s.details.push(`owner ${member(text(p, "owner_id"))}`);
      break;
    case "feature.ranked":
      s.details.push(`Rank #${text(p, "from")} → #${text(p, "to")}`);
      break;
    case "feature.dropped": {
      const n = number(p, "open_tasks_dropped");
      if (n) s.details.push(`${count(n, "open Task")} dropped`);
      break;
    }
    case "feature.owner_passed":
      s.details.push(`to ${member(text(p, "to"))}`);
      break;
    case "skill.version_published":
      s.subject = { type: "text", text: `${l.skills.get(e.subject_id)?.name ?? "a Skill"} v${text(p, "version")}` };
      break;
    case "member.manager_set":
      s.details.push(`to ${member(text(p, "manager_id"))}`);
      break;
    case "member.skill_granted":
    case "member.skill_revoked":
      s.details.push(skill(text(p, "skill_id")) ?? "a Skill");
      break;
    case "team.member_added":
    case "team.member_removed": {
      const team = s.subject?.type === "text" ? s.subject.text : "a Team";
      s.subject = { type: "text", text: member(text(p, "member_id")) };
      s.after = `${e.kind === "team.member_added" ? "to" : "from"} ${team}`;
      break;
    }
    case "token.issued":
      s.subject = { type: "text", text: text(p, "name") ?? "" };
      s.after = `for ${member(text(p, "member_id"))}`;
      break;
    case "token.revoked":
      s.after = `for ${member(text(p, "member_id"))}`;
      break;
    case "session.closed": {
      const n = number(p, "claims_ended");
      if (n) s.details.push(`${count(n, "Claim")} ended`);
      break;
    }
    case "login_link.issued":
      s.subject = { type: "text", text: member(text(p, "member_id")) };
      break;
  }
  return s;
}

/** A Task's or Feature's key and title from the entry that filed it. */
function named(p: Record<string, unknown>): { key: string; title: string } | undefined {
  const key = text(p, "key");
  return key ? { key, title: text(p, "title") ?? "" } : undefined;
}

export const markWords: Record<Mark, string> = { lapsed: "Lapsed", taken_back: "Taken back", handed_over: "Handed over" };

/** The sentence as plain text, as a screen reader reads the row: "builder-2 claimed WEB-4 Payment form · web-engineer". */
export function sentenceText(s: Sentence): string {
  const words: string[] = [s.actorName];
  if (s.mark) words.push(markWords[s.mark]);
  if (s.verb) words.push(s.verb);
  if (s.subject) words.push(s.subject.type === "text" ? s.subject.text : `${s.subject.key} ${s.subject.title}`.trim());
  if (s.after) words.push(s.after);
  if (s.outcome) words.push(s.outcome === "worked" ? "Worked" : "Didn't work");
  if (s.evidence) words.push(s.evidence.filename);
  return [words.filter(Boolean).join(" "), ...s.details].join(" · ");
}

