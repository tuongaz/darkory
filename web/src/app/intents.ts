import { useEffect, useRef } from "react";

/**
 * What the shell asks a screen to open, wherever the screen's dialogs live. The shell sends
 * `file-task` for the C key and ⌘K's "File a Task"; `file-feature` for ⌘K and the Install
 * checklist. `team` is the current Team's key when there is one. A `file-task` may also name the
 * Status (`status`, a Status id: a column's +) and the Feature (`feature`, a key or id) to start
 * in. The Board screen's dialogs, mounted once by the shell (BoardDialogs), handle both.
 */
export type Intent =
  | { kind: "file-task"; team?: string; status?: string; feature?: string }
  | { kind: "file-feature"; team?: string };

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
