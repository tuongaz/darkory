import { useMemo } from "react";
import { useMembers, useRunnerSessions, useSkills, useTasks } from "@/api/queries";
import type { Workflow } from "@/components/workflow/model";
import { useNow } from "@/clock";
import { toCanvas, workingAt, type WorkflowRecord } from "./bind";

/**
 * The Workflow record as the live canvas draws it: Skill names, and each taker ringed by how they
 * work at the Step now, from the Project's open Tasks' live Claims and the Runner's sessions. All
 * of it follows Activity, so the canvas stays live.
 */
export function useLiveCanvas(project: string, record: WorkflowRecord | undefined): Workflow | undefined {
  const skills = useSkills();
  const members = useMembers();
  const tasks = useTasks({ project, state: "open" });
  const sessions = useRunnerSessions();
  const now = useNow();
  return useMemo(() => {
    if (!record || !skills.data) return undefined;
    const kinds = new Map((members.data ?? []).map((m) => [m.id, m.kind]));
    const working = workingAt(tasks.data ?? [], sessions.data?.items ?? [], (id) => kinds.get(id), now);
    return toCanvas(record, new Map(skills.data.map((s) => [s.id, s])), working);
  }, [record, skills.data, members.data, tasks.data, sessions.data, now]);
}

/** The record as the editing canvas draws it: Skill names; no rings. */
export function useEditingCanvas(record: WorkflowRecord | undefined): Workflow | undefined {
  const skills = useSkills();
  return useMemo(
    () => (record && skills.data ? toCanvas(record, new Map(skills.data.map((s) => [s.id, s]))) : undefined),
    [record, skills.data],
  );
}
