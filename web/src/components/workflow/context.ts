import { createContext, useContext } from "react";
import type { Mode } from "./flow";

/** What the canvas's nodes and edges need from it, kept out of their data so it stays the record. */
export type CanvasActions = {
  mode: Mode;
  /** "+" on a step: a new step after it. */
  onAdd?: (from: string) => void;
  /** A Connector's name was clicked: select it, as clicking its line does. */
  onSelectConnector?: (id: string) => void;
};

export const CanvasContext = createContext<CanvasActions>({ mode: "live" });

export function useCanvas(): CanvasActions {
  return useContext(CanvasContext);
}
