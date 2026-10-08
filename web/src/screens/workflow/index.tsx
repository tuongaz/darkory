import { CheckIcon, LoaderIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { projectPath, projectSettingsPath, useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { Content, TopBar } from "@/app/TopBar";
import { Button } from "@/components/ui/button";
import type { CanvasSelection } from "@/components/workflow/WorkflowCanvas";
import { useCurrentMe } from "@/me";
import { EditingWorkflow } from "./Editing";
import { addStep } from "./edits";
import { useLineData } from "@/components/workflowLine";
import { taskPath as taskPagePath } from "@/screens/task/format";
import { LiveWorkflow } from "./Live";
import { useLineView, useScopeParam } from "./lineView";
import { LineViewSwitch } from "./LineViewSwitch";
import { ScopeChip } from "./ScopeChip";
import { stepParam } from "./StepPeek";
import { useWorkflowEditor } from "./useEditor";
import { useWorkflowView, type WorkflowView } from "./view";
import { ViewSwitch } from "./ViewSwitch";

/**
 * /projects/:key/workflow: the Project's Workflow, live, as one line with its panels; `?scope=`
 * narrows it to the Tasks with no Parent, a Parent's Subtasks or one Task, `?view=` swaps the
 * line for the Blocking among its Tasks or a list.
 */
export function WorkflowPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  const [view, setView] = useLineView();
  const [scope, setScope] = useScopeParam();
  const { data } = useLineData(project.key, scope);
  const named = data && (data.scope.kind === "parent" || data.scope.kind === "task") ? (data.all.find((t) => t.id === (data.scope as { id: string }).id) ?? data.parents.find((p) => p.id === (data.scope as { id: string }).id)) : undefined;
  return (
    <>
      <TopBar
        crumbs={[projectCrumb(project), { label: "Workflow" }, ...(data ? [{ label: <ScopeChip data={data} onScope={setScope} />, wide: true }] : [])]}
        view={<LineViewSwitch view={view} onChange={setView} blocking={data?.blocking ?? 0} />}
        actions={
          <>
            {data && data.scoped.hiddenTotal > 0 && data.scope.kind !== "all" && (
              <span className="hidden text-xs text-muted-foreground tabular-nums lg:inline">{data.scoped.hiddenTotal} hidden</span>
            )}
            {named && named.key !== "…" && (
              <Button asChild variant="outline" className="hidden sm:inline-flex">
                <Link to={taskPagePath(named.key)}>Open {named.key}</Link>
              </Button>
            )}
            {admin && (
              <Button asChild variant="outline">
                <Link to={projectSettingsPath(project, "workflow")} aria-label="Edit the Workflow">
                  <PencilIcon />
                  <span className="hidden sm:inline">Edit</span>
                </Link>
              </Button>
            )}
          </>
        }
      />
      <Content className="flex flex-col overflow-hidden">
        <LiveWorkflow project={project} view={view} scope={scope} onView={setView} />
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
          <LiveWorkflow project={project} view={view === "text" ? "text" : "line"} scope={null} />
        </Content>
      </>
    );
  }
  return <EditingPage view={view} setView={setView} />;
}

function EditingPage({ view, setView }: { view: WorkflowView; setView: (v: WorkflowView) => void }) {
  const project = useRouteProject();
  const editor = useWorkflowEditor(project.key);
  // `?step=<id>` opens with that Step selected: Edit in Settings from the live canvas.
  const [params] = useSearchParams();
  const [picked, setPicked] = useState<CanvasSelection>(() => {
    const id = params.get(stepParam);
    return id ? { kind: "step", id } : null;
  });
  const add = () => {
    let made: string | undefined;
    editor.apply((wf) => {
      const change = addStep(wf);
      made = change.select;
      return change;
    });
    if (made) setPicked({ kind: "step", id: made });
  };
  return (
    <>
      <TopBar
        crumbs={settingsCrumbs(project.name)}
        view={<ViewSwitch view={view} onChange={setView} />}
        actions={
          (editor.saving || editor.touched) && (
            <span role="status" aria-label={editor.saving ? "Saving…" : "Saved"} className="flex items-center gap-1 text-xs text-muted-foreground">
              {editor.saving ? <LoaderIcon aria-hidden className="size-3.5 animate-spin" /> : <CheckIcon aria-hidden className="size-3.5" />}
              <span className="sr-only sm:not-sr-only">{editor.saving ? "Saving…" : "Saved"}</span>
            </span>
          )
        }
        primary={
          <Button aria-label="Add Step" disabled={!editor.workflow} onClick={add}>
            <PlusIcon />
            <span className="hidden sm:inline">Add Step</span>
          </Button>
        }
      />
      <Content className="flex flex-col overflow-hidden">
        <EditingWorkflow project={project} view={view} editor={editor} picked={picked} setPicked={setPicked} />
      </Content>
    </>
  );
}
