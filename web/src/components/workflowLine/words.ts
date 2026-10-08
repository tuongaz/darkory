import type { LineConnector } from "./model";

/*
 * What every line on the Workflow line says, in words: the labels drawn on it and the sentence its
 * hover shows. The horizontal line, the phone and the Text view all read them from here, so they
 * never say different things.
 */

/** The label on the entry arrow, and the mark on a start Step the arrow cannot reach. */
export const ENTRY_LABEL = "New Tasks start here";
/** The label on the arrow from the breakdown Step into the start Step. */
export const FILES_LABEL = "files Subtasks";
/** The label on every line along which a human, not a Connector, moves a Task. */
export const HAND_LABEL = "by hand";
/** The branch the breakdown Step sits on. */
export const BREAKDOWN_BRANCH = "Break down";
/** What a hold says under its name. */
export const HOLD_NOTE = "hold · moved on by hand";

type Name = (id: string | null) => string;

/** "Build → QA: when the holder says pass"; into Done it says the Task is complete. */
export function outcomeHint(c: LineConnector, name: Name): string {
  const base = `${name(c.from)} → ${name(c.to)}: when the holder says ${c.name}`;
  return c.to === null ? `${base}, and the Task is complete` : base;
}

/** Several Connectors drawn as one line (a branch row, a return track): each in turn. */
export function outcomesHint(cs: readonly LineConnector[], name: Name): string {
  return cs.map((c) => outcomeHint(c, name)).join(". ");
}

/** Two neighbours no Connector joins. */
export function handHint(from: string, to: string): string {
  return `${from} → ${to}: no Connector joins them, so nothing moves along here on its own; a human moves a Task on by hand`;
}

/** Two neighbours no Connector joins, where the first Step's outcomes all lead elsewhere: nothing moves along here. */
export function gapHint(from: string, to: string): string {
  return `${from} → ${to}: no outcome of ${from} leads to ${to}, so nothing moves along here; a Task reaches ${to} when it is filed there, or moved there by hand`;
}

/** The entry arrow, or the mark on the start Step. */
export function entryHint(start: string): string {
  return `New Tasks start at ${start}, unless the filer names another Step`;
}

/** A hold off the line, and its arrow into the line. */
export function holdHint(hold: string): string {
  return `${hold}: a hold. No one is offered these; a human moves a Task on by hand, to any Step`;
}

/** The breakdown Step's arrow into the start Step. */
export function filesHint(step: string, start: string | undefined): string {
  const there = start ? `; they start at ${start}` : "";
  return `${step}: a Task filed with Break down on becomes a Parent, and Darkory files its Breakdown Subtask here. Whoever takes it files the Parent's other Subtasks${there}`;
}

/** The breakdown Step's own outcome, in words beside it ("done → Done"). */
export function breakdownOutcomeHint(c: LineConnector, name: Name, start: string | undefined): string {
  const end = `${name(c.from)}'s Breakdown Subtask ends ${c.to === null ? "Done" : `at ${name(c.to)}`} when its holder says ${c.name}`;
  return start ? `${end}; the Subtasks it filed start at ${start}` : end;
}

/** The branch where Darkory files a Parent's own Subtasks. */
export const AFTER_BRANCH = "After a Parent";

/** The branch "After a Parent". */
export const AFTER_HINT = "After a Parent: once a Parent's Subtasks end, Darkory files its own Subtasks about the Parent as a whole at these Steps";

/** What the Text view and the phone say of a hold. */
export function holdSentence(): string {
  return "A hold: no one is offered its Tasks; a human moves each on by hand, to any Step.";
}

/** What the Text view and the phone say of the breakdown Step. */
export function breakdownSentence(start: string | undefined): string {
  return `Break down: a Task filed with Break down on gets its Breakdown Subtask here; whoever takes it files the other Subtasks${start ? `, which start at ${start}` : ""}.`;
}
