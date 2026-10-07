import type { Member } from "@/api/client";

/**
 * Initials as the board draws them. A human: the first letter of each of up to two words (Mai Tran
 * → MT, tuongaz → T). An agent: the first letters of two dash-separated parts (builder-1 → B1,
 * qa-bot → QB), or of one word its first letter and the next consonant (planner → PL).
 */
export function initials(member: Pick<Member, "name" | "kind">): string {
  const name = member.name.trim();
  if (!name) return "?";
  if (member.kind === "agent") {
    const parts = name.split(/[-_\s.]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    const rest = name.slice(1).match(/[b-df-hj-np-tv-z0-9]/i)?.[0] ?? name[1] ?? "";
    return (name[0] + rest).toUpperCase();
  }
  const words = name.split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

const tints = 8;

/** Which of the eight avatar tints (globals.css) a name gets: the same every time, spread by a string hash. */
export function tintOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % tints;
}

/**
 * A Session id as rows show it: its last 8 characters after "…". Ids are UUIDv7, so Sessions
 * started the same day share their first characters and differ at the end.
 */
export function shortSessionId(id: string): string {
  return id.length <= 9 ? id : `…${id.slice(-8)}`;
}
