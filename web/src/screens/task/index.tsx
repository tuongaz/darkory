import { useParams } from "react-router";
import { useProjects, useTask } from "@/api/queries";
import { findProject, projectPath, useReportProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { PlaceholderPage } from "@/app/Placeholder";
import { Key } from "@/components/Key";
import { Peek } from "@/components/Peek";

// M4b builds this folder: the Task page, its peek, and the Subtask graph. These stand in until
// then; they already report the Task's Project, so the sidebar follows the record.

const owner = "M4b (Task page and peek)";

/** /tasks/:task: a Task's page. */
export function TaskPage() {
  const { task: key = "" } = useParams();
  const detail = useTask(key);
  const task = detail.data?.task;
  useReportProject(task?.project_id);
  const project = findProject(useProjects().data ?? [], task?.project_id);
  return (
    <PlaceholderPage
      title={task?.title ?? key}
      owner={owner}
      crumbs={project ? [projectCrumb(project), { label: "Tasks", to: projectPath(project, "tasks"), wide: true }, { label: key }] : [{ label: key }]}
    />
  );
}

/** ?task=<key> over any page: the Task's peek. */
export function TaskPeek({ taskKey, onClose }: { taskKey: string; onClose: () => void }) {
  const detail = useTask(taskKey);
  useReportProject(detail.data?.task.project_id);
  return (
    <Peek open onOpenChange={(o) => !o && onClose()} label={`Task ${taskKey}`} heading={<Key to={`/tasks/${taskKey}`}>{taskKey}</Key>}>
      <p className="text-muted-foreground">
        {detail.data?.task.title} Built by {owner}.
      </p>
    </Peek>
  );
}
