import { describe, expect, it } from "vitest";
import type { Activity } from "@/api/client";
import { ada, builder, engineer, step, task, web } from "@/test/fixtures";
import { foldActivity, type ActivityRow } from "./fold";
import { entry } from "./testing";
import { rowSentence, sentenceText, type Lookup } from "./wording";

// DARK-2 on the dogfood run, 2026-10-10: builder took it at Fix, wrote a Note, asked DARK-4
// (aimed at the owner, blocking DARK-2), attached wc.log and released it at 10:16; the Runner
// attached the Shift's log a minute later, after the owner had claimed DARK-4 to answer it.
const dark2 = task(2, { title: "Cannot delete a Workflow in a Project" });
const dark4 = task(4, { title: "Should an admin delete from the page?", aimed_at_id: ada.id });
const t0 = Date.parse("2026-10-10T10:15:00");
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
const by = (actor: string, min: number, payload: Record<string, unknown> = {}) => ({ actor_id: actor, at: at(min), payload });

const dark2Run: Activity[] = [
  entry(10, "task.claimed", dark2.id, by(builder.id, 0, { claim_id: "c-b1", skill_id: engineer.id, model_label: "claude-sonnet-5-5" })),
  entry(11, "task.note_added", dark2.id, by(builder.id, 0.5, { note_id: "n-1" })),
  entry(12, "task.filed", dark4.id, by(builder.id, 0.7, { key: dark4.key, title: dark4.title, blocks: dark2.id, aimed_at_id: ada.id })),
  entry(13, "task.evidence_attached", dark2.id, by(builder.id, 0.8, { evidence_id: "e-wc", filename: "wc.log", size: 753, kind: "evidence" })),
  entry(14, "task.released", dark2.id, by(builder.id, 1, { claim_id: "c-b1" })),
  entry(15, "task.claimed", dark4.id, by(ada.id, 1.5, { claim_id: "c-a1" })),
  entry(16, "task.evidence_attached", dark2.id, by(builder.id, 2, { evidence_id: "e-log", filename: "shift-DARK-2-builder-101600.log", size: 56_800, kind: "log" })),
];

const lookup: Lookup = {
  members: new Map([ada, builder].map((m) => [m.id, m])),
  skills: new Map([[engineer.id, engineer]]),
  tasks: new Map([dark2, dark4].map((t) => [t.id, t])),
  stepName: (id) => ({ [step.build]: "Fix", [step.review]: "Code review" })[id],
  projects: new Map([[web.id, web]]),
  claims: new Map(),
};

const newestFirst = (es: Activity[]) => [...es].sort((a, b) => b.seq - a.seq);
const shape = (rows: ActivityRow[]) => rows.map((r) => [r.entry.seq, r.folded.map((f) => f.seq)]);
const said = (rows: ActivityRow[]) => rows.map((r) => sentenceText(rowSentence(r, lookup)!));

describe("Activity folds a Claim", () => {
  it("folds what builder wrote on DARK-2 inside its Claim, and the Shift's log a minute later, into the release", () => {
    const rows = foldActivity(newestFirst(dark2Run));
    expect(shape(rows)).toEqual([
      [15, []],
      [14, [11, 12, 13, 16]],
      [10, []],
    ]);
    expect(said(rows)[1]).toBe("builder released WEB-2 Cannot delete a Workflow in a Project · asked WEB-4 · a Note · wc.log 753 B · Shift log · 56.8 kB");
    expect(said(rows)[2]).toBe("builder claimed WEB-2 Cannot delete a Workflow in a Project · engineer · claude-sonnet-5-5");
  });

  it("folds each Claim into its own end, and counts the Notes", () => {
    const rows = foldActivity(
      newestFirst([
        entry(1, "task.claimed", dark2.id, by(builder.id, 0, { claim_id: "a" })),
        entry(2, "task.note_added", dark2.id, by(builder.id, 1)),
        entry(3, "task.advanced", dark2.id, by(builder.id, 2, { claim_id: "a", from: step.build, to: step.review, outcome: "ready" })),
        entry(4, "task.claimed", dark2.id, by(builder.id, 3, { claim_id: "b" })),
        entry(5, "task.note_added", dark2.id, by(builder.id, 4)),
        entry(6, "task.note_added", dark2.id, by(builder.id, 5)),
        entry(7, "task.observed", dark2.id, by(builder.id, 5, { outcome: "worked" })),
        entry(8, "task.released", dark2.id, by(builder.id, 6, { claim_id: "b" })),
      ]),
    );
    expect(shape(rows)).toEqual([
      [8, [5, 6, 7]],
      [4, []],
      [3, [2]],
      [1, []],
    ]);
    expect(said(rows)[0]).toBe("builder released WEB-2 Cannot delete a Workflow in a Project · 2 Notes · an Observation");
  });

  it("folds a lapsed Claim into the lapse, by its holder", () => {
    const rows = foldActivity(
      newestFirst([
        entry(1, "task.claimed", dark2.id, by(builder.id, 0, { claim_id: "a" })),
        entry(2, "task.note_added", dark2.id, by(builder.id, 1)),
        entry(3, "task.lapsed", dark2.id, { at: at(9), payload: { claim_id: "a", holder_id: builder.id } }),
      ]),
    );
    expect(shape(rows)).toEqual([
      [3, [2]],
      [1, []],
    ]);
  });

  it("leaves what another Member wrote, a Claim still held, and an entry about another Task as rows", () => {
    const rows = foldActivity(
      newestFirst([
        entry(1, "task.claimed", dark2.id, by(builder.id, 0, { claim_id: "a" })),
        entry(2, "task.note_added", dark2.id, by(ada.id, 1)),
        entry(3, "task.note_added", dark4.id, by(builder.id, 2)),
        entry(4, "task.note_added", dark2.id, by(builder.id, 3)),
      ]),
    );
    expect(shape(rows)).toEqual([
      [4, []],
      [3, []],
      [2, []],
      [1, []],
    ]);
  });

  it("gives a Shift's log that came after its Claim's grace a row of its own, naming the Shift's end", () => {
    const rows = foldActivity(
      newestFirst([
        entry(1, "task.claimed", dark2.id, by(builder.id, 0, { claim_id: "a" })),
        entry(2, "task.released", dark2.id, by(builder.id, 1, { claim_id: "a" })),
        // An entry before Task 4 has no kind: the Runner's file name says it is a log.
        entry(3, "task.evidence_attached", dark2.id, by(builder.id, 45, { evidence_id: "e-log", filename: "shift-DARK-2-builder-101600.log", size: 56_800 })),
      ]),
    );
    expect(shape(rows)).toEqual([
      [3, []],
      [2, []],
      [1, []],
    ]);
    const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at(1)));
    expect(said(rows)[0]).toBe(`builder · Shift log · 56.8 kB on WEB-2 Cannot delete a Workflow in a Project · the Shift that ended ${clock}`);
  });

  it("folds a Claim an admin took back, or a revoked token ended, into that end, by the holder", () => {
    for (const kind of ["task.taken_back", "task.claim_ended"] as const) {
      const rows = foldActivity(
        newestFirst([
          entry(1, "task.claimed", dark2.id, by(builder.id, 0, { claim_id: "a" })),
          entry(2, "task.note_added", dark2.id, by(builder.id, 1)),
          entry(3, kind, dark2.id, by(ada.id, 2, { claim_id: "a", holder_id: builder.id, how_ended: "token_revoked" })),
          entry(4, "task.evidence_attached", dark2.id, by(builder.id, 3, { evidence_id: "e-log", filename: "shift-DARK-2-builder-101600.log", size: 56_800, kind: "log" })),
        ]),
      );
      expect(shape(rows), kind).toEqual([
        [3, [2, 4]],
        [1, []],
      ]);
    }
  });

  it("names the Stop as the end of the Shift whose log came after the grace", () => {
    const rows = foldActivity(
      newestFirst([
        entry(1, "task.claimed", dark2.id, by(builder.id, 0, { claim_id: "a" })),
        entry(2, "task.taken_back", dark2.id, by(ada.id, 1, { claim_id: "a", holder_id: builder.id })),
        entry(3, "task.evidence_attached", dark2.id, by(builder.id, 45, { evidence_id: "e-log", filename: "shift-DARK-2-builder-101600.log", size: 56_800, kind: "log" })),
      ]),
    );
    expect(shape(rows)).toEqual([
      [3, []],
      [2, []],
      [1, []],
    ]);
    const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at(1)));
    expect(said(rows)[0]).toMatch(new RegExp(`· the Shift that ended ${clock}$`));
  });

  it("puts a log on the Claim end its entry names, however late it came", () => {
    const log = (seq: number, min: number, claim?: string | null) =>
      entry(seq, "task.evidence_attached", dark2.id, by(builder.id, min, { evidence_id: `e-${seq}`, filename: "shift-DARK-2-builder-101600.log", size: 56_800, kind: "log", ...(claim !== undefined ? { claim_id: claim } : {}) }));
    const claims = [
      entry(1, "task.claimed", dark2.id, by(builder.id, 0, { claim_id: "a" })),
      entry(2, "task.released", dark2.id, by(builder.id, 1, { claim_id: "a" })),
      entry(3, "task.claimed", dark2.id, by(builder.id, 2, { claim_id: "b" })),
      entry(4, "task.released", dark2.id, by(builder.id, 3, { claim_id: "b" })),
    ];
    // Two hours late, naming the first of builder's two Claims.
    expect(shape(foldActivity(newestFirst([...claims, log(5, 120, "a")])))).toEqual([
      [4, []],
      [3, []],
      [2, [5]],
      [1, []],
    ]);
    // Within b's grace, but naming a.
    expect(shape(foldActivity(newestFirst([...claims, log(5, 4, "a")])))).toEqual([
      [4, []],
      [3, []],
      [2, [5]],
      [1, []],
    ]);
    // Naming none, two hours late: a row of its own, as before.
    expect(shape(foldActivity(newestFirst([...claims, log(5, 120)])))[0]).toEqual([5, []]);
    expect(shape(foldActivity(newestFirst([...claims, log(5, 120, null)])))[0]).toEqual([5, []]);
  });

  it("folds the holder's Evidence into the Claim end its entry names", () => {
    const rows = foldActivity(
      newestFirst([
        entry(1, "task.claimed", dark2.id, by(builder.id, 0, { claim_id: "a" })),
        entry(2, "task.released", dark2.id, by(builder.id, 1, { claim_id: "a" })),
        entry(3, "task.claimed", dark2.id, by(builder.id, 2, { claim_id: "b" })),
        entry(4, "task.evidence_attached", dark2.id, by(builder.id, 3, { evidence_id: "e-wc", filename: "wc.log", size: 753, kind: "evidence", claim_id: "b" })),
        entry(5, "task.released", dark2.id, by(builder.id, 4, { claim_id: "b" })),
      ]),
    );
    expect(shape(rows)).toEqual([
      [5, [4]],
      [3, []],
      [2, []],
      [1, []],
    ]);
  });

  it("folds nothing when a filter left only one kind", () => {
    const notes = dark2Run.filter((e) => e.kind === "task.note_added" || e.kind === "task.evidence_attached");
    expect(foldActivity(newestFirst(notes))).toHaveLength(notes.length);
  });
});
