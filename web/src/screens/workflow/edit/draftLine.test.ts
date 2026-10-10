import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { skills, step, workflow } from "@/test/fixtures";
import { addOutcome, fromRecord, renameOutcome, renameStep, reorderStep, setSkill, groupsOf } from "./draft";
import { useDraftLine } from "./draftLine";

const skillMap = new Map(skills.map((s) => [s.id, s]));
const none = new Map();

describe("the draft as the line lays it out", () => {
  it("keeps the same layout while a Step or an outcome is renamed: typing never lays the line out again", () => {
    const d = fromRecord(workflow());
    const { result, rerender } = renderHook(({ wf }) => useDraftLine(wf, skillMap, undefined, none), { initialProps: { wf: d.wf } });
    const { t, parts } = result.current;
    rerender({ wf: renameStep(d, step.build, "Make").wf });
    expect(result.current.t).toBe(t);
    expect(result.current.parts).toBe(parts);
    rerender({ wf: renameOutcome(renameStep(d, step.build, "Make"), `${step.review}-c4`, "rework").wf });
    expect(result.current.t).toBe(t);
  });

  it("lays it out again when its structure changes: a Step moved, a Skill changed, an outcome added", () => {
    const d = fromRecord(workflow());
    const { result, rerender } = renderHook(({ wf }) => useDraftLine(wf, skillMap, undefined, none), { initialProps: { wf: d.wf } });
    const { t } = result.current;
    rerender({ wf: reorderStep(d, step.build, 1, groupsOf(d.wf, skillMap)).wf });
    expect(result.current.t).not.toBe(t);
    expect(result.current.t.main.slice(0, 2)).toEqual([step.review, step.build]);
    const was = result.current.t;
    rerender({ wf: setSkill(d, step.plan, undefined).wf });
    expect(result.current.t).not.toBe(was);
    const was2 = result.current.t;
    rerender({ wf: addOutcome(d, step.build).draft.wf });
    expect(result.current.t).not.toBe(was2);
  });
});
