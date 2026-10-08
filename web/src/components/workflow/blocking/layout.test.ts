import { describe, expect, it } from "vitest";
import { edgeCrossings } from "../gridRoute";
import { crosses } from "../route";
import { acrossGeometry, analyseBlocking, downGeometry, endsText, placeBlocking, type BlockingLayout, type BlockingTask } from "./layout";
import { bigTasks, mainTasks, me } from "./samples";

const keys = (tasks: BlockingTask[], ids: string[]) => ids.map((id) => tasks.find((t) => t.id === id)!.key);
const run = (tasks: BlockingTask[], projectId: string, opts: { scope?: string; down?: boolean } = {}) => {
  const a = analyseBlocking(tasks, { projectId, scope: opts.scope, me: me.id });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layout = placeBlocking(byId, a, opts.down ? downGeometry : acrossGeometry, { projectId, scope: opts.scope, fit: opts.down ? 358 : 880 });
  const node = (key: string) => layout.nodes.find((n) => byId.get(n.id)!.key === key)!;
  return { a, layout, node, k: (ids: string[]) => keys(tasks, ids) };
};

/** No arrow runs through a node it does not join. */
function clearOfNodes(layout: BlockingLayout) {
  for (const e of layout.edges) {
    const others = layout.nodes.filter((n) => n.id !== e.from && n.id !== e.to).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
    expect(crosses(e.points, others), e.id).toBe(false);
  }
}

describe("analyseBlocking", () => {
  const { a, k } = run(mainTasks, "p-main");

  it("draws the Tasks with a Blocking, never a Parent, and lists the rest", () => {
    expect(k(a.nodes).sort()).toEqual(["MAIN-10", "MAIN-11", "MAIN-12", "MAIN-13", "MAIN-18", "MAIN-19", "MAIN-4"].sort());
    expect(k(a.noBlocking)).toEqual(["MAIN-9", "MAIN-6", "MAIN-5", "MAIN-14"]);
    expect([a.edges.length, a.blocked, a.nodes.length, a.shown]).toEqual([5, 4, 7, 11]);
  });

  it("columns each Task by how many must end before it can", () => {
    const at = (key: string) => a.depth.get(mainTasks.find((t) => t.key === key)!.id);
    expect(["MAIN-10", "MAIN-12", "MAIN-13"].map(at)).toEqual([0, 0, 0]);
    expect(["MAIN-11", "MAIN-4"].map(at)).toEqual([1, 1]);
    expect(["MAIN-18", "MAIN-19"].map(at)).toEqual([2, 2]);
    expect(a.depths).toBe(3);
    expect([0, 1, 2, 3, 10, 11, 21, 22, 23, 112].map(endsText)).toEqual(["Ends 1st", "Ends 2nd", "Ends 3rd", "Ends 4th", "Ends 11th", "Ends 12th", "Ends 22nd", "Ends 23rd", "Ends 24th", "Ends 113th"]);
  });

  it("names the longest chain, a tie going to the higher Rank", () => {
    // MAIN-13 → MAIN-4 → MAIN-19 is as long; MAIN-7 ranks first.
    expect(k(a.longest)).toEqual(["MAIN-10", "MAIN-11", "MAIN-18"]);
  });

  it("puts first what the signed-in Member can do that unblocks the most", () => {
    expect(a.first && { ...a.first, id: k([a.first.id])[0], unblocks: k(a.first.unblocks) }).toEqual({ id: "MAIN-13", verb: "Answer", unblocks: ["MAIN-4"], leadsTo: 2 });
    // MAIN-12 only shares MAIN-19 with MAIN-4: it unblocks nothing alone.
    expect(a.takeableNow.map((x) => [k([x.id])[0], k(x.unblocks)])).toEqual([
      ["MAIN-13", ["MAIN-4"]],
      ["MAIN-12", []],
    ]);
    const held = mainTasks.map((t) => (t.key === "MAIN-10" ? { ...t, holder: { ...me, working: "held" as const } } : t));
    const mine = analyseBlocking(held, { projectId: "p-main", me: me.id });
    // Both lead to two Tasks; MAIN-10 unblocks one directly as MAIN-13 does, and ranks first.
    expect(mine.first && [keys(held, [mine.first.id])[0], mine.first.verb]).toEqual(["MAIN-10", "Continue"]);
  });

  it("scoped to a Parent, shows its Subtasks and draws the outside Tasks joined to them", () => {
    const scoped = run(mainTasks, "p-main", { scope: "main-7" });
    expect(scoped.k(scoped.a.nodes).sort()).toEqual(["MAIN-10", "MAIN-11", "MAIN-12", "MAIN-18", "MAIN-19"].sort());
    expect(scoped.k([...scoped.a.outside])).toEqual(["MAIN-19"]);
    expect(scoped.k(scoped.a.noBlocking)).toEqual(["MAIN-9"]);
    // MAIN-4 blocks MAIN-19 too, but neither is the Parent's: that Blocking is not drawn here.
    expect(scoped.a.edges.map(([b, z]) => scoped.k([b, z]).join(">")).sort()).toEqual(["MAIN-10>MAIN-11", "MAIN-11>MAIN-18", "MAIN-12>MAIN-19"]);
    // MAIN-4 still blocks MAIN-19, though not drawn: MAIN-12 alone unblocks nothing.
    expect(scoped.a.takeableNow.map((x) => [scoped.k([x.id])[0], x.unblocks])).toEqual([["MAIN-12", []]]);
    expect(scoped.layout.bands.map((b) => [b.id, b.outside])).toEqual([
      ["main-7", false],
      ["none:p-main", true],
    ]);
  });

  it("scoped to one Task, shows what blocks it and what it blocks, all the way along", () => {
    const one = run(mainTasks, "p-main", { scope: "main-4" });
    expect(one.k(one.a.nodes).sort()).toEqual(["MAIN-12", "MAIN-13", "MAIN-19", "MAIN-4"].sort());
    expect(one.k([...one.a.outside])).toEqual(["MAIN-12"]);
  });

  it("draws a blocker in another Project as an outside node", () => {
    const api: BlockingTask = { ...mainTasks[0], id: "api-3", key: "API-3", title: "Rate limits", projectId: "p-api", parent: false, parentId: undefined, rank: 1, stepId: "x", since: 0 };
    const tasks = mainTasks.map((t) => (t.key === "MAIN-6" ? { ...t, blockedBy: ["api-3"] } : t)).concat(api);
    const { a: crossed, layout } = run(tasks, "p-main");
    expect([...crossed.outside]).toEqual(["api-3"]);
    expect(crossed.shown).toBe(11);
    expect(layout.bands.at(-1)).toMatchObject({ id: "none:p-api", outside: true });
  });
});

describe("placeBlocking, across", () => {
  it("MAIN: a band per Parent, then no Parent; chains straight along their lanes; 0 crossings", () => {
    const { layout, node } = run(mainTasks, "p-main");
    expect(layout.bands.map((b) => b.id)).toEqual(["main-7", "none:p-main"]);
    expect(layout.columns.length).toBe(3);
    // The chains run straight; MAIN-12 sits under MAIN-10; the question leads the no-Parent band.
    for (const [x, y] of [
      ["MAIN-10", "MAIN-11"],
      ["MAIN-11", "MAIN-18"],
      ["MAIN-13", "MAIN-4"],
      ["MAIN-4", "MAIN-19"],
    ])
      expect(node(x).y, `${x} ${y}`).toBe(node(y).y);
    expect(node("MAIN-12").x).toBe(node("MAIN-10").x);
    expect(node("MAIN-12").y).toBeGreaterThan(node("MAIN-10").y);
    expect(node("MAIN-13").y).toBeGreaterThan(node("MAIN-12").y);
    // The cross-band arrow runs along MAIN-12's lane and turns once, beside MAIN-19.
    const cross = layout.edges.find((e) => e.id === "main-12->main-19")!;
    expect(cross.points).toHaveLength(4);
    expect(cross.points[1].x).toBeGreaterThan(node("MAIN-11").x + node("MAIN-11").w);
    expect(cross.points[1].x).toBeLessThan(node("MAIN-19").x);
    // Into MAIN-19 above MAIN-4's arrow.
    const straight = layout.edges.find((e) => e.id === "main-4->main-19")!;
    expect(cross.points.at(-1)!.y).toBeLessThan(straight.points.at(-1)!.y);
    expect(straight.points.every((p) => p.y === straight.points[0].y)).toBe(true);
    expect(edgeCrossings(layout.edges)).toBe(0);
    clearOfNodes(layout);
    expect(layout.edges.filter((e) => e.longest).map((e) => e.id)).toEqual(["main-10->main-11", "main-11->main-18"]);
  });

  it("BIG: 9 Blockings, the 4-chain along the top, a double block into BIG-10, 0 crossings", () => {
    const { a, layout, node, k } = run(bigTasks, "p-big");
    expect([a.nodes.length, a.edges.length, a.blocked, a.shown, a.noBlocking.length]).toEqual([13, 9, 8, 24, 11]);
    expect(layout.columns.length).toBe(4);
    expect(layout.bands.map((b) => b.id)).toEqual(["big-25", "big-26", "none:p-big"]);
    expect(k(a.longest)).toEqual(["BIG-7", "BIG-10", "BIG-12", "BIG-19"]);
    const top = layout.bands[0].y;
    for (const key of ["BIG-7", "BIG-10", "BIG-12", "BIG-19"]) {
      expect(node(key).lane).toBe(0);
      expect(node(key).y).toBe(node("BIG-7").y);
      expect(node(key).y).toBeGreaterThan(top);
    }
    expect([node("BIG-7"), node("BIG-10"), node("BIG-12"), node("BIG-19")].map((n) => n.depth)).toEqual([0, 1, 2, 3]);
    expect([node("BIG-9").lane, node("BIG-11").lane]).toEqual([1, 1]);
    expect(node("BIG-11").y).toBe(node("BIG-9").y);
    // The double block: two arrows into BIG-10's left side, BIG-7's above BIG-9's.
    const into10 = layout.edges.filter((e) => e.to === "big-10");
    expect(into10.map((e) => e.from).sort()).toEqual(["big-7", "big-9"]);
    const end = (from: string) => into10.find((e) => e.from === from)!.points.at(-1)!;
    expect(end("big-7").x).toBe(node("BIG-10").x);
    expect(end("big-9").x).toBe(node("BIG-10").x);
    expect(end("big-7").y).toBeLessThan(end("big-9").y);
    // BIG-9's arrow rises in the first gutter; its second runs straight into BIG-11.
    const rise = into10.find((e) => e.from === "big-9")!;
    expect(rise.points).toHaveLength(4);
    expect(rise.points[1].x).toBeGreaterThan(node("BIG-9").x + node("BIG-9").w);
    expect(rise.points[1].x).toBeLessThan(node("BIG-10").x);
    expect(layout.edges.find((e) => e.id === "big-9->big-11")!.points.every((p, _, ps) => p.y === ps[0].y)).toBe(true);
    expect(edgeCrossings(layout.edges)).toBe(0);
    clearOfNodes(layout);
    expect(layout.edges.filter((e) => e.longest)).toHaveLength(3);
  });

  it("widens the nodes to fill the width, within bounds", () => {
    const at = (fit: number) => placeBlocking(new Map(mainTasks.map((t) => [t.id, t])), analyseBlocking(mainTasks, { projectId: "p-main", me: me.id }), acrossGeometry, { projectId: "p-main", fit });
    expect(at(800).nodes[0].w).toBe(Math.floor((800 - 24 - 24 - 112) / 3));
    expect(at(880).width).toBeLessThanOrEqual(880);
    expect(at(4000).nodes[0].w).toBe(236);
    expect(at(300).nodes[0].w).toBe(196);
  });

  it("makes each band as wide as the columns and stacks the bands without overlap", () => {
    const { layout } = run(bigTasks, "p-big");
    for (let i = 1; i < layout.bands.length; i++) expect(layout.bands[i].y).toBeGreaterThan(layout.bands[i - 1].y + layout.bands[i - 1].h);
    for (const n of layout.nodes) {
      const band = layout.bands.find((b) => b.id === n.band)!;
      expect(n.x).toBeGreaterThan(band.x);
      expect(n.x + n.w).toBeLessThan(band.x + band.w);
      expect(n.y).toBeGreaterThan(band.y);
      expect(n.y + n.h).toBeLessThan(band.y + band.h);
    }
    expect(layout.width).toBeGreaterThan(layout.bands[0].x + layout.bands[0].w);
    expect(layout.height).toBeGreaterThan(layout.bands.at(-1)!.y + layout.bands.at(-1)!.h);
  });
});

describe("placeBlocking, down (a phone)", () => {
  it("MAIN: depth runs down inside each band, the bands stack, 0 crossings", () => {
    const { layout, node } = run(mainTasks, "p-main", { down: true });
    expect(layout.columns).toEqual([]);
    expect(node("MAIN-11").x).toBe(node("MAIN-10").x);
    expect(node("MAIN-11").y).toBeGreaterThan(node("MAIN-10").y + node("MAIN-10").h);
    expect(node("MAIN-18").y).toBeGreaterThan(node("MAIN-11").y);
    expect(node("MAIN-12").y).toBe(node("MAIN-10").y);
    expect(node("MAIN-12").x).toBeGreaterThan(node("MAIN-10").x + node("MAIN-10").w);
    // The no-Parent band is below MAIN-7's, starting again at depth 0.
    expect(node("MAIN-13").y).toBeGreaterThan(node("MAIN-18").y + node("MAIN-18").h);
    expect(node("MAIN-13").x).toBe(node("MAIN-10").x);
    // Two lanes fill the phone's 358 px.
    expect([node("MAIN-10").w, node("MAIN-10").h]).toEqual([146, 74]);
    // Chains are straight down.
    const down = layout.edges.find((e) => e.id === "main-10->main-11")!;
    expect(down.points.every((p) => p.x === down.points[0].x)).toBe(true);
    expect(edgeCrossings(layout.edges)).toBe(0);
    clearOfNodes(layout);
    expect(layout.width).toBe(358);
  });

  it("BIG: 0 crossings and nothing through a node", () => {
    const { layout } = run(bigTasks, "p-big", { down: true });
    expect(edgeCrossings(layout.edges)).toBe(0);
    clearOfNodes(layout);
  });
});
