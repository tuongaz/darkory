import { useMemo } from "react";
import type { Label, Member, Project, RunnerSession, Task, WorkflowStep } from "@/api/client";
import { useDirectory, useLabels, useRunnerSessions, useWorkflow } from "@/api/queries";
import { useNow } from "@/clock";
import { useClaimTrails } from "@/components/filters/useTaskFilter";
import { useCurrentMe } from "@/me";
import { liveClaim, taskWorkGlyph } from "@/work";
import type { WorkGlyph } from "@/lib/work";
import { blocking, childrenOf, moveProblem, stepsInOrder } from "./derive";
import { useProjectTasks } from "./queries";

/** Everything a Project's Tasks views read, joined: the records, lookups by id, and who is looking. */
export type TasksModel = ReturnType<typeof useTasksModel>;

export function useTasksModel(project: Project) {
  const tasks = useProjectTasks(project.key);
  const workflow = useWorkflow(project.key);
  const labels = useLabels(project.key);
  // The Project's one Claim trail read: the Filter's Lapsed, the rows' Lapsed and Evidence.
  const trails = useClaimTrails(project.key);
  const dir = useDirectory();
  const me = useCurrentMe();
  const now = useNow();
  const sessions = useRunnerSessions().data?.items;

  const lookups = useMemo(() => {
    const list = tasks.data ?? [];
    const steps = stepsInOrder(workflow.data?.steps ?? []);
    return {
      steps,
      stepById: new Map<string, WorkflowStep>(steps.map((s) => [s.id, s])),
      byId: new Map<string, Task>(list.map((t) => [t.id, t])),
      children: childrenOf(list),
      blocks: blocking(list),
      labelById: new Map<string, Label>((labels.data ?? []).map((l) => [l.id, l])),
      sessionByTask: new Map<string, RunnerSession>((sessions ?? []).map((s) => [s.task_id, s])),
    };
  }, [tasks.data, workflow.data, labels.data, sessions]);

  const kindOf = (id: string) => dir.members.get(id)?.kind;
  return {
    project,
    tasks,
    workflow,
    labels,
    trails,
    members: dir.members,
    memberList: dir.memberList,
    skills: dir.skills,
    me,
    now,
    ...lookups,
    /** The Task's WorkGlyph, its Runner session's state included. */
    glyph: (task: Task): WorkGlyph => taskWorkGlyph(task, now, kindOf, lookups.sessionByTask.get(task.id)?.state),
    /** Why the signed-in Member may not move the Task by hand, or undefined when they may. */
    moveProblem: (task: Task) => moveProblem(task, { me: me.member.id, projects: me.projects, members: dir.members, now, projectName: project.name }),
  };
}

/** The Member holding the Task's live Claim. */
export function holderOf(task: Task, model: Pick<TasksModel, "members" | "now">): Member | undefined {
  const claim = liveClaim(task, model.now);
  return claim ? model.members.get(claim.holder_id) : undefined;
}

/** The Member an open Task nobody holds is aimed at. */
export function aimedAt(task: Task, model: Pick<TasksModel, "members" | "now">): Member | undefined {
  if (!task.aimed_at_id || task.state !== "open" || liveClaim(task, model.now)) return undefined;
  return model.members.get(task.aimed_at_id);
}
