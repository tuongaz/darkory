import { describe, expect, it } from "vitest";
import { wfId, wfStep } from "@/test/fixtures";
import { BIG, DARK, DEFAULT, FIVE, HOTFIX, MAIN, SACCA, SOFTWARE } from "./fixtures";
import { laneTracks, lineTopology, railOf, trackCrossings, tracks, type LineTopology } from "./layout";
import { DONE_STATION, type LineConnector, type LineWorkflow } from "./model";

/** A line's tracks as [the Step returned to, its Connectors as "From:outcome", sorted]. */
const returns = (t: LineTopology) => tracks(t).map((k) => [t.steps.get(k.target)?.name, k.connectors.map((c) => `${t.steps.get(c.from)?.name}:${c.name}`).sort()]);

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

  it("keeps the branch's own routes: propose and publish along the row, needs changes a loop in it, the rest as chips", () => {
    const [acc, retro] = t.rows;
    expect(acc.exit?.name).toBe("pass");
    expect(retro.segments.map((s) => s.connector.name)).toEqual(["propose"]);
    expect(retro.exit?.name).toBe("publish");
    expect(retro.loops.map((l) => l.connector.name)).toEqual(["needs changes"]);
    expect(t.chips.map((c) => `${c.stepId}: ${c.text}`)).toEqual(["plan: done → Done", "acceptance: fail → Build", "retro: done → Done"]);
  });

  it("lays its returns uncrossed", () => {
    expect(trackCrossings(tracks(t))).toBe(0);
  });
});

describe("the line on BIG, 12 Steps and 7 loops", () => {
  const t = lineTopology(BIG);

  it("keeps all 12 Steps on the main line: Acceptance and Retro are reached along Connectors here", () => {
    expect(t.main).toEqual(["backlog", "triage", "plan", "design", "build", "creview", "qa", "sec", "docs", "acc", "release", "retro", DONE_STATION]);
    expect(t.rows).toEqual([]);
  });

  it("merges the five returns into Build and the skip past Design on one track; rework into Plan and rollback into QA are tracks of their own", () => {
    expect(returns(t)).toEqual([
      ["Plan", ["Design:rework"]],
      ["Build", ["Acceptance:fail", "Code review:needs changes", "Docs:needs changes", "Plan:no design needed", "QA:fail", "Security review:fail"]],
      ["QA", ["Release:rollback"]],
    ]);
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
    expect(tracks(t)).toEqual([]);
  });

  it("a new hold an editor placed stays where it was put though nothing joins it: on the rail, or among the Steps a Parent's end files into", () => {
    const hold = (id: string, position: number) => ({ id, workflow_id: "work", name: id, position });
    const base = wf(["a", "b"], [["a", "p", "b"], ["b", "p", null]]);
    const parked = lineTopology({ ...base, steps: [...base.steps, hold("n", 3)] });
    expect(parked.holds).toEqual(["n"]);
    const onRail = lineTopology({ ...base, steps: [...base.steps, hold("n", 3)], placed: new Map([["n", "main"]]) });
    expect(onRail.holds).toEqual([]);
    expect(onRail.main).toEqual(["a", "b", "n", DONE_STATION]);
    const after = lineTopology({ ...base, steps: [...base.steps, hold("n", 3)], placed: new Map([["n", "after"]]) });
    expect(after.main).toEqual(["a", "b", DONE_STATION]);
    expect(after.rows.flatMap((r) => r.stations)).toEqual(["n"]);
  });

  it("two returns that interleave: a track each, crossing once, the least they can", () => {
    const t = lineTopology(wf(["a", "b", "c", "d"], [["a", "p", "b"], ["b", "p", "c"], ["c", "p", "d"], ["c", "x", "a"], ["d", "y", "b"]]));
    expect(returns(t)).toEqual([
      ["a", ["c:x"]],
      ["b", ["d:y"]],
    ]);
    expect(trackCrossings(tracks(t))).toBe(1);
  });

  it("a return that straddles where another track's return leaves: a track each, crossing once", () => {
    const t = lineTopology(
      wf(["a", "b", "c", "d", "e", "f"], [["a", "p", "b"], ["b", "p", "c"], ["c", "p", "d"], ["d", "p", "e"], ["e", "p", "f"], ["c", "x1", "a"], ["d", "x2", "a"], ["f", "x3", "a"], ["e", "y", "c"]]),
    );
    expect(returns(t)).toEqual([
      ["a", ["c:x1", "d:x2", "f:x3"]],
      ["c", ["e:y"]],
    ]);
    expect(trackCrossings(tracks(t))).toBe(1);
  });

  it("two Connectors between the same neighbours: the first is the rail, the second a track", () => {
    const t = lineTopology(wf(["a", "b"], [["a", "p", "b"], ["a", "q", "b"], ["b", "p", null]]));
    expect(t.segments[0].connector?.name).toBe("p");
    expect(returns(t)).toEqual([["b", ["a:q"]]]);
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

  it("Bugs: Investigate carries one entry from Triage; Bugs' own Connectors are drawn as they would be alone", () => {
    const wf = FIVE(wfId.bugs);
    const t = lineTopology(wf);
    expect(t.main).toEqual([wfStep.investigate, wfStep.fix, wfStep.review, wfStep.verify, DONE_STATION]);
    // New Tasks start at Triage, which this line does not draw.
    expect(t.start).toBeUndefined();
    expect(t.entries.map((e) => [e.stepId, e.text])).toEqual([[wfStep.investigate, "from Triage · bug"]]);
    expect(t.exits).toEqual([]);
    expect(t.segments.map((s) => s.connector?.name ?? "dotted")).toEqual(["fix", "ready", "pass", "pass"]);
    expect(returns(t)).toEqual([["Fix", ["Review:needs changes", "Verify:fail"]]]);
    expect(t.entries[0].hint).toBe("Triage › Triage → Investigate: when the holder says bug");
    expect(counted(t)).toBe(touching(wf, wfId.bugs));
  });

  it("Support: an entry from Triage on Support, and its returns (Ops' done into Support among them) drawn as they would be alone", () => {
    const wf = FIVE(wfId.support);
    const t = lineTopology(wf);
    expect(t.main).toEqual([wfStep.support, wfStep.awaitingCustomer, wfStep.ops, wfStep.approve, DONE_STATION]);
    expect(t.entries.map((e) => [e.stepId, e.text])).toEqual([[wfStep.support, "from Triage · question"]]);
    expect(t.exits).toEqual([]);
    expect(returns(t)).toEqual([
      ["Support", ["Approve:declined", "Ops:done"]],
      ["Ops", ["Approve:approved", "Support:account change"]],
      ["Approve", ["Support:exception"]],
    ]);
    expect(counted(t)).toBe(touching(wf, wfId.support));
  });

  it("an entry into a Step after the line's first is that Step's entry, as an exit out of it is its exit", () => {
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
  });

  it("a Workflow with no crossing has no exits or entries, and draws as it did before a Project had several", () => {
    const alone = lineTopology({ ...MAIN, drawn: "work" });
    expect(alone.exits).toEqual([]);
    expect(alone.entries).toEqual([]);
    expect(alone).toEqual(lineTopology(MAIN));
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

  // Each at the fewest crossings any lanes and stub heights give, found by trying every one.
  it("lays the software Workflow's four tracks with one crossing at most: Build's long track (its loops and the skip past Design) cannot stand clear of every other", () => {
    expect(trackCrossings(tracks(lineTopology(SOFTWARE)))).toBeLessThanOrEqual(1);
  });

  it("lays Support's three tracks with one crossing at most: Approve returns into Ops and into Support, and Support's own leave from the rows they end at", () => {
    expect(trackCrossings(tracks(lineTopology(FIVE(wfId.support))))).toBeLessThanOrEqual(1);
  });

  it("lays BIG escalating's three tracks with one crossing at most, as BIG's: the exit out of QA is a chip, no track", () => {
    expect(trackCrossings(tracks(lineTopology(HOTFIX())))).toBeLessThanOrEqual(1);
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
