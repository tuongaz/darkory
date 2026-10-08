import type { MemberKind } from "@/lib/work";

/*
 * What the live canvas shows as it happens, beside the Workflow it draws: the callouts above the
 * Steps, the chips pulsing, the tokens travelling the Connectors. The page works these out from
 * the Activity stream (screens/workflow/useLiveFlow.ts); the canvas only draws them.
 */

/**
 * The colour of a moment: a pickup in the holder's (the AI gradient for an agent, the human ink
 * for a human), a let-go grey, a lapse amber, a take-back red, a filing blue.
 */
export type Tone = "agent" | "human" | "neutral" | "lapsed" | "back" | "filed";

export type Who = { id: string; name: string; kind: MemberKind };

/** Where a Task went: from a Step to a Step, `done` or `dropped`; along a Connector when it advanced or completed. */
export type Travel = { from: string; to: string; connectorId?: string };
export const DONE = "done";
export const DROPPED = "dropped";

export type Callout = { id: number; tone: Tone; who?: Who; text: string; taskId?: string };
export type Token = { id: number; key: string; travel: Travel };

/** The moments playing on the canvas now. */
export type FlowState = {
  /** Each Step's callouts, newest first. */
  callouts: Map<string, Callout[]>;
  /** The chips pulsing, by Task id, in their moment's colour. */
  pulses: Map<string, Tone>;
  /** The Steps outlined, in their moment's colour. */
  glows: Map<string, Tone>;
  /** The tokens travelling now. */
  tokens: Token[];
  /** The Tasks a token carries: their chips are drawn nowhere until it lands. */
  transit: Set<string>;
  /** The chips just arrived at their Step, highlighted. */
  arrived: Set<string>;
  /** The Connectors a token runs along: their outcome's name lights. */
  lit: Set<string>;
};

export const quiet: FlowState = {
  callouts: new Map(),
  pulses: new Map(),
  glows: new Map(),
  tokens: [],
  transit: new Set(),
  arrived: new Set(),
  lit: new Set(),
};

/** The live canvas's moments, what the page has lit (a trail row hovered), and where a chip leads. */
export type LiveCanvas = FlowState & {
  /** The Steps and the Task a hovered trail row names. */
  focus?: { steps: string[]; taskId?: string };
  /** A chip was clicked: open the Task's peek. */
  onOpenTask?: (key: string) => void;
};
