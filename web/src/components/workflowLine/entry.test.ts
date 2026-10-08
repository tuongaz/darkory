import { describe, expect, it } from "vitest";
import { BIG, MAIN } from "./fixtures";
import { crossings, handRoute, horizontal, lineTopology } from "./layout";
import { DONE_STATION, sideSteps, startStep, type LineWorkflow } from "./model";
import { ENTRY_LABEL, FILES_LABEL, filesHint, HAND_LABEL, handHint, holdHint } from "./words";

/*
 * The rule of the line where Tasks enter it: no line without words, and nothing looks like a flow
 * unless a Task really moves along it.
 */

describe("where Tasks enter the line (MAIN)", () => {
  const t = lineTopology(MAIN);
  const h = horizontal(t, { width: 1198, column: 102, holdColumn: () => 72 });
  const build = h.at.get("build")!;

  it("draws the entry arrow from the left into the start Step, with its words", () => {
    const arrow = h.entry?.arrow;
    expect(arrow?.label.text).toBe(ENTRY_LABEL);
    expect(arrow?.label.hint).toBe("New Tasks start at Build, unless the filer names another Step");
    const [a, b] = arrow!.line;
    expect([a[1], b[1]]).toEqual([h.lineY, h.lineY]);
    expect(b[0]).toBeLessThan(build.x);
    expect(b[0]).toBeGreaterThan(build.x - 20);
    expect(h.entry?.mark).toBeUndefined();
  });

  it("puts Plan on the branch Break down above the entry, its arrow files Subtasks dropping into it", () => {
    const before = h.entry!.before!;
    expect(before.id).toBe("plan");
    expect(before.station.y).toBeLessThan(h.lineY);
    expect(before.station.x).toBeLessThan(build.x - 80);
    const files = before.files!;
    expect(files.label.text).toBe(FILES_LABEL);
    const end = files.line.at(-1)!;
    const [from, to] = [h.entry!.arrow!.line[0][0], h.entry!.arrow!.line[1][0]];
    expect(end[0]).toBeGreaterThan(from);
    expect(end[0]).toBeLessThan(to);
    expect(files.head.dir).toBe("down");
    expect(h.hints.get("files")).toBe(filesHint("Plan", "Build"));
  });

  it("names Plan's outcome into Done in words beside it, saying where its Subtasks start", () => {
    const chip = h.chips.find((c) => c.stepId === "plan")!;
    expect(chip.text).toBe("done → Done");
    expect(chip.x).toBeLessThan(h.entry!.before!.station.x);
    expect(chip.hint).toBe("Plan's Breakdown Subtask ends Done when its holder says done; the Subtasks it filed start at Build");
  });

  it("parks Backlog below the entry, its spine rising into it by hand", () => {
    const [hold] = h.entry!.holds;
    expect(hold.id).toBe("backlog");
    expect(hold.y).toBeGreaterThan(h.lineY);
    expect(h.entry!.spine!.label.text).toBe(HAND_LABEL);
    expect(h.entry!.spine!.head).toMatchObject({ dir: "up" });
    expect(h.hints.get("holds")).toBe(holdHint("Backlog"));
    // Its tokens' column is room the drawing keeps.
    expect(h.height).toBeGreaterThan(hold.y + 72);
  });

  it("keeps Backlog and Plan where a move by hand or a chip's route can find them", () => {
    expect(handRoute(h, "backlog", "qa")).toMatch(/^M/);
    expect(h.routes.get("plan:done")).toMatch(/^M/);
  });

  it("gives every drawn line words, and every segment a label", () => {
    for (const p of h.polylines) if (p.id !== "main") expect(h.hints.get(p.id), p.id).toBeTruthy();
    for (const s of t.segments) expect(h.hints.get(`seg:${s.from}`)).toBeTruthy();
    expect(h.segmentLabels.map((l) => l.text)).toEqual(["pass", "pass", "pass"]);
    for (const c of h.chips) expect(c.hint, c.text).toBeTruthy();
    for (const a of [...h.arcs, ...(h.branch?.loops ?? [])]) for (const l of a.labels) expect(l.hint, l.text).toBeTruthy();
    expect(h.hints.get("seg:build")).toBe("Build → QA: when the holder says pass");
    expect(h.hints.get("seg:review")).toBe("Review → Done: when the holder says pass, and the Task is complete");
  });

  it("crosses nothing with the entry drawn, at every width", () => {
    for (const width of [640, 800, 1000, 1198, 1600]) {
      const at = horizontal(t, { width, column: 30, holdColumn: () => 36 });
      expect(crossings(at.polylines), String(width)).toEqual([]);
      expect(at.at.get("build")!.x).toBeGreaterThan(at.entry!.before!.station.x);
    }
  });
});

describe("where a filed Task starts (the server's defaultStep)", () => {
  const step = (id: string, skill?: string) => ({ id, name: id, position: 0, ...(skill ? { skill: { name: skill } } : {}) });
  const wf = (...steps: ReturnType<typeof step>[]): LineWorkflow => ({ steps: steps.map((s, i) => ({ ...s, position: i + 1 })), connectors: [] });

  it("is the first Step for the Project's own work", () => {
    expect(startStep(MAIN)).toBe("build");
    expect(startStep(BIG)).toBe("triage");
  });

  it("is the first Step with any Skill when every Skill is builtin", () => {
    expect(startStep(wf(step("hold"), step("plan", "breakdown"), step("acc", "acceptance")))).toBe("plan");
  });

  it("is the first Step when none carries a Skill, and none with no Steps", () => {
    expect(startStep(wf(step("a"), step("b")))).toBe("a");
    expect(startStep(wf())).toBeUndefined();
  });

  it("goes by position, not by the order the Steps come in", () => {
    expect(
      startStep({
        steps: [
          { id: "z", name: "z", position: 2, skill: { name: "x" } },
          { id: "y", name: "y", position: 1, skill: { name: "y" } },
        ],
        connectors: [],
      }),
    ).toBe("y");
  });
});

describe("which Steps leave the main line", () => {
  const s = (id: string, position: number, skill?: string) => ({ id, name: id, position, ...(skill ? { skill: { name: skill } } : {}) });
  const c = (from: string, to: string | null, name = "pass") => ({ id: `${from}>${to}:${name}`, from, to, name, position: 1 });

  it("never takes the start Step off, even a breakdown Step or a hold", () => {
    expect(sideSteps({ steps: [s("plan", 1, "breakdown")], connectors: [] }).before.size).toBe(0);
    const t = lineTopology({ steps: [s("a", 1), s("b", 2)], connectors: [] });
    expect(t.start).toBe("a");
    expect(t.main).toEqual(["a", DONE_STATION]);
    expect(t.holds).toEqual(["b"]);
  });

  it("keeps a breakdown Step a main-line Step leads into on the line", () => {
    const t = lineTopology({ steps: [s("triage", 1, "triage"), s("plan", 2, "breakdown"), s("build", 3, "engineer")], connectors: [c("triage", "plan"), c("plan", "build")] });
    expect(t.before).toBeUndefined();
    expect(t.main).toEqual(["triage", "plan", "build", DONE_STATION]);
  });

  it("takes off only the first breakdown Step: Darkory files every Breakdown there", () => {
    const sides = sideSteps({ steps: [s("p1", 1, "breakdown"), s("build", 2, "engineer"), s("p2", 3, "breakdown")], connectors: [] });
    expect([...sides.before]).toEqual(["p1"]);
  });

  it("parks a hold with no Connector, and keeps one joined by a Connector on the line, its dotted segments saying by hand", () => {
    const wf: LineWorkflow = { steps: [s("parked", 1), s("build", 2, "engineer"), s("wait", 3), s("ship", 4, "release")], connectors: [c("build", "wait"), c("ship", null)] };
    const t = lineTopology(wf);
    expect(t.holds).toEqual(["parked"]);
    expect(t.main).toEqual(["build", "wait", "ship", DONE_STATION]);
    const h = horizontal(t, { width: 1000, column: 30 });
    expect(h.main.find((m) => m.from === "wait")?.dotted).toBe(true);
    expect(h.segmentLabels.map((l) => l.text)).toEqual(["pass", HAND_LABEL, "pass"]);
    expect(h.hints.get("seg:wait")).toBe(handHint("wait", "ship"));
    expect(crossings(h.polylines)).toEqual([]);
  });

  it("keeps Acceptance off the line when only the breakdown Step leads into it", () => {
    const t = lineTopology({ steps: [s("plan", 1, "breakdown"), s("build", 2, "engineer"), s("acc", 3, "acceptance")], connectors: [c("plan", "acc"), c("build", null), c("acc", null)] });
    expect(t.before).toBe("plan");
    expect(t.rows.map((r) => r.stations)).toEqual([["acc"]]);
    expect(t.chips.map((x) => `${x.stepId}: ${x.text}`)).toEqual(["plan: pass → acc"]);
  });
});

describe("a start Step that is not the line's first", () => {
  it("is marked over its head where no arrow can reach it; a Backlog joined by a Connector stays on the line (BIG)", () => {
    const t = lineTopology(BIG);
    expect(t.main[0]).toBe("backlog");
    const h = horizontal(t, { width: 1198, column: 36 });
    expect(h.entry?.arrow).toBeUndefined();
    expect(h.entry?.mark).toMatchObject({ x: h.at.get("triage")!.x, hint: "New Tasks start at Triage, unless the filer names another Step" });
    // Over the name (a bead head sets its name at the foot of 30px), under every arc over the line.
    expect(h.entry!.mark!.y).toBeLessThanOrEqual(h.headY);
    for (const a of h.arcs.filter((x) => x.side === "over")) expect(Math.min(...a.line.map((p) => p[1]))).toBeLessThan(h.entry!.mark!.y - 12);
    expect(crossings(h.polylines)).toEqual([]);
  });

  it("says where the breakdown Step's Subtasks start in words, and sends parked holds into the line's first Step by hand", () => {
    const s = (id: string, position: number, skill?: string) => ({ id, name: id, position, ...(skill ? { skill: { name: skill } } : {}) });
    const t = lineTopology({
      steps: [s("parked", 1), s("intake", 2), s("plan", 3, "breakdown"), s("build", 4, "engineer")],
      connectors: [{ id: "k", from: "intake", to: "build", name: "ready", position: 1 }],
    });
    expect(t.main).toEqual(["intake", "build", DONE_STATION]);
    const h = horizontal(t, { width: 1000, column: 30 });
    expect(h.entry?.mark?.x).toBe(h.at.get("build")!.x);
    expect(h.entry?.before?.files).toBeUndefined();
    expect(h.chips.filter((c) => c.stepId === "plan").map((c) => c.text)).toEqual(["files Subtasks → build"]);
    expect(h.entry?.spine?.head.dir).toBe("right");
    expect(h.entry?.spine?.label.text).toBe(HAND_LABEL);
    expect(crossings(h.polylines)).toEqual([]);
  });
});
