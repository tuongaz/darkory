import { describe, expect, it } from "vitest";
import { wfId, wfStep } from "@/test/fixtures";
import { BIG, DARK, DEFAULT, FIVE, MAIN, SACCA, SOFTWARE } from "./fixtures";
import { crossings, densityFor, horizontal, laneTracks, lineTopology, railOf, topologyCrossings, trackCrossings, tracks, type Arc, type Track } from "./layout";
import { DONE_STATION, type LineConnector, type LineWorkflow } from "./model";
import { overlaps } from "./place";

const arcNamed = (list: (Arc | Track)[], name: string) => list.find((e): e is Arc => e.kind === "arc" && e.connector.name === name);

describe("the line on MAIN, the default Workflow", () => {
  const t = lineTopology(MAIN);

  it("runs Build → QA → Review → Done; Plan sits on Break down, Backlog parks by the entry, Acceptance, Retro and Skill review after a Parent", () => {
    expect(t.main).toEqual(["build", "qa", "review", DONE_STATION]);
    expect(t.start).toBe("build");
    expect(t.before).toBe("plan");
    expect(t.holds).toEqual(["backlog"]);
    expect(t.rows.map((r) => r.stations)).toEqual([["acceptance"], ["retro", "skillreview"]]);
  });

  it("draws neighbours joined by a Connector solid and named: nothing on the main line is dotted now", () => {
    expect(t.segments.map((s) => s.connector?.name ?? "dotted")).toEqual(["pass", "pass", "pass"]);
  });

  it("sends the forward skip over: no UI change; Plan's done is words beside Plan, not an arc", () => {
    expect(t.over.map((a) => [a.connector.name, a.back, a.depth])).toEqual([["no UI change", false, 1]]);
  });

  it("nests the three loops under the line: fail and needs QA inside needs changes", () => {
    expect(t.under.map((e) => [(e as Arc).connector.name, e.depth])).toEqual([
      ["fail", 1],
      ["needs QA", 1],
      ["needs changes", 2],
    ]);
    // At Build both fail and needs changes land: the outer one's leg stands nearest the station.
    expect(arcNamed(t.under, "needs changes")!.legLo).toBe(0);
    expect(arcNamed(t.under, "fail")!.legLo).toBe(1);
  });

  it("keeps the branch's own routes: propose and publish along the row, needs changes under it, the rest as chips", () => {
    const [acc, retro] = t.rows;
    expect(acc.exit?.name).toBe("pass");
    expect(retro.segments.map((s) => s.connector.name)).toEqual(["propose"]);
    expect(retro.exit?.name).toBe("publish");
    expect(retro.loops.map((l) => l.connector.name)).toEqual(["needs changes"]);
    expect(t.chips.map((c) => `${c.stepId}: ${c.text}`)).toEqual(["plan: done → Done", "acceptance: fail → Build", "retro: done → Done"]);
  });

  it("crosses nothing, in station order and in pixels", () => {
    expect(topologyCrossings(t)).toBe(0);
    const h = horizontal(t, { width: 1198, column: 102 });
    expect(h.density).toBe("tokens");
    expect(crossings(h.polylines)).toEqual([]);
  });

  it("gives every Connector a route a token can travel", () => {
    const h = horizontal(t, { width: 1198, column: 102 });
    for (const c of MAIN.connectors) expect(h.routes.get(c.id), c.id).toMatch(/^M/);
  });

  it("stays uncrossed at a narrow width too", () => {
    for (const width of [640, 800, 1000, 1600]) {
      const h = horizontal(t, { width, column: 30 });
      expect(crossings(h.polylines), String(width)).toEqual([]);
    }
  });
});

describe("the line on BIG, 12 Steps and 7 loops", () => {
  const t = lineTopology(BIG);

  it("keeps all 12 Steps on the main line: Acceptance and Retro are reached along Connectors here", () => {
    expect(t.main).toEqual(["backlog", "triage", "plan", "design", "build", "creview", "qa", "sec", "docs", "acc", "release", "retro", DONE_STATION]);
    expect(t.rows).toEqual([]);
  });

  it("merges the five loops into Build on one return track", () => {
    const tracks = t.under.filter((e): e is Track => e.kind === "track");
    expect(tracks).toHaveLength(1);
    expect(tracks[0].target).toBe("build");
    expect(tracks[0].drops.map((d) => `${d.connector.from} ${d.connector.name}`)).toEqual([
      "creview needs changes",
      "qa fail",
      "sec fail",
      "docs needs changes",
      "acc fail",
    ]);
  });

  it("draws rework under, and sends rollback over the line because under it would cross the track", () => {
    expect(arcNamed(t.under, "rework")).toMatchObject({ side: "under", back: true });
    const rollback = t.over.find((a) => a.connector.name === "rollback");
    expect(rollback).toMatchObject({ side: "over", back: true });
    expect(t.over.find((a) => a.connector.name === "no design needed")).toMatchObject({ back: false });
  });

  it("lists all 7 loops", () => {
    expect(t.loops.map((l) => `${l.from} ↩ ${l.to} ${l.connector.name}`)).toEqual([
      "Design ↩ Plan rework",
      "Code review ↩ Build needs changes",
      "QA ↩ Build fail",
      "Security review ↩ Build fail",
      "Docs ↩ Build needs changes",
      "Acceptance ↩ Build fail",
      "Release ↩ QA rollback",
    ]);
  });

  it("turns tokens to beads: more than 9 Steps", () => {
    expect(densityFor(t, 1198)).toBe("beads");
    expect(densityFor(lineTopology(MAIN), 1198)).toBe("tokens");
    expect(densityFor(lineTopology(MAIN), 560)).toBe("beads");
  });

  it("crosses nothing, in station order and in pixels", () => {
    expect(topologyCrossings(t)).toBe(0);
    for (const width of [1198, 900, 1600]) {
      const h = horizontal(t, { width, column: 36 });
      expect(crossings(h.polylines), String(width)).toEqual([]);
    }
  });
});

describe("the rules on Workflows of other shapes", () => {
  const wf = (steps: string[], connectors: [string, string, string | null][]): LineWorkflow => ({
    workflows: [{ id: "work", name: "Work", position: 1 }],
    steps: steps.map((id, i) => ({ id, workflow_id: "work", name: id, position: i + 1, skill: { name: id } })),
    connectors: connectors.map(([from, name, to], i) => ({ id: `c${i}`, from, to, name, position: i + 1 })),
  });

  it("a Workflow with no Steps is just Done", () => {
    const t = lineTopology({ workflows: [], steps: [], connectors: [] });
    expect(t.main).toEqual([DONE_STATION]);
    const h = horizontal(t, { width: 600, column: 0 });
    expect(h.at.get(DONE_STATION)?.x).toBe(300);
  });

  it("two loops that would interleave under the line: one goes over", () => {
    const t = lineTopology(wf(["a", "b", "c", "d"], [["a", "p", "b"], ["b", "p", "c"], ["c", "p", "d"], ["c", "x", "a"], ["d", "y", "b"]]));
    expect(t.under).toHaveLength(1);
    expect(t.over).toHaveLength(1);
    expect(topologyCrossings(t)).toBe(0);
    expect(crossings(horizontal(t, { width: 900, column: 30 }).polylines)).toEqual([]);
  });

  it("a loop that straddles a drop of a track is not drawn under it", () => {
    const t = lineTopology(
      wf(["a", "b", "c", "d", "e", "f"], [["a", "p", "b"], ["b", "p", "c"], ["c", "p", "d"], ["d", "p", "e"], ["e", "p", "f"], ["c", "x1", "a"], ["d", "x2", "a"], ["f", "x3", "a"], ["e", "y", "c"]]),
    );
    expect(t.under.filter((e) => e.kind === "track")).toHaveLength(1);
    // e → c spans the drop at d: over the line.
    expect(t.over.map((a) => a.connector.name)).toEqual(["y"]);
    expect(crossings(horizontal(t, { width: 1000, column: 30 }).polylines)).toEqual([]);
  });

  it("two Connectors between the same neighbours: the second arcs over", () => {
    const t = lineTopology(wf(["a", "b"], [["a", "p", "b"], ["a", "q", "b"], ["b", "p", null]]));
    expect(t.segments[0].connector?.name).toBe("p");
    expect(t.over.map((a) => a.connector.name)).toEqual(["q"]);
  });

  it("a main Step leading into a branch Step keeps that Step on the main line", () => {
    const t = lineTopology({
      workflows: [{ id: "work", name: "Work", position: 1 }],
      steps: [
        { id: "build", workflow_id: "work", name: "Build", position: 1, skill: { name: "engineer" } },
        { id: "acc", workflow_id: "work", name: "Acceptance", position: 2, skill: { name: "acceptance" } },
        { id: "retro", workflow_id: "work", name: "Retro", position: 3, skill: { name: "retro" } },
      ],
      connectors: [
        { id: "1", from: "build", to: "acc", name: "pass", position: 1 },
        { id: "2", from: "acc", to: null, name: "pass", position: 1 },
        { id: "3", from: "retro", to: null, name: "done", position: 1 },
      ],
    });
    expect(t.main).toEqual(["build", "acc", DONE_STATION]);
    expect(t.rows.map((r) => r.stations)).toEqual([["retro"]]);
  });
});

describe("one Workflow of several drawn alone (ADR 0019): a Connector into another Workflow is an exit, one from another an entry", () => {
  const touching = (wf: LineWorkflow, drawn: string) => {
    const ids = new Set(wf.steps.filter((s) => s.workflow_id === drawn).map((s) => s.id));
    return wf.connectors.filter((c) => ids.has(c.from) || (c.to !== null && ids.has(c.to))).length;
  };
  const counted = (t: ReturnType<typeof lineTopology>) => t.connectors.size + t.exits.length + t.entries.length;

  it("drops no Connector of any of the five: drawn, exits and entries add up to those touching its Steps", () => {
    for (const [name, id] of Object.entries(wfId)) {
      const wf = FIVE(id);
      const t = lineTopology(wf);
      expect(counted(t), name).toBe(touching(wf, id));
      expect(touching(wf, id), name).toBeGreaterThan(0);
    }
  });

  it("Triage: its one Step on the line, where New Tasks start, and a chip for each of its four outcomes into another Workflow", () => {
    const wf = FIVE(wfId.triage);
    const t = lineTopology(wf);
    expect(t.main).toEqual([wfStep.triage, DONE_STATION]);
    expect(t.start).toBe(wfStep.triage);
    expect(t.exits.map((e) => [e.stepId, e.text])).toEqual([
      [wfStep.triage, "bug → Bugs › Investigate"],
      [wfStep.triage, "feature → Features › Build"],
      [wfStep.triage, "prototype → Prototypes › Sketch"],
      [wfStep.triage, "question → Support › Support"],
    ]);
    expect(t.exits[0].hint).toBe("Triage → Bugs › Investigate: when the holder says bug");
    expect(t.entries).toEqual([]);
    expect(counted(t)).toBe(touching(wf, wfId.triage));
  });

  it("Triage in pixels: each exit a chip at the end of a leg leaving Triage, clear of every word and line", () => {
    const t = lineTopology(FIVE(wfId.triage));
    for (const width of [744, 1000, 1160, 1640]) {
      const h = horizontal(t, { width, column: 66 });
      const chips = h.chips.filter((c) => c.stepId === wfStep.triage).map((c) => c.text);
      expect(chips, String(width)).toEqual(t.exits.map((e) => e.text));
      for (const e of t.exits) {
        const leg = h.polylines.find((p) => p.id === `exit:${e.connector.id}`);
        expect(leg, `${e.text} at ${width}`).toBeDefined();
        expect(leg!.points[0][0]).toBe(h.at.get(wfStep.triage)!.x);
        expect(h.routes.get(e.connector.id), e.text).toMatch(/^M/);
        expect(h.boxes.filter((b) => b.kind === "chip" && b.text === e.text)).toHaveLength(1);
      }
      expect(overlaps(h.boxes), String(width)).toEqual([]);
      expect(h.clashes, String(width)).toEqual([]);
      expect(crossings(h.polylines), String(width)).toEqual([]);
    }
  });

  it("Bugs: Investigate carries one entry from Triage; Bugs' own Connectors are drawn as they would be alone", () => {
    const wf = FIVE(wfId.bugs);
    const t = lineTopology(wf);
    expect(t.main).toEqual([wfStep.investigate, wfStep.fix, wfStep.review, wfStep.verify, DONE_STATION]);
    // New Tasks start at Triage, which this line does not draw.
    expect(t.start).toBeUndefined();
    expect(t.entries.map((e) => [e.stepId, e.text])).toEqual([[wfStep.investigate, "from Triage · bug"]]);
    expect(t.exits).toEqual([]);
    expect(t.segments.map((s) => s.connector?.name ?? "dotted")).toEqual(["fix", "ready", "pass", "pass"]);
    expect(t.loops.map((l) => `${l.from} ↩ ${l.to} ${l.connector.name}`)).toEqual(["Review ↩ Fix needs changes", "Verify ↩ Fix fail"]);
    expect(counted(t)).toBe(touching(wf, wfId.bugs));
  });

  it("Bugs in pixels: the entry is an arrow into Investigate from the left, its words where New Tasks' would be", () => {
    const t = lineTopology(FIVE(wfId.bugs));
    const h = horizontal(t, { width: 1160, column: 66 });
    const arrow = h.entry?.arrow;
    expect(arrow?.label.text).toBe("from Triage · bug");
    expect(arrow?.label.hint).toBe("Triage › Triage → Investigate: when the holder says bug");
    expect(arrow!.line.at(-1)![0]).toBeLessThan(h.at.get(wfStep.investigate)!.x);
    expect(h.entry?.mark).toBeUndefined();
    expect(h.entry?.before).toBeUndefined();
    expect(h.boxes.filter((b) => b.kind === "entry").map((b) => b.text)).toEqual(["from Triage · bug"]);
    expect(h.routes.get(t.entries[0].connector.id)).toMatch(/^M/);
    expect(overlaps(h.boxes)).toEqual([]);
    expect(crossings(h.polylines)).toEqual([]);
  });

  it("Support: an entry from Triage on Support, and its loops back (Ops' done into Support among them) drawn as they would be alone", () => {
    const wf = FIVE(wfId.support);
    const t = lineTopology(wf);
    expect(t.main).toEqual([wfStep.support, wfStep.awaitingCustomer, wfStep.ops, wfStep.approve, DONE_STATION]);
    expect(t.entries.map((e) => [e.stepId, e.text])).toEqual([[wfStep.support, "from Triage · question"]]);
    expect(t.exits).toEqual([]);
    expect(t.loops.map((l) => `${l.from} ↩ ${l.to} ${l.connector.name}`)).toEqual(["Ops ↩ Support done", "Approve ↩ Ops approved", "Approve ↩ Support declined"]);
    expect(counted(t)).toBe(touching(wf, wfId.support));
  });

  it("an entry into a Step after the line's first is a mark over its head, as New Tasks' is", () => {
    const wf: LineWorkflow = {
      workflows: [
        { id: "a", name: "Intake", position: 1 },
        { id: "b", name: "Work", position: 2 },
      ],
      steps: [
        { id: "in", workflow_id: "a", name: "Intake", position: 1, skill: { name: "triage" } },
        { id: "build", workflow_id: "b", name: "Build", position: 1, skill: { name: "engineer" } },
        { id: "qa", workflow_id: "b", name: "QA", position: 2, skill: { name: "qa" } },
      ],
      connectors: [
        { id: "1", from: "in", to: "qa", name: "test only", position: 1 },
        { id: "2", from: "build", to: "qa", name: "pass", position: 1 },
        { id: "3", from: "qa", to: null, name: "pass", position: 1 },
        { id: "4", from: "qa", to: "in", name: "misrouted", position: 2 },
      ],
      drawn: "b",
    };
    const t = lineTopology(wf);
    expect(t.entries.map((e) => [e.stepId, e.text])).toEqual([["qa", "from Intake · test only"]]);
    expect(t.exits.map((e) => [e.stepId, e.text])).toEqual([["qa", "misrouted → Intake › Intake"]]);
    const h = horizontal(t, { width: 1000, column: 30 });
    expect(h.entry?.arrow).toBeUndefined();
    const marks = h.entry?.arrivals ?? [];
    expect(marks.map((m) => [m.stepId, m.lines])).toEqual([["qa", ["from Intake · test only"]]]);
    expect(marks[0].x).toBe(h.at.get("qa")!.x);
    expect(h.boxes.filter((b) => b.kind === "mark").map((b) => b.text)).toEqual(["from Intake · test only"]);
    expect(overlaps(h.boxes)).toEqual([]);
    expect(h.clashes).toEqual([]);
    expect(crossings(h.polylines)).toEqual([]);
  });

  it("a Workflow with no crossing has no exits or entries, and draws as it did before a Project had several", () => {
    const alone = lineTopology({ ...MAIN, drawn: "work" });
    expect(alone.exits).toEqual([]);
    expect(alone.entries).toEqual([]);
    expect(alone).toEqual(lineTopology(MAIN));
    expect(horizontal(alone, { width: 1198, column: 102 })).toEqual(horizontal(lineTopology(MAIN), { width: 1198, column: 102 }));
  });

  it("ignores a Connector that touches no drawn Step: it belongs to another drawing", () => {
    const t = lineTopology(FIVE(wfId.prototypes));
    expect(t.entries.map((e) => e.text)).toEqual(["from Triage · prototype"]);
    expect([...t.connectors.values()].map((c) => c.name)).toEqual(["ready", "approved", "redesign"]);
  });
});

describe("the line down the page: returns as tracks in lanes beside the rail", () => {
  const named = (t: ReturnType<typeof lineTopology>, list: ReturnType<typeof tracks>) =>
    list.map((k) => [t.steps.get(k.target)?.name, k.connectors.map((c) => `${t.steps.get(c.from)?.name}:${c.name}`).sort(), k.lane]);

  it("starts the rail at the start Step; a Step before it stands beside the start (BIG's Backlog)", () => {
    expect(railOf(lineTopology(BIG))).toEqual({ lead: ["backlog"], rail: ["triage", "plan", "design", "build", "creview", "qa", "sec", "docs", "acc", "release", "retro", DONE_STATION] });
    expect(railOf(lineTopology(MAIN))).toEqual({ lead: [], rail: ["build", "qa", "review", DONE_STATION] });
  });

  it("draws one track per Step returned to: MAIN's two into Build share one, needs QA into QA another; the skip into Review its own", () => {
    const t = lineTopology(MAIN);
    expect(named(t, tracks(t)).map(([n, cs]) => [n, cs])).toEqual([
      ["Build", ["QA:fail", "Review:needs changes"]],
      ["QA", ["Review:needs QA"]],
      ["Review", ["Build:no UI change"]],
    ]);
  });

  it("merges the software Workflow's four into Build on one track", () => {
    const t = lineTopology(SOFTWARE);
    const build = tracks(t).find((k) => t.steps.get(k.target)?.name === "Build")!;
    const into = [...t.connectors.values()].filter((c) => c.to === build.target && !t.segments.some((s) => s.connector?.id === c.id));
    expect(into.filter((c) => t.main.indexOf(c.from) > t.main.indexOf(build.target)).length).toBe(4);
    expect(build.connectors.map((c) => c.id).sort()).toEqual(into.map((c) => c.id).sort());
  });

  it("lays BIG's three tracks with one crossing: rework inside, Build's long track next, rollback into QA outside it", () => {
    const t = lineTopology(BIG);
    const list = tracks(t);
    expect(named(t, list).map(([n, , lane]) => [n, lane])).toEqual([
      ["Plan", 0],
      ["Build", 1],
      ["QA", 2],
    ]);
    expect(trackCrossings(list)).toBe(1);
  });

  it("crosses nothing on MAIN, the default, the Sacca Workflow and Bug triage's shared track", () => {
    for (const wf of [MAIN, DEFAULT, SACCA, DARK("bugs")]) expect(trackCrossings(tracks(lineTopology(wf)))).toBe(0);
    // Bug triage's two returns into Fix are the one track.
    expect(tracks(lineTopology(DARK("bugs"))).map((k) => k.connectors.length)).toEqual([2]);
  });

  it("never carries a Connector into Done, nor one the rail carries", () => {
    for (const wf of [MAIN, BIG, SOFTWARE, SACCA]) {
      const t = lineTopology(wf);
      const along = new Set(t.segments.map((s) => s.connector?.id));
      for (const k of tracks(t)) for (const c of k.connectors) {
        expect(c.to).not.toBeNull();
        expect(along.has(c.id)).toBe(false);
      }
    }
  });
});

describe("laying many tracks stays quick", () => {
  /** A rail of `n` Steps where each Step from the fourth on returns three back, and every other one to the first too: tracks that cannot all stand clear. */
  const dense = (n: number) => {
    const stations = [...Array.from({ length: n }, (_, i) => `s${i}`), DONE_STATION];
    const connectors: LineConnector[] = [];
    for (let i = 3; i < n; i++) {
      connectors.push({ id: `s${i}:back`, from: `s${i}`, to: `s${i - 3}`, name: "back", position: 1 });
      if (i % 2) connectors.push({ id: `s${i}:restart`, from: `s${i}`, to: "s0", name: "restart", position: 2 });
    }
    return { stations, connectors };
  };

  for (const n of [9, 10, 14]) {
    it(`lays ${n - 3} tracks on ${n} Steps in under 50 ms`, () => {
      const { stations, connectors } = dense(n);
      laneTracks(stations, connectors, new Set());
      const t0 = performance.now();
      const list = laneTracks(stations, connectors, new Set());
      expect(performance.now() - t0).toBeLessThan(50);
      expect(new Set(list.map((k) => k.lane)).size).toBe(list.length);
    });
  }
});
