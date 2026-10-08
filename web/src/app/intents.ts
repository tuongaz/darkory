import { useEffect, useRef } from "react";

/**
 * What the shell asks of whoever answers it, wherever their dialogs live:
 *
 * - `file-task`: the C key, ⌘K's "File a Task" and the Install checklist. `project` is the
 *   Project's key: the current one when the sender knows no other. It may also name the Step to
 *   start at (`step`, a Step id: a board column's +), the Task to file a Subtask under (`parent`,
 *   a key), and the `title` to start with (⌘K's words when nothing matched them). The Tasks
 *   screen's dialogs answer it (`BoardDialogs`, mounted once by the shell).
 * - `new-project`: "+ New Project" in the switcher, ⌘K, Settings and the Install checklist; the
 *   shell's New Project dialog answers it.
 * - `switch-project`: G then P; the sidebar opens its Project switcher.
 * - `search`: the sidebar's Search; the shell opens ⌘K.
 * - `filter`: the F key; a page with Filters opens its menu.
 */
export type Intent =
  | { kind: "file-task"; project?: string; step?: string; parent?: string; title?: string }
  | { kind: "new-project" }
  | { kind: "switch-project" }
  | { kind: "search" }
  | { kind: "filter" };

export const intentEvent = "darkory:intent";

export function sendIntent(intent: Intent) {
  window.dispatchEvent(new CustomEvent<Intent>(intentEvent, { detail: intent }));
}

/** Calls `handler` with every Intent of `kind` sent while mounted. */
export function useIntent<K extends Intent["kind"]>(kind: K, handler: (intent: Extract<Intent, { kind: K }>) => void) {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const listener = (e: Event) => {
      const intent = (e as CustomEvent<Intent>).detail;
      if (intent?.kind === kind) latest.current(intent as Extract<Intent, { kind: K }>);
    };
    window.addEventListener(intentEvent, listener);
    return () => window.removeEventListener(intentEvent, listener);
  }, [kind]);
}
