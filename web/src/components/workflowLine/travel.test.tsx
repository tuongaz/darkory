import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { quiet, type FlowState } from "@/components/workflow/live";
import { wfId } from "@/test/fixtures";
import { BIG, DEFAULT, FIVE, MAIN, SACCA, SOFTWARE } from "./fixtures";
import { lineTopology } from "./layout";
import type { LineWorkflow } from "./model";
import { WorkflowLine } from "./WorkflowLine";

afterEach(cleanup);

/** One token travelling each Connector out of a drawn Step at once, keyed by the Connector's id. */
const along = (wf: LineWorkflow): FlowState => {
  const t = lineTopology(wf);
  const tokens = wf.connectors.filter((c) => t.steps.has(c.from)).map((c, i) => ({ id: i, key: c.id, travel: { from: c.from, to: c.to ?? "done", connectorId: c.id } }));
  return { ...quiet, tokens, transit: new Set(tokens.map((x) => x.key)) };
};

const drawings: [string, LineWorkflow][] = [
  ["MAIN", MAIN],
  ["BIG", BIG],
  ["SOFTWARE", SOFTWARE],
  ["SACCA", SACCA],
  ["DEFAULT", DEFAULT],
  ...Object.entries(wfId).map(([name, id]): [string, LineWorkflow] => [`five: ${name}`, FIVE(id)]),
];

// Whatever moves a Task makes, its token has a way: along the rail, a track, the quiet line,
// off the line to the right, or from "Also starts here" down the rail from its top.
describe("a token travels every Connector out of a drawn Step", () => {
  for (const [name, wf] of drawings) {
    it(name, () => {
      render(<WorkflowLine workflow={wf} tasks={[]} now={0} flow={along(wf)} />);
      const routed = new Map([...document.querySelectorAll<HTMLElement>("[data-travel]")].map((el) => [el.dataset.travel!, el.getAttribute("style") ?? ""]));
      const t = lineTopology(wf);
      const missing = wf.connectors.filter((x) => t.steps.has(x.from) && !/path\("M/.test(routed.get(x.id) ?? "")).map((c) => `${c.from} ${c.name}`);
      expect(missing).toEqual([]);
    });
  }
});
