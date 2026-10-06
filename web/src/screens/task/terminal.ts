// The Session panel's terminal speaks to `GET /v1/runner/sessions/{task}/terminal` (api/openapi.yaml,
// runnerTerminal): a WebSocket the Runner bridges to `tmux attach`. Binary frames carry the
// terminal's bytes both ways; a text frame `{"cols": n, "rows": n}` sizes the client's view.

/** The terminal's state as the panel draws it. */
export type TerminalStatus = "connecting" | "open" | "closed";

/** Watching sends nothing but the size; joined, the keyboard goes to the session. */
export type TerminalMode = "watch" | "join";

/**
 * A Task's terminal on this Install's own origin, so the browser sends its cookie and the server
 * can check the Origin. `readonly` watches without typing, even as an admin.
 */
export function terminalURL(task: string, readonly: boolean, at: Pick<Location, "protocol" | "host"> = window.location): string {
  const scheme = at.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${at.host}/v1/runner/sessions/${encodeURIComponent(task)}/terminal${readonly ? "?readonly=1" : ""}`;
}

/** The text frame that sizes the client's view, sent on connecting and after every fit. */
export function resizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ cols, rows });
}

/** The shell line that joins the same session from a terminal on the machine. */
export function joinCommand(task: string): string {
  return `darkory join ${task}`;
}

/** The anchor of a Task's Session panel: the Agents page's View opens the Task's peek at it. */
export const sessionAnchor = "session";
