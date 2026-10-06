import type { components } from "@/api/schema.gen";
import type { StatusKind } from "@/lib/status";

type Status = components["schemas"]["Status"];
export type SetStatusesBody = components["schemas"]["SetStatusesBody"];

/** A row of the Workflow list being edited: a Status kept (with its id) or a new one. */
export type Row = { key: string; id?: string; name: string; kind: StatusKind };

export const kindNames: Record<StatusKind, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
  dropped: "Dropped",
};

export const kinds: StatusKind[] = ["backlog", "todo", "in_progress", "done", "dropped"];

/** The kinds the list must keep one Status of: Backlog is the only one it may go without. */
export const requiredKinds: StatusKind[] = ["todo", "in_progress", "done", "dropped"];

/** How a kind ends a Task: open kinds hold open Tasks; done and dropped hold Tasks that ended so. */
export function ending(kind: StatusKind): "open" | "done" | "dropped" {
  return kind === "done" || kind === "dropped" ? kind : "open";
}

export function rowsOf(statuses: Status[]): Row[] {
  return statuses.map((s) => ({ key: s.id, id: s.id, name: s.name, kind: s.kind }));
}

/** Where Add Status puts a new row: after the last open-kind Status, so it sits before Done. */
export function insertAt(rows: Row[]): number {
  for (let i = rows.length - 1; i >= 0; i--) if (ending(rows[i].kind) === "open") return i + 1;
  return rows.length;
}

/** "a Todo Status", "a Done and a Dropped Status". */
function needed(missing: StatusKind[]): string {
  const names = missing.map((k) => `${k === "in_progress" ? "an" : "a"} ${kindNames[k]}`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} Status`;
}

function tasks(n: number): string {
  return `${n} ${n === 1 ? "Task is" : "Tasks are"}`;
}

/** Why a list cannot be sent: the code /v1 would refuse it with, and the reason in words. */
export type Problem = { code: "invalid" | "status_in_use"; message: string };

/**
 * Why `rows` cannot replace the list `current`, or undefined when it can: what the server refuses
 * with `invalid` or `status_in_use`, said before sending. `counts` is how many Tasks each Status
 * holds; `moves` sends a deleted Status's Tasks to a kept one.
 */
export function problem(rows: Row[], current: Status[], counts: Map<string, number>, moves: Record<string, string> = {}): Problem | undefined {
  const invalid = (message: string): Problem => ({ code: "invalid", message });
  const inUse = (message: string): Problem => ({ code: "status_in_use", message });
  const names = new Set<string>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) return invalid("A Status needs a name.");
    if (name.length > 50) return invalid("A Status name is at most 50 characters.");
    if (names.has(name.toLowerCase())) return invalid(`Two Statuses are named ${name}.`);
    names.add(name.toLowerCase());
  }
  const missing = requiredKinds.filter((k) => !rows.some((r) => r.kind === k));
  if (missing.length > 0) return invalid(`The list needs ${needed(missing)}.`);

  for (const r of rows) {
    const old = r.id ? current.find((s) => s.id === r.id) : undefined;
    const n = old ? (counts.get(old.id) ?? 0) : 0;
    if (old && n > 0 && ending(old.kind) !== ending(r.kind)) {
      const stays = ending(old.kind) === "open" ? "Backlog, Todo or In progress" : kindNames[old.kind];
      return inUse(`${tasks(n)} in ${old.name}, so its kind stays ${stays}.`);
    }
  }
  const kept = new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
  for (const old of current) {
    if (kept.has(old.id)) continue;
    const n = counts.get(old.id) ?? 0;
    const to = moves[old.id];
    if (n > 0 && !to) return inUse(`${tasks(n)} in ${old.name}; choose the Status they move to.`);
    if (to) {
      const target = rows.find((r) => r.id === to);
      if (!target) return invalid(`The Tasks in ${old.name} must move to a Status kept in the list.`);
      if (ending(target.kind) !== ending(old.kind)) return invalid(`The Tasks in ${old.name} cannot move to ${target.name}: a Task does not change how it ended.`);
    }
  }
  return undefined;
}

/** The Statuses a deleted Status's Tasks may move to: kept ones that end a Task the same way. */
export function moveTargets(deleted: Pick<Status, "id" | "kind">, rows: Row[]): Row[] {
  return rows.filter((r) => r.id && r.id !== deleted.id && ending(r.kind) === ending(deleted.kind));
}

/** The body of `PUT /v1/statuses`: the whole list in order, ids on the kept ones, and the moves. */
export function setStatusesBody(rows: Row[], moves: Record<string, string> = {}): SetStatusesBody {
  const body: SetStatusesBody = {
    items: rows.map((r) => (r.id ? { id: r.id, name: r.name.trim(), kind: r.kind } : { name: r.name.trim(), kind: r.kind })),
  };
  if (Object.keys(moves).length > 0) body.moves = moves;
  return body;
}

/** Whether `rows` says what `current` says already, so there is nothing to send. */
export function unchanged(rows: Row[], current: Status[]): boolean {
  return (
    rows.length === current.length &&
    rows.every((r, i) => r.id === current[i].id && r.name.trim() === current[i].name && r.kind === current[i].kind)
  );
}
