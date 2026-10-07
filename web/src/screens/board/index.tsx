import { useState } from "react";
import { useCurrentProject, useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { useIntent, type Intent } from "@/app/intents";
import { PlaceholderPage } from "@/app/Placeholder";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { Input } from "@/components/ui/input";

// M4b builds this folder: the Project's Tasks as a list and a board (`?view=list|board`), and
// the File a Task dialog the shell's `file-task` intent opens. These stand in until then.

const owner = "M4b (Tasks list and board)";

/** /projects/:key/tasks: the Project's Tasks, grouped by Step; `?view=board` its board. */
export function TasksPage() {
  const project = useRouteProject();
  return <PlaceholderPage title="Tasks" owner={owner} crumbs={[projectCrumb(project, false), { label: "Tasks" }]} />;
}

/** The dialogs the shell mounts once over every page: File a Task, for the `file-task` intent. */
export function BoardDialogs() {
  const [intent, setIntent] = useState<Extract<Intent, { kind: "file-task" }> | null>(null);
  useIntent("file-task", setIntent);
  const current = useCurrentProject();
  if (!intent) return null;
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && setIntent(null)}
      title="File a Task"
      description={`In ${intent.project ?? current?.key ?? "no Project"}. Built by ${owner}.`}
      submitLabel="File Task"
      submitDisabled
      onSubmit={() => {}}
    >
      <FormRows>
        <FormRow label="Title" htmlFor="file-task-title">
          <Input id="file-task-title" defaultValue={intent.title ?? ""} autoFocus />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}
