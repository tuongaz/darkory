import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, call, type Member } from "@/api/client";
import { setAgentSettings } from "@/api/writes";
import { FormDialog } from "@/components/FormDialog";
import type { AgentAction } from "./agentActions";
import { refusalToast } from "./toast";

/**
 * Runs an agent's ⋯ actions: opens a page, pauses or resumes it, nudges its session, or (after
 * asking) stops it. `dialog` is the Stop confirmation, drawn outside the menu that asks for it.
 */
export function useAgentActions(agent: Member | undefined) {
  const navigate = useNavigate();
  const [stopping, setStopping] = useState<string | null>(null);
  const pause = useMutation({
    mutationFn: (paused: boolean) => setAgentSettings(agent!.id, { paused }),
    onSuccess: (m) => toast.success(m.agent?.paused ? `${agent!.name} paused: it starts no new session` : `${agent!.name} resumed`),
    onError: refusalToast,
  });
  const nudge = useMutation({
    mutationFn: (task: string) => call(api.POST("/v1/runner/sessions/{task}/nudge", { params: { path: { task } } })),
    onSuccess: () => toast.success(`${agent!.name} nudged to advance it, complete it, or file a question`),
    onError: refusalToast,
  });
  const stop = useMutation({
    mutationFn: (task: string) => call(api.POST("/v1/runner/sessions/{task}/stop", { params: { path: { task } } })),
    onSuccess: () => {
      setStopping(null);
      toast.success(`${agent!.name}'s session is stopping`);
    },
  });
  const run = (a: AgentAction) => {
    if ("to" in a) void navigate(a.to);
    else if ("paused" in a) pause.mutate(a.paused);
    else if (a.session === "nudge") nudge.mutate(a.taskKey);
    else {
      stop.reset();
      setStopping(a.taskKey);
    }
  };
  const dialog = (
    <FormDialog
      open={!!stopping}
      onOpenChange={(open) => !open && setStopping(null)}
      title={`Stop ${agent?.name ?? "the agent"}'s session on ${stopping}?`}
      description="Its Claim is released with a Note, and the session's log is attached to the Task as Evidence."
      submitLabel="Stop session"
      destructive
      pending={stop.isPending}
      error={stop.error}
      onSubmit={() => stopping && stop.mutate(stopping)}
    >
      {null}
    </FormDialog>
  );
  return { run, dialog };
}

