import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, call, type Activity, type Member, type Project, type TaskDetail } from "@/api/client";
import { keys, useDirectory, useOpenTasks, useRunnerSessions } from "@/api/queries";
import { useNow } from "@/clock";
import { useWorkflows } from "@/components/filters/useTaskFilter";
import { useCurrentMe } from "@/me";
import { useRecentActivity, useTaskDetails } from "@/screens/inbox/queries";
import { agentNeedsOf, needsOf, type AgentNeed, type NeedItem } from "./needs";

export type Needs = {
  items: NeedItem[];
  agents: AgentNeed[];
  /** The Task ids of the cards: What's happening gives them no row (an agent's Task keeps its own, flagged). */
  taskIds: Set<string>;
  loading: boolean;
  error: Error | null;
};

const noProjects: Project[] = [];

/**
 * What needs the signed-in Member in `project`, or across every Project with none (the Inbox):
 * the decision cards in their order and the agents whose sessions wait on someone. Every read is
 * shared with the rest of the app, so Needs you and What's happening ask once between them.
 */
export function useNeeds(project?: Project): Needs {
  const me = useCurrentMe().member;
  const now = useNow();
  const dir = useDirectory();
  const open = useOpenTasks();
  const sessions = useRunnerSessions();
  const projects = useMemo(() => (project ? [project] : dir.projectList.length ? dir.projectList : noProjects), [project, dir.projectList]);
  const { workflows } = useWorkflows(projects);
  const projectReads = useQueries({
    queries: projects.map((p) => ({
      queryKey: keys.project(p.key),
      queryFn: () => call(api.GET("/v1/projects/{project}", { params: { path: { project: p.key } } })),
    })),
  });
  const lapses = useRecentActivity({ kind: ["task.lapsed"], ...(project ? { project: project.key } : {}) }, (e) => e.kind === "task.lapsed");

  const tasks = useMemo(() => open.data ?? [], [open.data]);
  // The records a decision needs: a finished Parent's Subtasks, a Retrospective's proposals.
  const looked = tasks.filter(
    (t) => t.owner_id === me.id && (!project || t.project_id === project.id) && ((t.subtask_counts && t.subtask_counts.open === 0) || t.kind === "retrospective"),
  );
  const detailReads = useTaskDetails(looked.map((t) => t.key));
  const detailStamp = detailReads.map((q) => q.dataUpdatedAt).join();
  const projectStamp = projectReads.map((q) => q.dataUpdatedAt).join();
  const lapseStamp = lapses.entries.map((e: Activity) => e.seq).join();
  const nudges = useRecentActivity({ kind: ["task.nudged"], ...(project ? { project: project.key } : {}) }, (e) => e.kind === "task.nudged");
  const nudgeStamp = nudges.entries.map((e: Activity) => e.seq).join();

  return useMemo(() => {
    const details = new Map<string, TaskDetail>(detailReads.flatMap((q) => (q.data ? [[q.data.task.id, q.data] as const] : [])));
    const projectMembers = new Map<string, Member[]>(projectReads.flatMap((q) => (q.data ? [[q.data.project.id, q.data.members] as const] : [])));
    const input = {
      me,
      now,
      open: tasks,
      projectId: project?.id,
      workflows,
      members: dir.members,
      projectMembers,
      details,
      skills: dir.skills,
      sessions: sessions.data?.items ?? [],
      lapses: lapses.entries,
      nudges: nudges.entries,
    };
    const items = needsOf(input);
    const agents = agentNeedsOf(input);
    return {
      items,
      agents,
      taskIds: new Set(items.map((i) => i.task.id)),
      loading: open.isPending,
      error: open.error,
    };
    // The reads' stamps stand for their arrays, which are new on every render.
  }, [me, now, tasks, project?.id, workflows, dir.members, dir.skills, sessions.data, detailStamp, projectStamp, lapseStamp, nudgeStamp, open.isPending, open.error]); // eslint-disable-line react-hooks/exhaustive-deps
}
