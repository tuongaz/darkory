import { useMemo, useSyncExternalStore } from "react";
import type { Project, Task } from "@/api/client";
import { useMembers, useRunnerSessions, useWorkflow } from "@/api/queries";
import { useNow } from "@/clock";
import type { Workflow } from "@/components/workflow/model";
import { startOfDay } from "@/screens/inbox/derive";
import { useRecentActivity, useTaskMap } from "@/screens/inbox/queries";
import { useEditingCanvas } from "../canvasData";
import { aboutThisFlow, flowKinds, type FlowContext } from "../flowEvents";
import { isQuiet, storiesOf, type Story } from "./stories";
import { useNeeds } from "./useNeeds";
import { useSeen, type Seen } from "./useSeen";

const none: Workflow = { steps: [], connectors: [] };

/** The words' context for a Project's entries (its Workflow, Tasks and Members by id), and its Tasks. */
export function useFlowContext(project: Project): { ctx: FlowContext; tasks: Map<string, Task> } {
  const record = useWorkflow(project.key);
  const drawn = useEditingCanvas(record.data);
  const tasks = useTaskMap(project.key);
  const members = useMembers();
  return useMemo(() => {
    const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
    const ctx: FlowContext = { projectId: project.id, workflow: drawn ?? none, task: (id) => tasks.get(id), member: (id) => byId.get(id) };
    return { ctx, tasks };
  }, [project.id, drawn, tasks, members.data]);
}

// Which Projects' What's happening was opened by hand while quiet: the page then gives it its
// column back. Kept for the page's life, shared by the panel and the page that lays it out.
const openedWhileQuiet = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
function setOpened(project: string, opened: boolean) {
  if (opened === openedWhileQuiet.has(project)) return;
  if (opened) openedWhileQuiet.add(project);
  else openedWhileQuiet.delete(project);
  for (const l of listeners) l();
}
function useOpened(project: string): boolean {
  return useSyncExternalStore(subscribe, () => openedWhileQuiet.has(project));
}

export type Stories = {
  ctx: FlowContext;
  /** The Project's Tasks by id, ended ones included. */
  tasks: Map<string, Task>;
  stories: Story[];
  /** The newest story whatever its age, for the quiet line. */
  latest: Story | undefined;
  seen: Seen | undefined;
  /** No change in the last hour nor since the Member looked, and not opened by hand. */
  quiet: boolean;
  /** Opens the column while quiet, or folds it again. */
  setOpened: (opened: boolean) => void;
  /** The newest entry the page shows: the mark when the Member leaves. */
  newestSeq: number | undefined;
  loading: boolean;
  error: Error | null;
};

/** What's happening in `project`: its stories, the seen mark they divide at, and whether it is quiet. */
export function useStories(project: Project): Stories {
  const { ctx, tasks } = useFlowContext(project);
  const now = useNow();
  const recent = useRecentActivity({ project: project.key, kind: [...flowKinds] }, (e) => aboutThisFlow(e, ctx));
  const seen = useSeen(project.key);
  const needs = useNeeds(project);
  const sessions = useRunnerSessions();
  const opened = useOpened(project.key);
  const entries = recent.entries;
  return useMemo(() => {
    const seenSeq = seen?.seq ?? null;
    const input = {
      entries,
      tasks,
      ctx,
      exclude: needs.taskIds,
      sessions: sessions.data?.items ?? [],
      now,
      from: startOfDay(now),
      seenSeq,
    };
    const stories = storiesOf(input);
    const latest = storiesOf({ ...input, exclude: new Set(), from: 0, seenSeq: Number.MAX_SAFE_INTEGER })[0];
    const quietNow = isQuiet(entries, now, seenSeq);
    return {
      ctx,
      tasks,
      stories,
      latest,
      seen,
      quiet: quietNow && !opened,
      setOpened: (o: boolean) => setOpened(project.key, o),
      newestSeq: entries[0]?.seq,
      loading: recent.query.isPending && !recent.query.isError,
      error: recent.query.error,
    };
  }, [entries, ctx, tasks, needs.taskIds, sessions.data, now, seen, opened, project.key, recent.query.isPending, recent.query.isError, recent.query.error]);
}

/**
 * Whether `project`'s What's happening is folded to its one quiet line: no change in the last hour
 * nor since the Member last looked, and not opened by hand. The page lets Needs you take the full
 * width while it is.
 */
export function useStoriesQuiet(project: Project): boolean {
  return useStories(project).quiet;
}
