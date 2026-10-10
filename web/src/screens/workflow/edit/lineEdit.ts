import type { RecordStep } from "../bind";
import type { Group } from "./draft";
import type { SkillChoice } from "./SkillPicker";

/** What the editor's line asks of the draft: each a change made on it, sent on Save. */
export type OnLineActions = {
  renameStep: (id: string, name: string) => void;
  /** Ends a run of typing in a field. */
  settle: () => void;
  skill: (id: string, choice: SkillChoice) => void;
  reorder: (id: string, by: -1 | 1) => void;
  moveTo: (id: string, onto: string) => void;
  /** Adds a Step after `id` in its group (at the end of `group` when `id` is undefined). */
  insertAfter: (id: string | undefined, group?: Group) => void;
  deleteStep: (id: string) => void;
  moveToWorkflow: (id: string, workflowId: string) => void;
  addTaker: (id: string, member: string, join: boolean) => void;
  removeTaker: (id: string, member: string) => void;
  renameOutcome: (id: string, name: string) => void;
  target: (id: string, to: string | undefined) => void;
  removeOutcome: (id: string) => void;
  addOutcome: (from: string) => void;
  main: (id: string) => void;
};

/** How a Step is named in a control's words: its name, or "the new Step" while it has none. */
export const stepWord = (s: Pick<RecordStep, "name">) => s.name.trim() || "the new Step";
