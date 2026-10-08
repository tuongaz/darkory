import { CheckIcon, LoaderIcon, PencilIcon, PlusIcon } from "lucide-react";
import { Link } from "react-router";
import { projectPath, projectSettingsPath, useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { Content, TopBar } from "@/app/TopBar";
import { Button } from "@/components/ui/button";
import { useCurrentMe } from "@/me";
import { EditingWorkflow } from "./Editing";
import { addStep } from "./edits";
import { LiveWorkflow } from "./Live";
import { useWorkflowEditor } from "./useEditor";
import { useWorkflowView, type WorkflowView } from "./view";
import { ViewSwitch } from "./ViewSwitch";

/** /projects/:key/workflow: the Project's Workflow, live and read-only; a Step opens its peek. */
export function WorkflowPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  const [view, setView] = useWorkflowView();
  return (
    <>
      <TopBar
        crumbs={[projectCrumb(project), { label: "Workflow" }]}
        view={<ViewSwitch view={view} onChange={setView} />}
        actions={
          admin && (
            <Button asChild variant="outline">
              <Link to={projectSettingsPath(project, "workflow")}>
                <PencilIcon />
                <span className="hidden sm:inline">Edit</span>
                <span className="sr-only sm:hidden">Edit the Workflow</span>
              </Link>
            </Button>
          )
        }
      />
      <Content className="flex flex-col overflow-hidden">
        <LiveWorkflow project={project} view={view} />
      </Content>
    </>
  );
}

const settingsCrumbs = (name: string) => [{ label: "Settings" }, { label: name, wide: true }, { label: "Workflow" }];

/**
 * /settings/projects/:key/workflow: the same Workflow, editing, for an admin. Anyone else sees it
 * live, with a line saying only an admin changes it.
 */
export function WorkflowSettingsPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  const [view, setView] = useWorkflowView();
  if (!admin) {
    return (
      <>
        <TopBar crumbs={settingsCrumbs(project.name)} view={<ViewSwitch view={view} onChange={setView} />} />
        <p className="border-b bg-muted/50 px-4 py-2 text-muted-foreground sm:px-6">
          Only an admin changes {project.name}'s Workflow; this is how it stands.{" "}
          <Link to={projectPath(project, "workflow")} className="text-foreground underline-offset-2 hover:underline">
            Open it in {project.name}
          </Link>
        </p>
        <Content className="flex flex-col overflow-hidden">
          <LiveWorkflow project={project} view={view} />
        </Content>
      </>
    );
  }
  return <EditingPage view={view} setView={setView} />;
}

function EditingPage({ view, setView }: { view: WorkflowView; setView: (v: WorkflowView) => void }) {
  const project = useRouteProject();
  const editor = useWorkflowEditor(project.key);
  return (
    <>
      <TopBar
        crumbs={settingsCrumbs(project.name)}
        view={<ViewSwitch view={view} onChange={setView} />}
        actions={
          editor.workflow && (
            <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
              {editor.saving ? <LoaderIcon aria-hidden className="size-3.5 animate-spin" /> : <CheckIcon aria-hidden className="size-3.5" />}
              <span className="hidden sm:inline">{editor.saving ? "Saving…" : "Saved"}</span>
              <span className="sr-only sm:hidden">{editor.saving ? "Saving…" : "Saved"}</span>
            </span>
          )
        }
        primary={
          <Button disabled={!editor.workflow} onClick={() => editor.apply((wf) => addStep(wf))}>
            <PlusIcon />
            <span className="hidden sm:inline">Add step</span>
            <span className="sr-only sm:hidden">Add step</span>
          </Button>
        }
      />
      <Content className="flex flex-col overflow-hidden">
        <EditingWorkflow project={project} view={view} editor={editor} />
      </Content>
    </>
  );
}
