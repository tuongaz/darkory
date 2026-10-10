import type { TaskDetail, WorkflowStep } from "@/api/client";
import { useDirectory, useOpenTasks } from "@/api/queries";
import { useNow } from "@/clock";
import { waitsFor } from "./takers";

/** "waits for builder": whom the Task waits for at its Step while every taker is busy; nothing otherwise. */
export function useWaitsFor(detail: TaskDetail, steps: readonly WorkflowStep[]): string | undefined {
  const now = useNow();
  const { members } = useDirectory();
  const open = useOpenTasks().data ?? [];
  const id = waitsFor(detail, steps.find((s) => s.id === detail.task.step_id), open, members, now);
  return id ? `waits for ${members.get(id)?.name ?? "a Member"}` : undefined;
}
