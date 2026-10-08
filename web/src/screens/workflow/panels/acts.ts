import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, call, type Member, type Task } from "@/api/client";
import { setAgentSettings } from "@/api/writes";
import { refusalToast } from "@/screens/inbox/toast";

// The writes a Needs you card makes. Each one's success refetches every query (queryClient.ts),
// as the stream would for another tab.

/** Why an answer did not go through, in words, with the refusal's code. */
export class AnswerRefusal extends Error {
  readonly code: string;
  /** The question is now held by the one answering, so another Answer only completes it. */
  readonly held: boolean;

  constructor(message: string, code: string, held: boolean) {
    super(message);
    this.name = "AnswerRefusal";
    this.code = code;
    this.held = held;
  }
}

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : "network");
const wordsOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Answers a question in one submit: claims it (unless the caller already holds it), then completes
 * it with the answer as its Note, which `/complete` adds first in the same write, so a Note never
 * lands on a question left open. A refusal at either step says which, in words: someone else
 * answered first, or the claim held but the completion was refused and the question is now the
 * caller's to finish.
 */
export async function answerQuestion(task: Pick<Task, "key">, answer: string, holdsIt: boolean): Promise<Task> {
  if (!holdsIt) {
    try {
      await call(api.POST("/v1/tasks/{task}/claim", { params: { path: { task: task.key } }, body: {} }));
    } catch (err) {
      const code = codeOf(err);
      const why =
        code === "already_claimed"
          ? `Someone else is answering ${task.key} now.`
          : code === "ended" || code === "not_takeable"
            ? `${task.key} can no longer be answered: ${wordsOf(err)}`
            : `${task.key} was not claimed: ${wordsOf(err)}`;
      throw new AnswerRefusal(why, code, false);
    }
  }
  try {
    return await call(api.POST("/v1/tasks/{task}/complete", { params: { path: { task: task.key } }, body: { note: answer } }));
  } catch (err) {
    throw new AnswerRefusal(`You hold ${task.key}, but it was not completed: ${wordsOf(err)} Answer again to finish it.`, codeOf(err), true);
  }
}

export function useAnswer(task: Task, holdsIt: boolean, onAnswered: () => void) {
  const qc = useQueryClient();
  return useMutation<Task, AnswerRefusal, string>({
    mutationFn: (answer) => answerQuestion(task, answer, holdsIt),
    onSuccess: onAnswered,
    // A claim that held changes the Task even when the completion was refused.
    onError: (err) => {
      if (err.held) for (const root of ["tasks", "task", "takeable"]) void qc.invalidateQueries({ queryKey: [root] });
    },
  });
}

export function useComplete(task: Task) {
  return useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/complete", { params: { path: { task: task.key } }, body: {} })),
    onSuccess: () => toast.success(`${task.key} completed`),
    onError: refusalToast,
  });
}

export function useTake(task: Task) {
  return useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/claim", { params: { path: { task: task.key } }, body: {} })),
    onSuccess: () => toast.success(`You hold ${task.key}`),
    onError: refusalToast,
  });
}

/** Moves a Task to a Step by hand: the only way out of a hold. */
export function useMoveTo(task: Task) {
  return useMutation({
    mutationFn: (step: { id: string; name: string }) => call(api.POST("/v1/tasks/{task}/step", { params: { path: { task: task.key } }, body: { step: step.id } })),
    onSuccess: (_, step) => toast.success(`${task.key} moved to ${step.name}`),
    onError: refusalToast,
  });
}

/** Resumes paused agents: the Runner starts their sessions again. */
export function useResume(agents: Member[]) {
  return useMutation({
    mutationFn: () => Promise.all(agents.map((a) => setAgentSettings(a.id, { paused: false }))),
    onSuccess: () => toast.success(`${agents.map((a) => a.name).join(", ")} resumed`),
    onError: refusalToast,
  });
}

/** Takes the Claim on a Task back from the agent holding it. */
export function useTakeBack(task: Task, agent: Member) {
  return useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/take-back", { params: { path: { task: task.key } }, body: {} })),
    onSuccess: () => toast.success(`${task.key} taken back from ${agent.name}`),
    onError: refusalToast,
  });
}
