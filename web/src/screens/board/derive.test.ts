import { describe, expect, it } from "vitest";
import type { Activity, Task } from "@/api/client";
import { ada, builder, feature, task } from "@/test/fixtures";
import {
  blocking,
  claimTrails,
  compareTasks,
  countsText,
  defaultDisplay,
  groupTasks,
  lapsedAt,
  marksOf,
  moveFeature,
  rankPosition,
  refusalNote,
  statusGlyphs,
  taskBar,
  mayMove,
  visibleTasks,
} from "./derive";
import { statuses } from "./testData";


const now = Date.parse("2026-10-06T22:18:00Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const entry = (seq: number, kind: string, subject: string, extra: Partial<Activity> = {}): Activity =>
  ({ seq, kind, subject_type: "task", subject_id: subject, at: at(60 - seq), payload: {}, ...extra }) as Activity;

describe("Status glyphs", () => {
  it("draws the first In-progress Status half full and a later one as In review, whatever the order given", () => {
    const glyphs = statusGlyphs([...statuses].reverse());
    expect([...statuses.map((s) => glyphs.get(s.id))]).toEqual(["backlog", "todo", "inprogress", "inreview", "done", "dropped"]);
  });
});

describe("Task order", () => {
  const features = new Map([
    ["f-1", feature(1, 2)],
    ["f-9", feature(9, 1)],
  ]);
  const older = task(7, "f-1", { waiting_since: at(30) });
  const newer = task(3, "f-1", { waiting_since: at(5) });
  const first = task(10, "f-9", { waiting_since: at(1) });

  it("sorts by the Feature's Rank, then the Task that has waited longest: the order next uses", () => {
    expect([newer, older, first].sort(compareTasks("rank", features)).map((t) => t.key)).toEqual(["WEB-10", "WEB-7", "WEB-3"]);
  });

  it("sorts by waiting time alone when asked", () => {
    expect([first, newer, older].sort(compareTasks("waiting", features)).map((t) => t.key)).toEqual(["WEB-7", "WEB-3", "WEB-10"]);
  });

  it("puts a Task whose Feature is unknown last, and breaks ties by key", () => {
    const stray = task(2, "f-404", { waiting_since: at(99) });
    const twin = task(4, "f-9", { waiting_since: first.waiting_since });
    expect([stray, twin, first].sort(compareTasks("rank", features)).map((t) => t.key)).toEqual(["WEB-4", "WEB-10", "WEB-2"]);
  });
});

describe("grouping", () => {
  const ctx = { statuses, features: [feature(1, 2), feature(9, 1)], holderName: (id: string) => (id === ada.id ? "ada" : "builder"), now };
  const held = (n: number, holder: string, f = "f-1"): Task =>
    task(n, f, { status_id: "st-progress", claim: { id: `c-${n}`, task_id: `k-${n}`, holder_id: holder, session_id: "s", started_at: at(5) } });

  it("groups by Status in the Organisation's order and leaves empty Statuses out", () => {
    const groups = groupTasks([held(3, builder.id), task(5, "f-1", { status_id: "st-backlog" }), task(6, "f-1")], "status", ctx);
    expect(groups.map((g) => g.id)).toEqual(["st-backlog", "st-todo", "st-progress"]);
  });

  it("groups by Feature in Rank order", () => {
    const groups = groupTasks([task(3, "f-1"), task(10, "f-9")], "feature", ctx);
    expect(groups.map((g) => g.id)).toEqual(["f-9", "f-1"]);
  });

  it("groups by holder by name, the Tasks nobody holds last, keeping the order inside", () => {
    const groups = groupTasks([task(6, "f-1"), held(3, builder.id), held(4, ada.id), task(2, "f-1")], "holder", ctx);
    expect(groups.map((g) => [g.id, g.tasks.map((t) => t.key)])).toEqual([
      [ada.id, ["WEB-4"]],
      [builder.id, ["WEB-3"]],
      ["", ["WEB-6", "WEB-2"]],
    ]);
  });
});

describe("what a view shows", () => {
  const features = new Map([
    ["f-1", feature(1, 1)],
    ["f-2", feature(2, 2, { state: "shipped" })],
  ]);
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const tasks = [
    task(3, "f-1"),
    task(4, "f-1", { state: "done", status_id: "st-done" }),
    task(5, "f-1", { state: "dropped", status_id: "st-dropped" }),
    task(6, "f-2", { kind: "retrospective" }),
    task(7, "f-1", { blocked: true, skill_id: "s-review" }),
  ];
  const keysOf = (ts: Task[]) => ts.map((t) => t.key);
  const base = { display: defaultDisplay, filters: {}, features, statuses: byId, now, byKind: true };

  it("hides Dropped by default and shows Done and ended Features' Tasks", () => {
    expect(keysOf(visibleTasks(tasks, base))).toEqual(["WEB-3", "WEB-4", "WEB-6", "WEB-7"]);
  });

  it("follows the Display's toggles", () => {
    const display = { ...defaultDisplay, showDone: false, showDropped: true, showEndedFeatures: false };
    expect(keysOf(visibleTasks(tasks, { ...base, display }))).toEqual(["WEB-3", "WEB-5", "WEB-7"]);
  });

  it("keeps Done and Dropped Tasks for the board, which collapses their columns instead", () => {
    expect(keysOf(visibleTasks(tasks, { ...base, byKind: false }))).toContain("WEB-5");
  });

  it("filters by Skill and by blocked", () => {
    expect(keysOf(visibleTasks(tasks, { ...base, filters: { skill: "s-review" } }))).toEqual(["WEB-7"]);
    expect(keysOf(visibleTasks(tasks, { ...base, filters: { blocked: true } }))).toEqual(["WEB-7"]);
  });
});

describe("Lapsed, from the Activity's Claim entries", () => {
  it("marks a Task whose latest Claim entry is a lapse, at the lapse's time", () => {
    const trails = claimTrails([entry(2, "task.lapsed", "k-5"), entry(1, "task.claimed", "k-5")]);
    expect(trails.get("k-5")?.lapsedAt).toBe(at(58));
    expect(lapsedAt(task(5, "f-1"), trails.get("k-5"), now)).toBe(at(58));
  });

  it("clears it when the Task is claimed again, and ignores repeated entries", () => {
    const trails = claimTrails([entry(1, "task.claimed", "k-5"), entry(2, "task.lapsed", "k-5"), entry(3, "task.claimed", "k-5"), entry(2, "task.lapsed", "k-5")]);
    expect(trails.get("k-5")?.lapsedAt).toBeUndefined();
  });

  it("does not mark a Task someone holds now, or one that has ended", () => {
    const trail = { lapsedAt: at(10) };
    const holding = task(5, "f-1", { claim: { id: "c", task_id: "k-5", holder_id: builder.id, session_id: "s", started_at: at(1), expires_at: at(-10) } });
    expect(lapsedAt(holding, trail, now)).toBeUndefined();
    expect(lapsedAt(task(5, "f-1", { state: "done" }), trail, now)).toBeUndefined();
  });

  it("remembers who completed a Task", () => {
    expect(claimTrails([entry(4, "task.completed", "k-4", { actor_id: builder.id })]).get("k-4")?.completedBy).toBe(builder.id);
  });
});

describe("marks", () => {
  it("puts Blocked first, then Lapsed, then the Task's kind", () => {
    const t = task(10, "f-9", { kind: "breakdown", blocked: true, open_blockers: [{ id: "k-8", key: "WEB-8" }] });
    expect(marksOf(t, { lapsedAt: at(3) }, now)).toEqual([
      { kind: "blocked", by: "WEB-8" },
      { kind: "lapsed", at: at(3) },
      { kind: "task-kind", label: "Break down" },
    ]);
  });

  it("reads what a question blocks off the blocked Tasks' open blockers", () => {
    const cart = task(3, "f-1", { blocked: true, open_blockers: [{ id: "k-8", key: "WEB-8" }] });
    expect(blocking([cart, task(8, "f-1")]).get("k-8")).toEqual([{ id: "k-3", key: "WEB-3" }]);
  });
});

describe("who may drag a card", () => {
  const owned = { owner_id: ada.id };
  const held = task(3, "f-1", { claim: { id: "c", task_id: "k-3", holder_id: builder.id, session_id: "s", started_at: at(1) } });

  it("a Member of the Team, the Feature's owner, or the holder", () => {
    expect(mayMove(task(3, "f-1"), { member: "m-x", inTeam: true, feature: owned, now })).toBe(true);
    expect(mayMove(task(3, "f-1"), { member: ada.id, inTeam: false, feature: owned, now })).toBe(true);
    expect(mayMove(held, { member: builder.id, inTeam: false, feature: owned, now })).toBe(true);
    expect(mayMove(held, { member: "m-x", inTeam: false, feature: owned, now })).toBe(false);
  });

  it("nobody, once the Task has ended", () => {
    expect(mayMove(task(4, "f-1", { state: "done" }), { member: ada.id, inTeam: true, feature: owned, now })).toBe(false);
  });
});

describe("a refused drag", () => {
  const base = { task: { key: "WEB-17" }, takeable: false, holds: false, owns: false, ownerName: "Mai Tran", teamName: "Web", message: "refused" };
  const done = { name: "Done" };
  const dropped = { name: "Dropped" };

  it("on Done names Complete, and offers Claim when the mover can take the Task", () => {
    expect(refusalNote("use_complete", { ...base, target: done, takeable: true })).toEqual({
      title: "Not moved to Done",
      body: "Done is reached by completing a Task you hold.",
      action: { kind: "claim", label: "Claim WEB-17" },
    });
    expect(refusalNote("use_complete", { ...base, target: done }).action).toBeUndefined();
  });

  it("on Done sends the holder to the Task to Complete it", () => {
    expect(refusalNote("use_complete", { ...base, target: done, holds: true })).toMatchObject({
      body: "Complete WEB-17 to move it to Done.",
      action: { kind: "open", label: "Open WEB-17" },
    });
  });

  it("on Dropped names the Feature owner, or sends the owner to Drop it", () => {
    expect(refusalNote("use_drop", { ...base, target: dropped }).body).toBe("Only the Feature owner, Mai Tran, can drop WEB-17.");
    expect(refusalNote("use_drop", { ...base, target: dropped, owns: true })).toMatchObject({ action: { kind: "open" } });
  });

  it("by a Member outside the Team says who may move it", () => {
    expect(refusalNote("forbidden", { ...base, target: { name: "Todo" } }).body).toBe("Only Members of Web, the Feature owner or its holder move WEB-17.");
  });

  it("of an ended Task says it stays", () => {
    expect(refusalNote("ended", { ...base, target: { name: "Todo" } }).body).toBe("WEB-17 has ended and stays where it is.");
  });

  it("for anything else passes the server's words on", () => {
    expect(refusalNote("internal", { ...base, target: { name: "Todo" } }).body).toBe("refused");
  });
});

describe("Rank", () => {
  const ranked = [feature(11, 1), feature(1, 2), feature(18, 3, { state: "shipped" }), feature(9, 4)];

  it("takes the position of the Feature dropped on, counting ended Features", () => {
    expect(rankPosition(ranked, "f-9")).toBe(4);
    expect(rankPosition(ranked, "f-11")).toBe(1);
  });

  it("moves a Feature as the server does, renumbering the Rank", () => {
    expect(moveFeature(ranked, "f-11", 4).map((f) => [f.key, f.rank])).toEqual([
      ["WEB-1", 1],
      ["WEB-18", 2],
      ["WEB-9", 3],
      ["WEB-11", 4],
    ]);
    expect(moveFeature(ranked, "f-9", 1).map((f) => f.key)).toEqual(["WEB-9", "WEB-11", "WEB-1", "WEB-18"]);
  });
});

describe("a Feature's Tasks", () => {
  it("draws done, held and waiting shares of all its Tasks", () => {
    expect(taskBar({ open: 2, claimed: 1, done: 1, dropped: 1 })).toEqual({ done: 25, held: 25, waiting: 25 });
    expect(taskBar({ open: 0, claimed: 0, done: 0, dropped: 0 })).toEqual({ done: 0, held: 0, waiting: 0 });
  });

  it("counts them, naming dropped only when there are any", () => {
    expect(countsText({ open: 2, claimed: 1, done: 1, dropped: 1 })).toBe("1 done · 2 open · 1 dropped");
    expect(countsText({ open: 5, claimed: 1, done: 2, dropped: 0 })).toBe("2 done · 5 open");
  });
});
