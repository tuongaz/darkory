import type { Claim, Member, MemberDetail, Skill, SkillProposal, Task, TaskDetail, Token } from "@/api/client";
import type { components } from "@/api/schema.gen";

/** One running copy of a Member (src/api/client.ts names no type for it). */
export type Session = components["schemas"]["Session"];

/** The name of the first token an agent created in the web app gets. */
export const firstTokenName = "default";

/** Members split by kind, each group in the order given (the API lists by name). */
export function groupByKind<M extends Pick<Member, "kind">>(members: M[]): { humans: M[]; agents: M[] } {
  return { humans: members.filter((m) => m.kind === "human"), agents: members.filter((m) => m.kind === "agent") };
}

/** Humans first, then agents: how avatars stack. */
export function humansFirst<M extends Pick<Member, "kind">>(members: M[]): M[] {
  const { humans, agents } = groupByKind(members);
  return [...humans, ...agents];
}

export function liveTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => !t.revoked_at);
}

/** A held Task with the Claim that holds it. */
export type Held = { task: Task; claim: Claim };

export function heldClaims(tasks: Task[]): Held[] {
  return tasks.flatMap((task) => (task.claim && !task.claim.ended_at ? [{ task, claim: task.claim }] : []));
}

/**
 * The Claims bound to a Session: those made through it with a Heartbeat timeout. A Claim made
 * without one is bound to the Member, and closing the Session leaves it.
 */
export function boundToSession(held: Held[], session: string): Held[] {
  return held.filter((h) => h.claim.session_id === session && !!h.claim.heartbeat_timeout_seconds);
}

/** Everything a Member holds through a Session, bound to it or not: what its row says it is doing. */
export function madeThrough(held: Held[], session: string): Held[] {
  return held.filter((h) => h.claim.session_id === session);
}

/** What revoking a token stops: its open Sessions, and the Claims bound to them. */
export function revokeSummary(token: Token, sessions: Session[], held: Held[]) {
  const closed = sessions.filter((s) => s.token_id === token.id);
  return { sessions: closed, claims: closed.flatMap((s) => boundToSession(held, s.id)) };
}

/**
 * What deactivating a Member stops, from their live record: every live token revoked, every open
 * Session closed, and every Claim they hold ended, bound to a Session or to the Member.
 */
export function deactivateSummary(tokens: Token[], sessions: Session[], held: Held[]) {
  return { tokens: liveTokens(tokens), sessions, claims: held };
}

/** "1 token", "3 Sessions". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The pending proposal written against a Skill, with the Retrospective that carries it. */
export function pendingProposal(skill: Pick<Skill, "id">, retros: TaskDetail[]): { proposal: SkillProposal; retro: TaskDetail } | undefined {
  for (const retro of retros) {
    const p = retro.proposal;
    if (p && p.state === "pending" && p.skill_id === skill.id) return { proposal: p, retro };
  }
  return undefined;
}

/** The Members holding each Skill, by Skill id. */
export function holdersBySkill(details: Map<string, MemberDetail>): Map<string, Member[]> {
  const out = new Map<string, Member[]>();
  for (const d of details.values()) {
    for (const s of d.skills) out.set(s.id, [...(out.get(s.id) ?? []), d.member]);
  }
  return out;
}

export type DiffLine = { op: "same" | "add" | "del"; text: string };

/** A line diff of `before` against `after`, by the longest common run of lines. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // lcs[i][j]: the common lines of a[i:] and b[j:].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: "del", text: a[i++] });
    } else {
      out.push({ op: "add", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ op: "del", text: a[i++] });
  while (j < b.length) out.push({ op: "add", text: b[j++] });
  return out;
}

function splitLines(s: string): string[] {
  const lines = s.split("\n");
  // A closing newline ends the last line rather than starting an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A Team key as /v1 takes it: a capital, then 1 to 9 capitals or digits. */
export const teamKeyPattern = /^[A-Z][A-Z0-9]{1,9}$/;

/** A Skill name as /v1 takes it. */
export const skillNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A key to offer for a Team's name until one is typed: its first letters, in capitals. */
export function suggestKey(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key = letters.replace(/^[0-9]+/, "").slice(0, 3);
  return key.length >= 2 ? key : "";
}
