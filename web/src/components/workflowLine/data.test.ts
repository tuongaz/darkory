import { describe, expect, it } from "vitest";
import type { Activity, Claim } from "@/api/client";
import { blockingCount, chainOf, scopedLine, traceOf, unblocksWhen } from "./data";
import { workflowsSkills, workflowsFixture } from "@/test/fixtures";
import { MAIN } from "./fixtures";
import { startStep, stepsOf, type LineTask, type LineWorkflow } from "./model";

// The fixture's open Tasks (mock-workflow/fixture.md with the deps round's MAIN-18 and MAIN-19).
const tk = (n: number, extra: Partial<LineTask> = {}): LineTask => ({ id: `k-${n}`, key: `MAIN-${n}`, title: `T${n}`, kind: "work", blockers: [], ...extra });
const by = (...ns: number[]) => ns.map((n) => ({ id: `k-${n}`, key: `MAIN-${n}`, title: `T${n}` }));
const tu = { id: "m-tu", name: "tuongaz", kind: "human" as const };
const all: LineTask[] = [
  tk(4, { stepId: "build", blockers: by(13) }),
  tk(5, { stepId: "backlog" }),
  tk(6, { stepId: "review", holder: { id: "m-rv", name: "reviewer", kind: "agent", working: "waiting" } }),
  tk(9, { stepId: "qa", parentId: "k-7", holder: { id: "m-qa", name: "qa", kind: "agent" } }),
  tk(10, { stepId: "build", parentId: "k-7", holder: { id: "m-bu", name: "builder", kind: "agent" } }),
  tk(11, { stepId: "build", parentId: "k-7", blockers: by(10) }),
  tk(12, { stepId: "review", parentId: "k-7" }),
  tk(13, { aimedAt: tu }),
  tk(14, { stepId: "retro", parentId: "k-1", kind: "retrospective" }),
  tk(18, { stepId: "build", parentId: "k-7", blockers: by(11) }),
  tk(19, { stepId: "build", blockers: by(12, 4) }),
];
const me = { id: "m-tu", takeable: new Set(["k-12"]) };

describe("Blocking on the line", () => {
  it("counts the Blockings, not the blocked Tasks: Blocking 5", () => {
    expect(blockingCount(all)).toBe(5);
  });

  it("MAIN-19's chain: MAIN-13 → MAIN-4 and MAIN-12, unblocks when both end, first answer MAIN-13", () => {
    const c = chainOf("k-19", all, me)!;
    expect(c.upstream.map((p) => p.map((x) => x.key))).toEqual([["MAIN-12"], ["MAIN-13", "MAIN-4"]]);
    expect(unblocksWhen(c)).toBe("Unblocks when MAIN-12 and MAIN-4 end");
    expect(c.first).toMatchObject({ kind: "answer", task: { key: "MAIN-13" } });
  });

  it("MAIN-18's chain runs MAIN-10, then MAIN-11; nothing in it is for you", () => {
    const c = chainOf("k-18", all, me)!;
    expect(unblocksWhen(c)).toBe("Unblocks when MAIN-10, then MAIN-11 end");
    expect(c.first).toEqual({ kind: "none" });
  });

  it("MAIN-10 blocks MAIN-11, and MAIN-18 after it", () => {
    const c = chainOf("k-10", all, me)!;
    expect(c.upstream).toEqual([]);
    expect(c.downstream.map((x) => x.key)).toEqual(["MAIN-11", "MAIN-18"]);
    expect(c.links).toEqual([
      ["k-10", "k-11"],
      ["k-11", "k-18"],
    ]);
  });

  it("offers to take a Task the viewer can take when no question comes first", () => {
    const c = chainOf("k-19", all.filter((t) => t.id !== "k-4").map((t) => (t.id === "k-19" ? { ...t, blockers: by(12) } : t)), me)!;
    expect(c.first).toMatchObject({ kind: "take", task: { key: "MAIN-12" } });
  });
});

describe("scopes", () => {
  it("All Tasks draws every Task at a Step, the question none", () => {
    const s = scopedLine(all, { kind: "all" }, { workflow: MAIN });
    expect(s.drawn).toHaveLength(10);
    expect(s.hiddenTotal).toBe(0);
  });

  it("No Parent keeps the Tasks with none, a +N on each Step for the rest", () => {
    const s = scopedLine(all, { kind: "none" }, { workflow: MAIN });
    expect(s.drawn.map((t) => t.key)).toEqual(["MAIN-4", "MAIN-5", "MAIN-6", "MAIN-19"]);
    expect(Object.fromEntries(s.hidden)).toEqual({ qa: 1, build: 3, review: 1, retro: 1 });
  });

  it("a Parent: its open Subtasks, its done ones at Done, its Acceptance and Retrospective still to come", () => {
    const parent = {
      id: "k-7",
      key: "MAIN-7",
      title: "Emoji reactions",
      ended: false,
      acceptance: true,
      subtasks: [8, 9, 10, 11, 12, 18].map((n) => ({ id: `k-${n}`, key: `MAIN-${n}`, title: "", kind: n === 8 ? ("breakdown" as const) : ("work" as const), state: n === 8 ? ("done" as const) : ("open" as const) })),
    };
    const s = scopedLine(all, { kind: "parent", id: "k-7" }, { workflow: MAIN, parent });
    expect(s.drawn.map((t) => t.key)).toEqual(["MAIN-9", "MAIN-10", "MAIN-11", "MAIN-12", "MAIN-18"]);
    expect(s.done.map((t) => t.key)).toEqual(["MAIN-8"]);
    expect(s.ghosts).toEqual([
      { stepId: "acceptance", text: "when 5 open end Done", label: "Acceptance" },
      { stepId: "retro", text: "when MAIN-7 ends", label: "Retrospective" },
    ]);
    expect(s.branchLabel).toBe("Next for MAIN-7");
    expect(s.fold).toBe(false);
  });

  it("an ended Parent with only its Retrospective open folds its main line", () => {
    const parent = { id: "k-1", key: "MAIN-1", title: "Saved cards", ended: true, acceptance: false, subtasks: [{ id: "k-14", key: "MAIN-14", title: "", kind: "retrospective" as const, state: "open" as const }] };
    const s = scopedLine(all, { kind: "parent", id: "k-1" }, { workflow: MAIN, parent });
    expect(s.drawn.map((t) => t.key)).toEqual(["MAIN-14"]);
    expect(s.branchLabel).toBe("After MAIN-1");
    expect(s.ghosts).toEqual([]);
    expect(s.fold).toBe(true);
  });
});

describe("one Task's path", () => {
  const ms = (h: number, m: number, s = 0) => new Date(2026, 9, 8, h, m, s).getTime();
  const iso = (h: number, m: number, s = 0) => new Date(ms(h, m, s)).toISOString();
  const entry = (seq: number, kind: Activity["kind"], payload: Record<string, unknown>, at: string): Activity => ({ seq, kind, at, subject_type: "task", subject_id: "k-9", payload });
  const claim = (holder: string, from: string, to?: string): Claim => ({ id: holder, task_id: "k-9", holder_id: holder, session_id: "s", started_at: from, ...(to ? { ended_at: to } : {}) });

  it("MAIN-9: Build waited 22m and worked 8m, along pass to QA, waited 7m there; pass and fail next", () => {
    const trace = traceOf(
      { id: "k-9", state: "open", step_id: "qa", step_since: iso(10, 29, 30) },
      [entry(1, "task.filed", { step_id: "build" }, iso(9, 58, 30)), entry(2, "task.advanced", { from: "build", to: "qa", outcome: "pass" }, iso(10, 29, 30))],
      [claim("m-bu", iso(10, 21, 20), iso(10, 29, 30)), claim("m-qa", iso(10, 36, 50))],
      MAIN,
      (id) => ({ name: id === "m-bu" ? "builder" : "qa", kind: "agent" }),
      ms(10, 42, 5),
    );
    expect(trace.stays.map((s) => [s.stepId, Math.round(s.waited / 60_000), Math.round(s.worked / 60_000), s.holder?.name])).toEqual([
      ["build", 23, 8, "builder"],
      ["qa", 7, 5, "qa"],
    ]);
    expect(trace.traversed).toEqual(["build:pass"]);
    expect(trace.next).toEqual(["qa:pass", "qa:fail"]);
    expect(trace.current).toBe("qa");
  });
});

describe("a Project of several Workflows", () => {
  const skillName = new Map(workflowsSkills.map((s) => [s.id, s.name]));
  // The five-Workflow record as the line takes it: Skills by name, a Connector into Done with `to` null.
  const line = (record = workflowsFixture()): LineWorkflow => ({
    workflows: record.workflows,
    steps: record.steps.map((s) => ({ id: s.id, workflow_id: s.workflow_id, name: s.name, position: s.position, ...(s.skill_id ? { skill: { name: skillName.get(s.skill_id)! } } : {}) })),
    connectors: record.connectors.map((c) => ({ id: c.id, from: c.from_step_id, to: c.to_step_id ?? null, name: c.name, position: c.position })),
  });
  // Bugs first, Triage second: the Workflows' positions swapped, the Steps re-sorted as the server returns them.
  const bugsFirst = (): LineWorkflow => {
    const wf = line();
    const position = (id: string) => (id === "wf-bugs" ? 1 : id === "wf-triage" ? 2 : wf.workflows.find((w) => w.id === id)!.position);
    const workflows = wf.workflows.map((w) => ({ ...w, position: position(w.id) })).sort((a, b) => a.position - b.position);
    const steps = [...wf.steps].sort((a, b) => position(a.workflow_id) - position(b.workflow_id) || a.position - b.position);
    return { ...wf, workflows, steps };
  };

  it("starts a filed Task at the first work Step in the Project's order: Triage, then Investigate once Bugs comes first", () => {
    expect(startStep(line())).toBe("st-triage");
    expect(startStep(bugsFirst())).toBe("st-investigate");
  });

  it("reads the Project's order from the Workflows' positions, whatever order the Steps arrive in", () => {
    const wf = bugsFirst();
    expect(startStep({ ...wf, steps: [...wf.steps].reverse() })).toBe("st-investigate");
  });

  it("lists one Workflow's Steps in its order", () => {
    expect(stepsOf(line(), "wf-bugs").map((s) => s.name)).toEqual(["Investigate", "Fix", "Review", "Verify"]);
    expect(stepsOf(line(), "wf-support").map((s) => s.name)).toEqual(["Support", "Awaiting customer", "Ops", "Approve"]);
    expect(stepsOf({ ...line(), steps: [...line().steps].reverse() }, "wf-features").map((s) => s.name)).toEqual(["Build", "Code review", "QA", "Release"]);
    expect(stepsOf(line(), "wf-none")).toEqual([]);
  });
});
