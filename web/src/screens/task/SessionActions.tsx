import { useMutation } from "@tanstack/react-query";
import { BellRingIcon, CircleStopIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, call, type RunnerSession, type TaskDetail } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useCurrentMe } from "@/me";
import { StopSessionDialog } from "./dialogs";

/**
 * An admin's Nudge and Stop session for the Runner's session on the Task, as ⋯ menu items, and the
 * confirm Stop opens. Nothing for anyone else, or while the Runner runs no session on the Task.
 */
export function useSessionActions(detail: TaskDetail | undefined, session: RunnerSession | undefined): { menu: ReactNode[]; dialogs: ReactNode } {
  const me = useCurrentMe();
  const { members } = useDirectory();
  // The confirm open, for the Task it was opened on: the peek moving to another Task closes it.
  const [stopping, setStopping] = useState<string | null>(null);
  const taskId = detail?.task.id ?? "";
  const key = detail?.task.key ?? "";
  const nudge = useMutation({
    mutationFn: () => call(api.POST("/v1/runner/sessions/{task}/nudge", { params: { path: { task: taskId } } })),
    onSuccess: () => toast.success(`${(session && members.get(session.member_id)?.name) ?? "The agent"} nudged on ${key}`),
    onError: (err) => toast.error(`${key} not nudged`, { description: err.message }),
  });

  if (!detail || !session || !me.member.admin) return { menu: [], dialogs: null };
  const menu = [
    <DropdownMenuItem key="nudge" onSelect={() => nudge.mutate()}>
      <BellRingIcon />
      Nudge
    </DropdownMenuItem>,
    <DropdownMenuItem key="stop" variant="destructive" onSelect={() => setStopping(taskId)}>
      <CircleStopIcon />
      Stop Shift
    </DropdownMenuItem>,
  ];
  const dialogs = stopping === taskId && (
    <StopSessionDialog detail={detail} session={session} open onOpenChange={(o) => setStopping(o ? taskId : null)} />
  );
  return { menu, dialogs };
}
