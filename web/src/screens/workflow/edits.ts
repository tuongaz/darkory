import { countTasks } from "@/components/workflow/model";
import { same, type RecordStep, type WorkflowRecord } from "./bind";

/*
 * What `/v1` refuses in a Workflow, said in words before anything is sent: the list editor
 * (edit/draft.ts) checks its draft with it before Save.
 */

export const nameMax = 50;

const stepById = (wf: WorkflowRecord, id: string) => wf.steps.find((s) => s.id === id);
const inOrder = (steps: RecordStep[]) => [...steps].sort((a, b) => a.position - b.position);

/**
 * What `/v1` would refuse in `next`, in words, before anything is sent; undefined when nothing.
 * `current` is the Workflow it replaces: a Step it had that `next` does not is deleted, and its
 * open Tasks need a Step in `moves`.
 */
export function problem(next: WorkflowRecord, current: WorkflowRecord, moves: Record<string, string> = {}): string | undefined {
  const steps = inOrder(next.steps);
  for (const s of steps) {
    if (!s.name.trim()) return "A Step needs a name.";
    if (s.name.trim().length > nameMax) return `A Step's name is at most ${nameMax} characters.`;
  }
  for (let i = 0; i < steps.length; i++) {
    const twin = steps.slice(i + 1).find((t) => same(t.name, steps[i].name));
    if (twin) return `Two Steps are called ${steps[i].name.trim()}: a name is used once in a Workflow, whatever its case.`;
  }
  const kept = new Set(next.steps.map((s) => s.id));
  for (const c of next.connectors) {
    const from = stepById(next, c.from_step_id);
    if (!from) return "A Connector leads out of a Step that is gone.";
    if (c.to_step_id === c.from_step_id) return `A Connector leads out of ${from.name} into another Step or Done.`;
    if (c.to_step_id && !kept.has(c.to_step_id)) return `A Connector out of ${from.name} leads into a Step that is gone.`;
    if (!c.name.trim()) return `An outcome out of ${from.name} needs a name.`;
    if (c.name.trim().length > nameMax) return `An outcome's name is at most ${nameMax} characters.`;
    const twin = next.connectors.find((o) => o !== c && o.from_step_id === c.from_step_id && same(o.name, c.name));
    if (twin) return `Two outcomes out of ${from.name} are called ${c.name.trim()}: whoever advances a Task names one, so each is used once.`;
  }
  for (const gone of current.steps.filter((s) => !kept.has(s.id))) {
    const to = moves[gone.id];
    if (gone.tasks > 0 && !to) {
      return `${countTasks(gone.tasks)} ${gone.tasks === 1 ? "is" : "are"} at ${gone.name}: say which Step they move to.`;
    }
    if (to && !kept.has(to)) return `${gone.name}'s Tasks must move to a Step the Workflow keeps.`;
  }
  return undefined;
}
