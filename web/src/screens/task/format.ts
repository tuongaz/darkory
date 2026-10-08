import { useDirectory } from "@/api/queries";

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

/** "2 s", "15 min", "2 h": a Heartbeat timeout as it reads in a sentence. */
export function durationText(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}
