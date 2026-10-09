import { countTasks } from "@/components/workflow/model";
import { inProjectOrder, workflowsInOrder } from "@/components/workflowLine/model";
import { isId } from "@/lib/shortid";
import { same, type RecordStep, type WorkflowRecord } from "./bind";

/*
 * What `/v1` refuses in a Workflow, said in words before anything is sent: the list editor
 * (edit/draft.ts) checks its draft with it before Save.
 */

export const nameMax = 50;

const stepById = (wf: WorkflowRecord, id: string) => wf.steps.find((s) => s.id === id);
const inOrder = (wf: WorkflowRecord): RecordStep[] => [...wf.steps].sort(inProjectOrder(wf.workflows));

/** What `/v1` refuses in a Workflow's or a Step's name: none, over 50 characters, or spelled as an id. */
export function nameProblem(what: "Workflow" | "Step", name: string): string | undefined {
  const n = name.trim();
  if (!n) return `A ${what} needs a name.`;
  if (n.length > nameMax) return `A ${what}'s name is at most ${nameMax} characters.`;
  if (isId(n)) return `A ${what}'s name cannot be spelled as an id: ${n} is one.`;
  return undefined;
}

/**
 * What `/v1` would refuse in `next`, in words, before anything is sent; undefined when nothing.
 * `current` is the Workflow it replaces: a Step it had that `next` does not is deleted, and its
 * open Tasks need a Step in `moves`.
 */
export function problem(next: WorkflowRecord, current: WorkflowRecord, moves: Record<string, string> = {}): string | undefined {
  const workflows = workflowsInOrder(next.workflows);
  if (workflows.length === 0) return "A Project has one Workflow at least.";
  for (const w of workflows) {
    const p = nameProblem("Workflow", w.name);
    if (p) return p;
  }
  for (let i = 0; i < workflows.length; i++) {
    const twin = workflows.slice(i + 1).find((t) => same(t.name, workflows[i].name));
    if (twin) return `Two Workflows are called ${workflows[i].name.trim()}: a name is used once in a Project, whatever its case.`;
  }
  const steps = inOrder(next);
  for (const s of steps) {
    const p = nameProblem("Step", s.name);
    if (p) return p;
  }
  for (let i = 0; i < steps.length; i++) {
    const twin = steps.slice(i + 1).find((t) => same(t.name, steps[i].name));
    if (twin) return `Two Steps are called ${steps[i].name.trim()}: a name is used once in a Project, whatever its case.`;
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
