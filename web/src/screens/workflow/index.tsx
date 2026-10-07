import { useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { PlaceholderPage } from "@/app/Placeholder";

// M4c builds this folder: the Workflow canvas live (the Project's Workflow page) and in editing
// mode (the Project's Settings › Workflow). These stand in until then.

const owner = "M4c (Workflow canvas)";

/** /projects/:key/workflow: the Project's Workflow, live and read-only. */
export function WorkflowPage() {
  const project = useRouteProject();
  return <PlaceholderPage title="Workflow" owner={owner} crumbs={[projectCrumb(project), { label: "Workflow" }]} />;
}

/** /settings/projects/:key/workflow: the same canvas, editing, inside the Settings frame. */
export function WorkflowSettingsPage() {
  const project = useRouteProject();
  return (
    <PlaceholderPage
      title="Workflow"
      owner={owner}
      crumbs={[{ label: "Settings" }, { label: project.name, wide: true }, { label: "Workflow" }]}
    />
  );
}
