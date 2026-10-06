import type { Claim, Member } from "@/api/client";

export type TakersInput = {
  /** The Skill the Task needs, or would need after a Handover. */
  skillId?: string;
  /** The Member the Task is aimed at, when it is. */
  aimedAt?: string;
  /** The Members of the Feature's Team; for skill-review, every Member of the Organisation. */
  pool: Member[];
  /** The Skills each Member of the pool has, by Member id. */
  skillsOf: Map<string, Set<string>>;
  /** The Task's Claims so far: whoever held it under another Skill cannot take it under this one. */
  claims: Pick<Claim, "holder_id" | "skill_id">[];
  owner: string;
};

/**
 * Who could take a Task by the Takeable rule, leaving out whether it is blocked or held: the
 * Member it is aimed at; else the pool's Members with its Skill who never held it under another
 * Skill; else, when there are none, the Feature owner (CONTEXT.md, Takeable).
 */
export function whoCanTake({ skillId, aimedAt, pool, skillsOf, claims, owner }: TakersInput): string[] {
  if (aimedAt) return [aimedAt];
  const heldUnderOther = (id: string) => claims.some((c) => c.holder_id === id && c.skill_id !== skillId);
  const by = pool
    .filter((m) => !m.deactivated_at && skillId && skillsOf.get(m.id)?.has(skillId) && !heldUnderOther(m.id))
    .map((m) => m.id);
  if (by.length) return by;
  return heldUnderOther(owner) ? [] : [owner];
}
