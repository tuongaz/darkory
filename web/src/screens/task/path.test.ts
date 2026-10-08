import { describe, expect, it } from "vitest";
import type { Activity } from "@/api/client";
import { parentTask, step, task } from "@/test/fixtures";
import { taskPath } from "./path";

const t = (min: number) => `2026-10-01T09:${String(min).padStart(2, "0")}:00Z`;
const ms = (min: number) => Date.parse(t(min));
const entry = (seq: number, kind: Activity["kind"], min: number, payload: Record<string, unknown> = {}, subject = "k-1"): Activity => ({
  seq,
  at: t(min),
  kind,
  subject_type: "task",
  subject_id: subject,
  payload,
});

describe("a Task's path through its Steps", () => {
  it("reads filing, a move, an advance and a send-back, with the time at each", () => {
    const now = task(1, { step_id: step.build, step_since: t(40) });
    const path = taskPath(now, [
      entry(4, "task.advanced", 40, { from: step.review, to: step.build, outcome: "needs changes", since: ms(30) }),
      entry(1, "task.filed", 0, { step_id: step.backlog }),
      entry(2, "task.moved", 10, { from: step.backlog, to: step.build, since: ms(0) }),
      entry(3, "task.advanced", 30, { from: step.build, to: step.review, outcome: "pass", since: ms(10) }),
      entry(3, "task.advanced", 30, { from: step.build, to: step.review, outcome: "pass", since: ms(10) }),
      entry(9, "task.moved", 50, { from: step.build, to: step.review }, "k-other"),
    ]);
    expect(path.stays).toEqual([
      { stepId: step.backlog, since: ms(0), until: ms(10), left: { by: "moved" } },
      { stepId: step.build, since: ms(10), until: ms(30), left: { by: "advanced", outcome: "pass" } },
      { stepId: step.review, since: ms(30), until: ms(40), left: { by: "advanced", outcome: "needs changes" } },
      { stepId: step.build, since: ms(40) },
    ]);
    expect(path.end).toBeUndefined();
  });

  it("ends Done, and starts where the read began when the filing is out of reach", () => {
    const done = task(1, { state: "done", step_id: undefined, step_since: undefined, ended_at: t(30) });
    const path = taskPath(done, [entry(7, "task.completed", 30, { from: step.review, since: ms(20) })]);
    expect(path.stays).toEqual([{ stepId: step.review, since: ms(20), until: ms(30), left: { by: "completed" } }]);
    expect(path.end).toEqual({ kind: "done", at: ms(30) });
    // Completed by advancing into Done: the Connector's outcome is how it left.
    const along = taskPath(done, [entry(7, "task.completed", 30, { from: step.review, since: ms(20), outcome: "pass" })]);
    expect(along.stays[0].left).toEqual({ by: "completed", outcome: "pass" });
  });

  it("takes the record's Step when no Activity reaches it", () => {
    expect(taskPath(task(1, { step_since: t(5) }), []).stays).toEqual([{ stepId: step.build, since: ms(5) }]);
  });

  it("ends at the Subtasks when the Task becomes a Parent", () => {
    const p = parentTask(1, { open: 1, working: 0, done: 0, dropped: 0 });
    const path = taskPath(p, [entry(1, "task.filed", 0, { step_id: step.build }), entry(2, "task.became_parent", 15, { from: step.build, since: ms(0) })]);
    expect(path.stays).toEqual([{ stepId: step.build, since: ms(0), until: ms(15), left: { by: "parent" } }]);
    expect(path.end).toEqual({ kind: "parent", at: ms(15) });
  });
});
