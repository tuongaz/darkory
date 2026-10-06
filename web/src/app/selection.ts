import { createContext, useContext } from "react";
import { usePeek } from "./peek";

/**
 * The Task the keyboard walks from (j, k, ↓, ↑) and opens (Enter), held by the shell. A page
 * takes part by marking each Task row or card with `data-task={key}` inside `#main`, in the order
 * it shows them, and drawing `useSelectedTask() === key` as the ring.
 */
export const SelectionContext = createContext<{ selected: string | null; select: (key: string | null) => void }>({
  selected: null,
  select: () => {},
});

/** The selected Task's key: the one whose peek is open, else the one last walked to or focused. */
export function useSelectedTask(): string | null {
  const { taskKey } = usePeek();
  const { selected } = useContext(SelectionContext);
  return taskKey ?? selected;
}

/** The Task rows and cards the page shows, in order. */
export function taskRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("#main [data-task]")];
}

export function taskRow(key: string): HTMLElement | undefined {
  return taskRows().find((r) => r.dataset.task === key);
}
