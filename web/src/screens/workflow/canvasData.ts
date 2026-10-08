import { useMemo } from "react";
import { useMembers, useRunnerSessions, useSkills, useTasks } from "@/api/queries";
import type { Workflow } from "@/components/workflow/model";
import { useNow } from "@/clock";
import { chipsAt, toCanvas, workingAt, type WorkflowRecord } from "./bind";

/**
 * The Workflow record as the live canvas draws it: Skill names, each taker ringed by how they work
 * at the Step now, and the Tasks at each Step as chips, from the Project's open Tasks' live Claims
 * and the Runner's sessions. All of it follows Activity, so the canvas stays live.
 */
export function useLiveCanvas(project: string, record: WorkflowRecord | undefined): Workflow | undefined {
  const skills = useSkills();
  const members = useMembers();
  const tasks = useTasks({ project, state: "open" });
  const sessions = useRunnerSessions();
  const now = useNow();
  return useMemo(() => {
    if (!record || !skills.data) return undefined;
    const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
    const working = workingAt(tasks.data ?? [], sessions.data?.items ?? [], (id) => byId.get(id)?.kind, now);
    const chips = chipsAt(tasks.data ?? [], sessions.data?.items ?? [], (id) => byId.get(id), now);
    return toCanvas(record, new Map(skills.data.map((s) => [s.id, s])), working, chips);
  }, [record, skills.data, members.data, tasks.data, sessions.data, now]);
}
