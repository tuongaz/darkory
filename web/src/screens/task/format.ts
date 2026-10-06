import type { Task } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { glyphFor, type Glyph, type StatusKind } from "@/lib/status";

export type StatusLike = { id: string; name: string; kind: StatusKind };

/** The glyph for a Status: the first In-progress Status draws half full, later ones (In review) three quarters. */
export function statusGlyph(status: StatusLike, statuses: StatusLike[] | undefined): Glyph {
  const nth = (statuses ?? []).filter((s) => s.kind === status.kind).findIndex((s) => s.id === status.id);
  return glyphFor(status.kind, Math.max(0, nth));
}

/** A Member's name for a sentence, by id. */
export function useMemberName(): (id: string | undefined) => string {
  const { members } = useDirectory();
  return (id) => (id && members.get(id)?.name) || "Unknown";
}

/** A Skill's name, by id. */
export function useSkillName(): (id: string | undefined) => string | undefined {
  const { skills } = useDirectory();
  return (id) => (id ? skills.get(id)?.name : undefined);
}

export function featurePath(key: string): string {
  return `/features/${encodeURIComponent(key)}`;
}

export function taskPath(key: string): string {
  return `/tasks/${encodeURIComponent(key)}`;
}

/** "70 B", "12 KB", "3.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const day = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "Today" or "Mon 6 Oct": the heading of a run of record entries. */
export function dayText(at: string, now: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString() ? "Today" : day.format(d);
}

/** Tasks by Status, in the Organisation's order of Statuses, then by how long each has waited. */
export function orderTasks(tasks: Task[], statuses: StatusLike[] | undefined): Task[] {
  const position = new Map((statuses ?? []).map((s, i) => [s.id, i]));
  return [...tasks].sort(
    (a, b) =>
      (position.get(a.status_id) ?? 0) - (position.get(b.status_id) ?? 0) ||
      new Date(a.waiting_since).getTime() - new Date(b.waiting_since).getTime(),
  );
}
