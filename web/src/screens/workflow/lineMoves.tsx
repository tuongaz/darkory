import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { Task } from "@/api/client";
import { peekParam } from "@/app/peek";
import type { Chain } from "@/components/workflowLine";
import { AnswerButton, ClaimButton } from "@/screens/inbox/parts";

/** Opens a Task's key in the peek, over the page. */
export function useOpenTask() {
  const [, setParams] = useSearchParams();
  return useCallback(
    (key: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set(peekParam, key);
        return next;
      }),
    [setParams],
  );
}

/** The button for a selected Task's first move, from the open Tasks' records: Answer, Claim. */
export function useFirstMove(records: readonly Task[]) {
  const recordOf = useMemo(() => new Map<string, Task>(records.map((t) => [t.id, t])), [records]);
  // The same function while the records stay: a line it is passed to is not drawn again for it.
  return useCallback(
    (first: Chain["first"]) => {
      if (first.kind === "none") return null;
      const task = recordOf.get(first.task.id);
      if (!task) return null;
      return first.kind === "answer" ? <AnswerButton task={task} /> : <ClaimButton task={task} />;
    },
    [recordOf],
  );
}
