import { useCallback } from "react";
import { useLocation, useSearchParams, type To } from "react-router";

/** The search parameter that opens a Task's Peek over whatever page is showing. */
export const peekParam = "task";

/**
 * The anchor of the Task's Session panel, in its peek and on its page: a link with it opens the
 * record scrolled to the panel. The location state `{ join: true }` also joins an admin to the
 * session's terminal.
 */
export const sessionAnchor = "session";

/** A link to the current page with the Task's Peek open over it; other parameters (?view=) stay. */
export function usePeekLink(): (taskKey: string) => To {
  const location = useLocation();
  return useCallback(
    (taskKey: string) => {
      const params = new URLSearchParams(location.search);
      params.set(peekParam, taskKey);
      return { pathname: location.pathname, search: `?${params}` };
    },
    [location.pathname, location.search],
  );
}

/** The key of the Task whose Peek is open, and a function that closes it. */
export function usePeek(): { taskKey: string | null; close: () => void } {
  const [params, setParams] = useSearchParams();
  const close = useCallback(() => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete(peekParam);
      return next;
    });
  }, [setParams]);
  return { taskKey: params.get(peekParam), close };
}
