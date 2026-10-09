import type { Connector, Workflow, WorkflowStep } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { stepTitle } from "@/components/workflowLine/model";

/** A Member's name for a sentence, by id. */
export function useMemberName(): (id: string | undefined) => string {
  const { members } = useDirectory();
  return (id) => (id && members.get(id)?.name) || "Unknown";
}

/** A Skill's name, by id. */
export function useSkillName(): (id: string | undefined) => string | undefined {
  const { skills } = useDirectory();
  return (id) => (id ? skills.get(id)?.name : undefined);
}

export function taskPath(key: string): string {
  return `/tasks/${encodeURIComponent(key)}`;
}

/** "70 B", "12 KB", "3.4 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const day = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "Today" or "Mon 6 Oct": the heading of a run of record entries. */
export function dayText(at: string, now: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString() ? "Today" : day.format(d);
}

/** The Project line narrowed to one Task: `/projects/:key/workflow?scope=<id>`. */
export function workflowScopePath(project: { key: string }, taskId: string): string {
  return `/projects/${project.key}/workflow?scope=${encodeURIComponent(taskId)}`;
}

/**
 * Where a Connector out of the Step `from` leads, as Advance names it: Done; a Step of the same
 * Workflow by its name; another Workflow's as `Bugs › Investigate`.
 */
export function advanceTarget(
  connector: Pick<Connector, "to_step_id">,
  graph: { workflows: readonly Pick<Workflow, "id" | "name">[]; steps: readonly Pick<WorkflowStep, "id" | "name" | "workflow_id">[]; from?: string },
): string {
  if (!connector.to_step_id) return "Done";
  const to = graph.steps.find((s) => s.id === connector.to_step_id);
  if (!to) return "its next Step";
  return stepTitle(to, graph.workflows, graph.steps.find((s) => s.id === graph.from)?.workflow_id ?? to.workflow_id);
}
