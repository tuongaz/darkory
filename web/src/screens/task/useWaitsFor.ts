import type { TaskDetail, WorkflowStep } from "@/api/client";
import { useDirectory, useOpenTasks } from "@/api/queries";
import { useNow } from "@/clock";
import { waitsFor } from "./takers";

/** "waits for builder": whom the Task waits for at its Step while every taker is busy; nothing otherwise. */
export function useWaitsFor(detail: TaskDetail, steps: readonly WorkflowStep[]): string | undefined {
  const now = useNow();
  const { members } = useDirectory();
  const open = useOpenTasks().data ?? [];
  const ids = waitsFor(detail, steps.find((s) => s.id === detail.task.step_id), open, members, now);
  return ids.length ? `waits for ${ids.map((id) => members.get(id)?.name ?? "a Member").join(", ")}` : undefined;
}
