import { describe, expect, it } from "vitest";
import type { Activity, ActivityKind, RunnerSession } from "@/api/client";
import { sampleWorkflow } from "@/components/workflow/samples";
import { FIVE } from "@/components/workflowLine/fixtures";
import { handRoute, horizontal, leaveRoute, lineTopology } from "@/components/workflowLine/layout";
import { task, wfId, wfStep } from "@/test/fixtures";
import { chipsAt } from "./bind";
import { effectOf, lineText, storyVerb, trailLine, type FlowContext } from "./flowEvents";
import { ARRIVE_MS, CALLOUT_MS, flowState, GLOW_MS, nextChange, TRAVEL_MS, type Active } from "./useLiveFlow";

const members = new Map([
  ["m-builder", { id: "m-builder", name: "builder", kind: "agent" as const }],
  ["m-qa", { id: "m-qa", name: "qa", kind: "agent" as const }],
  ["m-ada", { id: "m-ada", name: "ada", kind: "human" as const }],
]);
const tasks = new Map([
  ["k-7", { key: "MAIN-7", step_id: "s-build", project_id: "p-main" }],
  ["k-3", { key: "MAIN-3", step_id: undefined, project_id: "p-main" }],
  ["k-9", { key: "OPS-9", step_id: "s-other", project_id: "p-ops" }],
]);
const ctx: FlowContext = {
  projectId: "p-main",
  workflow: sampleWorkflow,
  task: (id) => tasks.get(id),
  member: (id) => members.get(id),
};

let seq = 100;
const entry = (kind: ActivityKind, payload: Record<string, unknown> = {}, actor: string | null = "m-builder", subject = "k-7"): Activity => ({
  seq: ++seq,
  at: "2026-10-08T09:30:00Z",
  kind,
  subject_type: "task",
  subject_id: subject,
  actor_id: actor ?? undefined,
  payload,
});

describe("the Tasks at each Step, as chips", () => {
  const claim = (holder: string) => ({ id: `c-${holder}`, task_id: "", holder_id: holder, session_id: "s", started_at: "2026-10-08T09:00:00Z" });
  const now = Date.parse("2026-10-08T10:00:00Z");
  const list = [
    task(1, { step_id: "st-build", title: "Store names" }),
    task(2, { step_id: "st-build", claim: claim("m-builder") }),
    task(3, { step_id: undefined, title: "Checkout" }), // a Parent: at no Step
    task(4, { step_id: "st-build", parent_id: "k-3" }),
    task(5, { step_id: "st-review", claim: claim("m-ada") }),
    task(6, { step_id: "st-build", state: "done" }),
    task(7, { step_id: "st-build", claim: { ...claim("m-qa"), ended_at: "2026-10-08T09:30:00Z" } }),
  ];
  const sessions: RunnerSession[] = [
    { task_id: "k-2", member_id: "m-builder", session_id: "s", host: "h", tmux: "t", started_at: "2026-10-08T09:00:00Z", state: "stalled", state_since: "2026-10-08T09:00:00Z", log_path: "/l" },
  ];
  const at = chipsAt(list, sessions, (id) => members.get(id), now);

  it("puts each open Task at its Step, held ones first, and a Parent nowhere", () => {
    expect(at.get("st-build")!.map((c) => c.key)).toEqual(["WEB-2", "WEB-1", "WEB-4", "WEB-7"]);
    expect(at.get("st-review")!.map((c) => c.key)).toEqual(["WEB-5"]);
    expect([...at.values()].flat().some((c) => c.key === "WEB-3" || c.key === "WEB-6")).toBe(false);
  });

  it("marks the holder by how they work there, a Subtask by its Parent, an ended Claim as waiting", () => {
    const build = at.get("st-build")!;
    expect(build[0].holder).toEqual({ id: "m-builder", name: "builder", kind: "agent", working: "stalled" });
    expect(at.get("st-review")![0].holder).toMatchObject({ name: "ada", working: "held" });
    expect(build.find((c) => c.key === "WEB-4")!.parentKey).toBe("WEB-3");
    expect(build.find((c) => c.key === "WEB-7")!.holder).toBeUndefined();
  });
});

describe("what the canvas makes of an entry", () => {
  it("calls out a pickup above the Step, in the holder's colour, and pulses the chip", () => {
    const e = effectOf(entry("task.claimed", { step_id: "s-build" }), ctx)!;
    expect(e.callout).toEqual({ stepId: "s-build", tone: "agent", who: members.get("m-builder"), text: "builder picked up MAIN-7" });
    expect(e.pulse).toEqual({ stepId: "s-build", tone: "agent" });
    expect(e.travel).toBeUndefined();
    expect(effectOf(entry("task.claimed", { step_id: "s-build" }, "m-ada"), ctx)!.callout!.tone).toBe("human");
  });

  it("says a let-go, a lapse in amber and a take-back, at the Step the Task stays at", () => {
    expect(effectOf(entry("task.released", { claim_id: "c" }), ctx)!.callout).toMatchObject({ stepId: "s-build", tone: "neutral", text: "builder let go of MAIN-7" });
    const lapsed = effectOf(entry("task.lapsed", { holder_id: "m-builder", claim_id: "c" }, null), ctx)!;
    expect(lapsed.callout).toMatchObject({ stepId: "s-build", tone: "lapsed", text: "MAIN-7's Claim lapsed", who: { name: "builder" } });
    expect(effectOf(entry("task.taken_back", { holder_id: "m-builder" }, "m-ada"), ctx)!.callout).toMatchObject({ tone: "back", text: "ada took MAIN-7 back" });
  });

  it("sends a token along the Connector a Task advanced along, back ones too", () => {
    expect(effectOf(entry("task.advanced", { from: "s-build", to: "s-qa", outcome: "pass" }), ctx)!.travel).toEqual({ from: "s-build", to: "s-qa", connectorId: "c-build-qa" });
    expect(effectOf(entry("task.advanced", { from: "s-qa", to: "s-build", outcome: "fail" }, "m-qa"), ctx)!.travel).toEqual({ from: "s-qa", to: "s-build", connectorId: "c-qa-build" });
  });

  it("sends a completed Task into Done along its Connector, a dropped one into Dropped; a Parent completing travels nowhere", () => {
    expect(effectOf(entry("task.completed", { from: "s-review", outcome: "pass" }), ctx)!.travel).toEqual({ from: "s-review", to: "done", connectorId: "c-review-done" });
    expect(effectOf(entry("task.dropped", { from: "s-build" }, "m-ada"), ctx)!.travel).toEqual({ from: "s-build", to: "dropped" });
    expect(effectOf(entry("task.completed", {}, "m-ada", "k-3"), ctx)).toBeNull();
  });

  it("moves a Task moved by hand along a way of its own", () => {
    expect(effectOf(entry("task.moved", { from: "s-backlog", to: "s-build" }, "m-ada"), ctx)!.travel).toEqual({ from: "s-backlog", to: "s-build", connectorId: undefined });
  });

  it("fades a filed Task's chip in at its Step with a callout, Darkory's filing unsigned", () => {
    const filed = effectOf(entry("task.filed", { key: "MAIN-12", project_id: "p-main", step_id: "s-backlog" }, "m-ada", "k-12"), ctx)!;
    expect(filed).toMatchObject({ key: "MAIN-12", arrive: "s-backlog", callout: { stepId: "s-backlog", tone: "filed", text: "ada filed MAIN-12" } });
    const own = effectOf(entry("task.filed", { key: "MAIN-13", project_id: "p-main", step_id: "s-acceptance" }, null, "k-13"), ctx)!;
    expect(own.callout).toMatchObject({ who: undefined, text: "MAIN-13 filed" });
  });

  it("shows nothing for another Project's Task, or an entry that is not a move", () => {
    expect(effectOf(entry("task.claimed", { step_id: "s-other" }, "m-builder", "k-9"), ctx)).toBeNull();
    expect(effectOf(entry("task.filed", { key: "OPS-10", project_id: "p-ops", step_id: "s-x" }, "m-ada", "k-10"), ctx)).toBeNull();
    expect(effectOf(entry("task.note_added", { note_id: "n" }), ctx)).toBeNull();
  });

  it("knows a Task claimed before its record is read by the Step it names", () => {
    const e = effectOf(entry("task.claimed", { step_id: "s-qa" }, "m-qa", "k-new"), ctx)!;
    expect(e.callout!.stepId).toBe("s-qa");
  });
});

describe("the trail's words", () => {
  const say = (e: Activity) => lineText(trailLine(e, ctx)!);

  it("says each move in the glossary's voice", () => {
    expect(say(entry("task.claimed", { step_id: "s-build" }))).toBe("builder picked up MAIN-7 at Build");
    expect(say(entry("task.advanced", { from: "s-build", to: "s-qa", outcome: "pass" }))).toBe("builder advanced MAIN-7 along pass to QA");
    expect(say(entry("task.advanced", { from: "s-qa", to: "s-build", outcome: "fail" }, "m-qa"))).toBe("qa sent MAIN-7 back along fail to Build");
    expect(say(entry("task.completed", {}, "m-ada", "k-3"))).toBe("MAIN-3 completed");
    expect(say(entry("task.completed", { from: "s-review", outcome: "pass" }))).toBe("builder completed MAIN-7 along pass · from Review");
    expect(say(entry("task.released", {}))).toBe("builder let go of MAIN-7 at Build");
    expect(say(entry("task.lapsed", { holder_id: "m-builder" }, null))).toBe("MAIN-7's Claim lapsed at Build · held by builder");
    expect(say(entry("task.taken_back", { holder_id: "m-builder" }, "m-ada"))).toBe("ada took MAIN-7 back from builder at Build");
    expect(say(entry("task.moved", { from: "s-backlog", to: "s-build" }, "m-ada"))).toBe("ada moved MAIN-7 from Backlog to Build");
    expect(say(entry("task.filed", { key: "MAIN-12", project_id: "p-main", step_id: "s-backlog" }, null, "k-12"))).toBe("Darkory filed MAIN-12 at Backlog");
    expect(say(entry("task.dropped", { from: "s-build" }, "m-ada"))).toBe("ada dropped MAIN-7 · from Build");
  });

  it("names the Steps a row lights, and leads with the actor's mark, none for Darkory", () => {
    const l = trailLine(entry("task.advanced", { from: "s-build", to: "s-qa", outcome: "pass" }), ctx)!;
    expect(l.steps).toEqual(["s-build", "s-qa"]);
    expect(l.who).toEqual(members.get("m-builder"));
    expect(trailLine(entry("task.lapsed", { holder_id: "m-builder" }, null), ctx)!.who).toBeUndefined();
    expect(trailLine(entry("task.note_added"), ctx)).toBeNull();
  });
});

describe("the canvas over time", () => {
  const claimed = effectOf(entry("task.claimed", { step_id: "s-build" }), ctx)!;
  const advanced = effectOf(entry("task.advanced", { from: "s-build", to: "s-qa", outcome: "pass" }), ctx)!;
  const filed = effectOf(entry("task.filed", { key: "MAIN-12", project_id: "p-main", step_id: "s-backlog" }, "m-ada", "k-12"), ctx)!;

  it("pulses a picked-up chip and its callout for a few seconds, the Step's outline for less", () => {
    const active: Active[] = [{ effect: claimed, at: 0 }];
    expect(flowState(active, 100, false)).toMatchObject({ pulses: new Map([["k-7", "agent"]]), glows: new Map([["s-build", "agent"]]) });
    expect(flowState(active, 100, false).callouts.get("s-build")!.map((c) => c.text)).toEqual(["builder picked up MAIN-7"]);
    expect(flowState(active, GLOW_MS + 1, false).glows.size).toBe(0);
    expect(flowState(active, GLOW_MS + 1, false).pulses.size).toBe(1);
    expect(flowState(active, CALLOUT_MS + 1, false).callouts.size).toBe(0);
    expect(flowState(active, CALLOUT_MS + 1, false).pulses.size).toBe(0);
  });

  it("carries an advanced Task as a token, its chip nowhere and its Connector lit, then highlights it at its new Step", () => {
    const active: Active[] = [{ effect: advanced, at: 0 }];
    const moving = flowState(active, 500, false);
    expect(moving.tokens).toEqual([{ id: advanced.seq, key: "MAIN-7", travel: { from: "s-build", to: "s-qa", connectorId: "c-build-qa" } }]);
    expect([...moving.transit]).toEqual(["k-7"]);
    expect([...moving.lit]).toEqual(["c-build-qa"]);
    const landed = flowState(active, TRAVEL_MS + 1, false);
    expect(landed.tokens).toEqual([]);
    expect(landed.transit.size).toBe(0);
    expect([...landed.arrived]).toEqual(["k-7"]);
    expect(flowState(active, TRAVEL_MS + ARRIVE_MS + 1, false).arrived.size).toBe(0);
  });

  it("with reduced motion, sends no token: the chip simply appears where it went", () => {
    const s = flowState([{ effect: advanced, at: 0 }], 500, true);
    expect(s.tokens).toEqual([]);
    expect(s.transit.size).toBe(0);
    expect([...s.arrived]).toEqual(["k-7"]);
  });

  it("fades a filed chip in, and stacks a Step's callouts newest on top, three at most", () => {
    expect([...flowState([{ effect: filed, at: 0 }], 10, false).arrived]).toEqual(["k-12"]);
    const many: Active[] = [0, 1, 2, 3].map((i) => ({ effect: { ...claimed, seq: 500 + i, callout: { ...claimed.callout!, text: `moment ${i}` } }, at: i * 10 }));
    expect(flowState(many, 50, false).callouts.get("s-build")!.map((c) => c.text)).toEqual(["moment 3", "moment 2", "moment 1"]);
  });

  it("knows when it next changes", () => {
    const active: Active[] = [{ effect: advanced, at: 1000 }];
    expect(nextChange(active, 1000)).toBe(1000 + TRAVEL_MS);
    expect(nextChange(active, 1000 + TRAVEL_MS)).toBe(1000 + TRAVEL_MS + ARRIVE_MS);
    expect(nextChange(active, 1000 + TRAVEL_MS + ARRIVE_MS)).toBeUndefined();
  });
});

describe("a Task crossing between Workflows, on the line of one (ADR 0019)", () => {
  // The five Workflows' graph, as the line has it; the Triage line draws Triage's one Step.
  const five = FIVE();
  const stepsOf = (id: string) => new Set(five.steps.filter((s) => s.workflow_id === id).map((s) => s.id));
  const on = (workflow: string): FlowContext => ({
    projectId: "p-web",
    workflow: five,
    drawn: stepsOf(workflow),
    task: () => ({ key: "WEB-2", project_id: "p-web" }),
    member: (id) => members.get(id),
  });
  const bug = five.connectors.find((c) => c.from === wfStep.triage && c.name === "bug")!;
  const advance = entry("task.advanced", { from: wfStep.triage, to: wfStep.investigate, outcome: "bug" }, "m-builder", "k-2");

  it("leaves Triage's line along its exit: the token travels the bug Connector and is gone from the line", () => {
    const e = effectOf(advance, on(wfId.triage))!;
    expect(e.travel).toEqual({ from: wfStep.triage, to: wfStep.investigate, connectorId: bug.id });
    const moving = flowState([{ effect: e, at: 0 }], 500, false);
    expect([...moving.transit]).toEqual(["k-2"]);
    expect([...moving.lit]).toEqual([bug.id]);
    // The route it travels is the exit's: down Triage's leg into its chip.
    const h = horizontal(lineTopology(FIVE(wfId.triage)), { width: 1160, column: 66 });
    const x = h.at.get(wfStep.triage)!.x;
    expect(h.routes.get(bug.id)).toMatch(new RegExp(`^M${x} ${h.lineY} V[\\d.]+ H[\\d.]+$`));
    expect(h.exits.map((l) => l.connectorId)).toContain(bug.id);
  });

  it("arrives on Bugs' line along its entry, the arrow into Investigate", () => {
    const e = effectOf(advance, on(wfId.bugs))!;
    expect(e.travel).toEqual({ from: wfStep.triage, to: wfStep.investigate, connectorId: bug.id });
    const h = horizontal(lineTopology(FIVE(wfId.bugs)), { width: 1160, column: 66 });
    expect(h.entry?.arrow?.connectorIds).toEqual([bug.id]);
    expect(h.routes.get(bug.id)).toBe(`M${h.entry!.arrow!.line[0][0]} ${h.lineY} H${h.at.get(wfStep.investigate)!.x}`);
  });

  it("moved by hand into another Workflow's Step it leaves too, straight down off the line; moved in from one, it appears", () => {
    const out = effectOf(entry("task.moved", { from: wfStep.triage, to: wfStep.support }, "m-ada", "k-2"), on(wfId.triage))!;
    expect(out.travel).toEqual({ from: wfStep.triage, to: wfStep.support, connectorId: undefined });
    const h = horizontal(lineTopology(FIVE(wfId.triage)), { width: 1160, column: 66 });
    const at = h.at.get(wfStep.triage)!;
    expect(handRoute(h, wfStep.triage, wfStep.support)).toBeUndefined();
    expect(leaveRoute(h, wfStep.triage)).toBe(`M${at.x} ${at.y} V${at.y + 30}`);
    const into = effectOf(entry("task.moved", { from: wfStep.investigate, to: wfStep.support }, "m-ada", "k-2"), on(wfId.support))!;
    expect(into.travel).toBeUndefined();
    expect(into.arrive).toBe(wfStep.support);
  });

  it("plays nothing of another Workflow's Steps: a pickup at Fix is not on Triage's line", () => {
    expect(effectOf(entry("task.claimed", { step_id: wfStep.fix }, "m-builder", "k-2"), on(wfId.triage))).toBeNull();
    expect(effectOf(entry("task.advanced", { from: wfStep.investigate, to: wfStep.fix, outcome: "fix" }, "m-builder", "k-2"), on(wfId.triage))).toBeNull();
    expect(effectOf(entry("task.claimed", { step_id: wfStep.fix }, "m-builder", "k-2"), on(wfId.bugs))?.callout?.stepId).toBe(wfStep.fix);
  });

  it("reads a crossing into another Workflow as an advance, whichever comes first; only a Connector back within one Workflow sends a Task back", () => {
    const words = (from: string, to: string, outcome: string) => lineText(trailLine(entry("task.advanced", { from, to, outcome }, "m-builder", "k-2"), on(wfId.triage))!);
    const verb = (from: string, to: string, outcome: string) => storyVerb(entry("task.advanced", { from, to, outcome }, "m-builder", "k-2"), on(wfId.triage));
    expect(words(wfStep.triage, wfStep.investigate, "bug")).toBe("builder advanced WEB-2 along bug to Investigate");
    // Support is the Project's last Workflow, Bugs its second: the crossing is still an advance.
    expect(words(wfStep.support, wfStep.investigate, "bug")).toBe("builder advanced WEB-2 along bug to Investigate");
    expect(verb(wfStep.support, wfStep.investigate, "bug")).toBe("builder advanced along bug");
    expect(words(wfStep.review, wfStep.fix, "needs changes")).toBe("builder sent WEB-2 back along needs changes to Fix");
    expect(verb(wfStep.review, wfStep.fix, "needs changes")).toBe("builder sent back along needs changes");
    expect(words(wfStep.fix, wfStep.review, "ready")).toBe("builder advanced WEB-2 along ready to Review");
  });
});
