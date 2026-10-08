import { LoaderIcon, PencilIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useSkills, useWorkflow } from "@/api/queries";
import { projectPath, projectSettingsPath, useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { Content, TopBar } from "@/app/TopBar";
import { FormDialog } from "@/components/FormDialog";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { useCurrentMe } from "@/me";
import { fromRecord } from "./edit/draft";
import { useDraftEditor } from "./edit/useDraft";
import { EditingWorkflow } from "./Editing";
import { LiveWorkflow } from "./Live";
import { stepParam } from "./StepPeek";
import { useWorkflowView } from "./view";
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
              <Link to={projectSettingsPath(project, "workflow")} aria-label="Edit the Workflow">
                <PencilIcon />
                <span className="hidden sm:inline">Edit</span>
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
 * /settings/projects/:key/workflow: the Workflow as a plain list, editing, for an admin; saved
 * whole on Save. Anyone else reads the same list, with a line saying only an admin changes it.
 */
export function WorkflowSettingsPage() {
  const admin = useCurrentMe().member.admin;
  return admin ? <EditingPage /> : <ReadingPage />;
}

function ReadingPage() {
  const project = useRouteProject();
  const query = useWorkflow(project.key);
  const skills = useSkills();
  const draft = useMemo(() => query.data && fromRecord(query.data), [query.data]);
  return (
    <>
      <TopBar crumbs={settingsCrumbs(project.name)} />
      <p className="border-b bg-muted/50 px-4 py-2 text-muted-foreground sm:px-6">
        Only an admin changes {project.name}'s Workflow; this is how it stands.{" "}
        <Link to={projectPath(project, "workflow")} className="text-foreground underline-offset-2 hover:underline">
          Open it in {project.name}
        </Link>
      </p>
      <Content className="flex flex-col overflow-hidden">
        {query.isError ? <Refusal error={query.error} className="m-6" /> : <EditingWorkflow project={project} draft={draft} base={query.data} skills={skills.data} />}
      </Content>
    </>
  );
}

function EditingPage() {
  const project = useRouteProject();
  const editor = useDraftEditor(project.key);
  const navigate = useNavigate();
  // `?step=<id>` opens with that Step's name in focus: Edit from the live page.
  const [params] = useSearchParams();
  const [focusStep] = useState(() => params.get(stepParam) ?? undefined);
  const [discarding, setDiscarding] = useState(false);
  const live = projectPath(project, "workflow");
  const save = async () => {
    if (await editor.save()) {
      toast(`Saved ${project.name}'s Workflow`);
      navigate(live);
    }
  };
  const n = editor.changes;
  return (
    <>
      <TopBar
        crumbs={settingsCrumbs(project.name)}
        view={
          <span role="status" aria-label="Editing">
            <Pill tone={n > 0 ? "claimed" : "outline"} className="font-normal">
              {n > 0 ? (
                <>
                  <span className="max-sm:sr-only">Editing · </span>
                  {n} {n === 1 ? "change" : "changes"}
                </>
              ) : (
                "Editing"
              )}
            </Pill>
          </span>
        }
        actions={
          <Button variant="outline" onClick={() => (n > 0 ? setDiscarding(true) : navigate(live))}>
            Cancel
          </Button>
        }
        primary={
          <Button disabled={!editor.draft || editor.saving || n === 0} onClick={() => void save()}>
            {editor.saving && <LoaderIcon aria-hidden className="animate-spin" />}
            {editor.saving ? "Saving…" : "Save"}
          </Button>
        }
      />
      <Content className="flex flex-col overflow-hidden">
        <EditingWorkflow project={project} editor={editor} draft={editor.draft} base={editor.base} skills={editor.skills} focusStep={focusStep} />
      </Content>
      {discarding && (
        <FormDialog
          open
          onOpenChange={(o) => !o && setDiscarding(false)}
          title={`Discard ${n} ${n === 1 ? "change" : "changes"}?`}
          description={`${project.name}'s Workflow stays as it was saved.`}
          submitLabel="Discard"
          destructive
          onSubmit={() => navigate(live)}
        >
          {null}
        </FormDialog>
      )}
    </>
  );
}
