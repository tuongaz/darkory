import { createContext, useContext } from "react";
import type { Mode } from "./flow";
import type { LiveCanvas } from "./live";

/** What the canvas's nodes and edges need from it, kept out of their data so it stays the record. */
export type CanvasActions = {
  mode: Mode;
  /** "+" on a Step: a new step after it. */
  onAdd?: (from: string) => void;
  /** A Connector's name was clicked: select it, as clicking its line does. */
  onSelectConnector?: (id: string) => void;
  /** Live, a click on a Step opens it. */
  opens?: boolean;
  /** Live, open a Step's peek: "+N more" under its chips. */
  onOpenStep?: (id: string) => void;
  /** Live, what is happening now: the chips' pulses, the Steps' outlines, the Connectors lit. */
  live?: LiveCanvas;
};

export const CanvasContext = createContext<CanvasActions>({ mode: "live" });

export function useCanvas(): CanvasActions {
  return useContext(CanvasContext);
}
