import { describe, expect, it } from "vitest";
import { BIG, MAIN } from "./fixtures";
import { crossings, densityFor, horizontal, lineTopology, topologyCrossings, type Arc, type Track } from "./layout";
import { DONE_STATION, type LineWorkflow } from "./model";

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
