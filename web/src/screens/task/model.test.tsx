import { describe, expect, it } from "vitest";
import type { Claim, Member, TaskDetail } from "@/api/client";
import { ada, bob, builder, feature, task } from "@/test/fixtures";
import { canTakeBack, taskActions } from "./actions";
import { diffSummary, lineDiff } from "./diff";
import { orderTasks } from "./format";
import { durationText, lapsedClaim, taskRecord } from "./record";
import { whoCanTake } from "./takers";

const t0 = Date.parse("2026-10-06T22:00:00Z");
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
const now = t0 + 30 * 60_000;

function claim(id: string, holder: string, start: number, extra: Partial<Claim> = {}): Claim {
  return { id, task_id: "k-3", holder_id: holder, session_id: `sess-${holder}`, started_at: at(start), ...extra };
}

function detail(extra: Partial<TaskDetail> = {}, taskExtra: Parameters<typeof task>[2] = {}): TaskDetail {
  return {
    task: task(3, "f-1", { created_at: at(0), waiting_since: at(0), ...taskExtra }),
    status: { id: "st-todo", name: "Todo", kind: "todo", position: 2 },
    feature: feature(1, 1),
    claims: [],
    notes: [],
    evidence: [],
    blockers: [],
    blocking: [],
    observations: [],
    ...extra,
  };
}

describe("a Task's record", () => {
  it("merges the filing, the Claims, Notes, Observations, Evidence and questions in time order", () => {
    const lapsed = claim("c-1", builder.id, 1, { ended_at: at(2), how_ended: "lapsed", heartbeat_timeout_seconds: 2 });
    const live = claim("c-2", bob.id, 5, { expires_at: at(40), heartbeat_timeout_seconds: 900 });
    const question = task(8, "f-1", { created_at: at(7), filed_by: bob.id, aimed_at_id: ada.id, skill_id: undefined });
    const d = detail({
      claims: [lapsed, live],
      notes: [{ id: "n-1", task_id: "k-3", author_id: bob.id, body: "Stuck on the keys", created_at: at(6) }],
      observations: [{ id: "o-1", task_id: "k-3", feature_id: "f-1", author_id: bob.id, outcome: "worked", body: "ok", created_at: at(8) }],
      evidence: [{ id: "e-1", feature_id: "f-1", task_id: "k-3", filename: "a.png", content_type: "image/png", size: 70, sha256: "x", attached_by: bob.id, created_at: at(9) }],
      blockers: [question],
    });
    expect(taskRecord(d).map((e) => e.kind)).toEqual(["filed", "claimed", "claim-ended", "claimed", "note", "question", "observation", "evidence"]);
  });

  it("puts a Note written with a Handover before it, and names the Skill handed over to", () => {
    const first = claim("c-1", builder.id, 1, { ended_at: at(4), how_ended: "handed_over", skill_id: "s-build" });
    const d = detail(
      { claims: [first], notes: [{ id: "n-1", task_id: "k-3", author_id: builder.id, body: "Over to you", created_at: at(4) }] },
      { skill_id: "s-review" },
    );
    const record = taskRecord(d);
    expect(record.map((e) => e.kind)).toEqual(["filed", "claimed", "note", "claim-ended"]);
    expect(record[3]).toMatchObject({ kind: "claim-ended", nextSkillId: "s-review" });
  });

  it("names the Skill of the next Claim for an earlier Handover", () => {
    const first = claim("c-1", builder.id, 1, { ended_at: at(2), how_ended: "handed_over", skill_id: "s-build" });
    const second = claim("c-2", bob.id, 3, { ended_at: at(4), how_ended: "handed_over", skill_id: "s-review" });
    const record = taskRecord(detail({ claims: [first, second] }, { skill_id: "s-build" }));
    const ends = record.filter((e) => e.kind === "claim-ended");
    expect(ends.map((e) => e.kind === "claim-ended" && e.nextSkillId)).toEqual(["s-review", "s-build"]);
  });

  it("says once that a held Task was dropped, and ends a done Task with its completion", () => {
    const dropped = detail(
      { claims: [claim("c-1", builder.id, 1, { ended_at: at(5), how_ended: "dropped" })] },
      { state: "dropped", ended_at: at(5) },
    );
    expect(taskRecord(dropped).map((e) => e.kind)).toEqual(["filed", "claimed", "ended"]);

    const done = detail({ claims: [claim("c-1", builder.id, 1, { ended_at: at(5), how_ended: "completed" })] }, { state: "done", ended_at: at(5) });
    expect(taskRecord(done).map((e) => e.kind)).toEqual(["filed", "claimed", "claim-ended"]);
  });

  it("leaves out a blocker that was there before the Task, and keeps the proposal", () => {
    const older = task(2, "f-1", { created_at: at(-10) });
    const proposal = { id: "p-1", skill_id: "s-web", task_id: "k-3", based_on_version: 1, body: "x", author_id: ada.id, state: "pending" as const, created_at: at(3) };
    expect(taskRecord(detail({ blockers: [older], proposal })).map((e) => e.kind)).toEqual(["filed", "proposal"]);
  });

  it("finds the lapse that left a Task unheld", () => {
    const lapsed = claim("c-1", builder.id, 1, { ended_at: at(2), how_ended: "lapsed" });
    expect(lapsedClaim(detail({ claims: [lapsed] }))).toBe(lapsed);
    expect(lapsedClaim(detail({ claims: [lapsed, claim("c-2", bob.id, 3)] }))).toBeUndefined();
    expect(durationText(2)).toBe("2 s");
    expect(durationText(900)).toBe("15 min");
  });
});

// Mai reports to tuongaz; builder-1 reports to Mai; kai is elsewhere.
const tuongaz: Member = { ...ada, id: "m-t", name: "tuongaz" };
const mai: Member = { ...bob, id: "m-mai", name: "Mai Tran", manager_id: tuongaz.id };
const b1: Member = { ...builder, id: "m-b1", name: "builder-1", manager_id: mai.id };
const kai: Member = { ...bob, id: "m-kai", name: "Kai Nguyen", manager_id: undefined };
const members = new Map([tuongaz, mai, b1, kai].map((m) => [m.id, m]));

describe("Take back", () => {
  it("is for the Feature owner and anyone above the holder on the Reporting line", () => {
    expect(canTakeBack(members, mai.id, b1.id, kai.id)).toBe(true); // b1's manager
    expect(canTakeBack(members, tuongaz.id, b1.id, kai.id)).toBe(true); // two steps up
    expect(canTakeBack(members, kai.id, b1.id, kai.id)).toBe(true); // the owner
    expect(canTakeBack(members, kai.id, b1.id, mai.id)).toBe(false); // neither
    expect(canTakeBack(members, b1.id, mai.id, kai.id)).toBe(false); // below, not above
    expect(canTakeBack(members, b1.id, b1.id, b1.id)).toBe(false); // the holder releases
  });

  it("survives a Reporting line that loops", () => {
    const loop = new Map(members);
    loop.set(tuongaz.id, { ...tuongaz, manager_id: b1.id });
    expect(canTakeBack(loop, kai.id, b1.id, mai.id)).toBe(false);
  });
});

describe("the actions on a Task, by role", () => {
  const live = (holder: string) => claim("c-1", holder, 1, { expires_at: at(45), heartbeat_timeout_seconds: 900 });
  const base = { members, takeable: new Set<string>(), teams: new Set([feature(1, 1).team_id]), now };
  const owned = (owner: string, extra: Partial<TaskDetail["task"]> = {}) => ({
    task: task(3, "f-1", extra),
    feature: feature(1, 1, { owner_id: owner }),
  });

  it("offers Claim when the Task is in my takeable list, and nothing primary otherwise", () => {
    const d = owned(kai.id);
    expect(taskActions({ ...base, me: mai.id, detail: d, takeable: new Set([d.task.id]) }).primary).toBe("claim");
    expect(taskActions({ ...base, me: mai.id, detail: d }).primary).toBeUndefined();
  });

  it("gives the holder Complete, Hand over and Release, the Note composer and the rare actions", () => {
    const a = taskActions({ ...base, me: mai.id, detail: owned(kai.id, { claim: live(mai.id) }) });
    expect(a).toMatchObject({ primary: "complete", caret: ["hand-over", "release"], notes: { composer: true }, status: "menu" });
    expect(a.menu).toEqual(["observe", "attach-evidence", "add-blocker", "drop"]);
    expect(a.dimmed).toEqual({ drop: "Owner only" });
  });

  it("adds Propose on a Retrospective the caller holds", () => {
    const a = taskActions({ ...base, me: mai.id, detail: owned(kai.id, { kind: "retrospective", claim: live(mai.id) }) });
    expect(a.menu).toContain("propose");
  });

  it("gives Take back up the Reporting line, and says who may write a Note", () => {
    const a = taskActions({ ...base, me: tuongaz.id, detail: owned(mai.id, { claim: live(b1.id) }) });
    expect(a.primary).toBeUndefined();
    expect(a.menu).toEqual(["take-back", "drop"]);
    expect(a.notes).toEqual({ onlyHolder: b1.id });
    const outside = taskActions({ ...base, me: kai.id, detail: owned(mai.id, { claim: live(b1.id) }) });
    expect(outside.menu).toEqual(["drop"]);
  });

  it("lets the owner drop, and dims Drop for anyone else", () => {
    expect(taskActions({ ...base, me: kai.id, detail: owned(kai.id) }).dimmed).toEqual({});
    expect(taskActions({ ...base, me: mai.id, detail: owned(kai.id) }).dimmed).toEqual({ drop: "Owner only" });
  });

  it("treats a lapsed Claim as no Claim", () => {
    const lapsed = claim("c-1", b1.id, 1, { expires_at: at(2), heartbeat_timeout_seconds: 2 });
    const a = taskActions({ ...base, me: mai.id, detail: owned(kai.id, { claim: lapsed }) });
    expect(a.notes).toBeNull();
    expect(a.menu).not.toContain("take-back");
  });

  it("makes the Status a fact outside the Feature's Team and on an ended Task", () => {
    expect(taskActions({ ...base, teams: new Set(), me: mai.id, detail: owned(kai.id) }).status).toBe("fact");
    const ended = taskActions({ ...base, me: kai.id, detail: owned(kai.id, { state: "done" }) });
    expect(ended).toMatchObject({ status: "fact", menu: ["attach-evidence"] });
    expect(ended.primary).toBeUndefined();
  });
});

describe("the proposal diff", () => {
  it("shows the added line and keeps the rest", () => {
    const from = "1. Reuse the cart component.\n2. Ship behind a flag.\n";
    const to = "1. Reuse the cart component.\n2. Ship behind a flag.\n3. Point e2e at Mailpit.\n";
    const diff = lineDiff(from, to);
    expect(diff).toEqual([
      { op: "same", text: "1. Reuse the cart component." },
      { op: "same", text: "2. Ship behind a flag." },
      { op: "add", text: "3. Point e2e at Mailpit." },
    ]);
    expect(diffSummary(diff)).toBe("1 line added");
  });

  it("puts a changed line as a removal then an addition", () => {
    const diff = lineDiff("a\nb\nc", "a\nB\nc");
    expect(diff.map((l) => `${l.op}:${l.text}`)).toEqual(["same:a", "del:b", "add:B", "same:c"]);
    expect(diffSummary(diff)).toBe("1 line added, 1 removed");
    expect(diffSummary(lineDiff("a", "a"))).toBe("No change");
  });
});

describe("who could take a Task", () => {
  const skillsOf = new Map([
    [mai.id, new Set(["s-review"])],
    [b1.id, new Set(["s-web"])],
    [kai.id, new Set(["s-review"])],
  ]);
  const pool = [mai, b1, kai];

  it("is the Members with the Skill, less anyone who held it under another Skill", () => {
    expect(whoCanTake({ skillId: "s-review", pool, skillsOf, claims: [], owner: tuongaz.id })).toEqual([mai.id, kai.id]);
    expect(whoCanTake({ skillId: "s-review", pool, skillsOf, claims: [{ holder_id: mai.id, skill_id: "s-web" }], owner: tuongaz.id })).toEqual([kai.id]);
  });

  it("is the Member it is aimed at, or the owner when no one has the Skill", () => {
    expect(whoCanTake({ aimedAt: mai.id, pool, skillsOf, claims: [], owner: tuongaz.id })).toEqual([mai.id]);
    expect(whoCanTake({ skillId: "s-qa", pool, skillsOf, claims: [], owner: tuongaz.id })).toEqual([tuongaz.id]);
  });
});

describe("the Feature's Tasks", () => {
  it("sort by Status, then by how long each has waited; open before ended until the Statuses load", () => {
    const statuses = [
      { id: "st-backlog", name: "Backlog", kind: "backlog" as const },
      { id: "st-todo", name: "Todo", kind: "todo" as const },
      { id: "st-done", name: "Done", kind: "done" as const },
    ];
    const done = task(2, "f-1", { status_id: "st-done", state: "done", waiting_since: at(0) });
    const later = task(4, "f-1", { status_id: "st-todo", waiting_since: at(5) });
    const sooner = task(5, "f-1", { status_id: "st-todo", waiting_since: at(1) });
    const backlog = task(6, "f-1", { status_id: "st-backlog", waiting_since: at(9) });
    expect(orderTasks([done, later, sooner, backlog], statuses).map((t) => t.key)).toEqual(["WEB-6", "WEB-5", "WEB-4", "WEB-2"]);
    expect(orderTasks([done, later], undefined).map((t) => t.key)).toEqual(["WEB-4", "WEB-2"]);
  });
});
