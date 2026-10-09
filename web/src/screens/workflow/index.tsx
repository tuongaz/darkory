import { LoaderIcon, PencilIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useSkills, useTasks, useWorkflow } from "@/api/queries";
import { remember, workflowParam } from "@/components/pickedWorkflow";
import { Skeleton } from "@/components/ui/skeleton";
import { workflowsInOrder } from "@/components/workflowLine/model";
import { WorkflowChip } from "@/components/WorkflowChip";
import { projectPath, projectSettingsPath, useRouteProject, workflowsPath, workflowsSettingsPath } from "@/app/currentProject";
import { NotFound } from "@/app/NotFound";
import { projectCrumb } from "@/app/crumbs";
import { Content, TopBar } from "@/app/TopBar";
import { FormDialog } from "@/components/FormDialog";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { useCurrentMe } from "@/me";
import { FilterChipRow, FilterMenuButton } from "@/components/filters/FilterBar";
import { useTaskFilter } from "@/components/filters/useTaskFilter";
import { useBlockingCount } from "@/components/workflow/blocking";
import { useLineData } from "@/components/workflowLine";
import { taskPath as taskPagePath } from "@/screens/task/format";
import { fromRecord } from "./edit/draft";
import { useDraftEditor } from "./edit/useDraft";
import { useEditorWorkflow } from "./edit/useEditorWorkflow";
import { same } from "./bind";
import { EditingWorkflow } from "./Editing";
import { LiveWorkflow } from "./Live";
import { useLineView, useScopeParam } from "./lineView";
import { LineViewSwitch } from "./LineViewSwitch";
import { ScopeChip } from "./ScopeChip";
import { WorkflowsList } from "./WorkflowsList";
import { useGoToWorkflow, useWorkflowSegment, workflowNamed } from "./routeWorkflow";
import { stepParam } from "./StepPeek";
import { ChangesChip } from "./edit/Changes";
import { toShort } from "@/lib/shortid";

/**
 * /projects/:key/workflows: of a Project of two or more, its Workflows as a list, each row opening
 * that Workflow's page; of a Project of one, that Workflow's page in place. A `?workflow=` (an
 * address of the board's kind) opens the page of the Workflow it names.
 */
export function WorkflowsPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  const query = useWorkflow(project.key);
  const { search } = useLocation();
  const graph = query.data;
  if (graph && graph.workflows.length < 2) return <WorkflowPage />;
  const params = new URLSearchParams(search);
  const named = params.get(workflowParam);
  const asked = named && graph ? workflowNamed(graph.workflows, named) : undefined;
  if (asked) {
    params.delete(workflowParam);
    const rest = params.toString();
    return <Navigate to={{ pathname: workflowsPath(project, asked.id), search: rest ? `?${rest}` : "" }} replace />;
  }
  return (
    <>
      <TopBar
        crumbs={[projectCrumb(project), { label: "Workflows" }]}
        actions={
          admin && (
            <Button asChild variant="outline">
              <Link to={projectSettingsPath(project, "workflows")} aria-label="Edit the Workflows">
                <PencilIcon />
                <span className="hidden sm:inline">Edit</span>
              </Link>
            </Button>
          )
        }
      />
      <Content className="overflow-auto">
        {query.isError ? (
          <Refusal error={query.error} className="m-6" />
        ) : graph ? (
          <WorkflowsList project={project} graph={graph} />
        ) : (
          <Skeleton aria-label="Loading the Workflows" className="m-6 h-[180px]" />
        )}
      </Content>
    </>
  );
}

/**
 * /projects/:key/workflows/:workflow: one Workflow of the Project, live, as one line with its
 * panels (and /projects/:key/workflows of a Project of one). Of a Project of several, the chip in
 * the breadcrumb goes to another's page, remembered as the board's pick. `?scope=` narrows it to
 * the Tasks with no Parent, a Parent's Subtasks or one Task, `?view=` swaps the line for the
 * Blocking among its Tasks or a list.
 */
export function WorkflowPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  const [view, setView] = useLineView();
  const [scope, setScope] = useScopeParam();
  const tasks = useTasks({ project: project.key, state: "open" }).data;
  const filter = useTaskFilter({ projects: [project], tasks });
  const workflows = useWorkflow(project.key).data?.workflows;
  const segment = useWorkflowSegment();
  const several = !!workflows && workflows.length > 1;
  // The Workflow the address names; of a Project of one, its one.
  const shown = workflows && (segment ? workflowNamed(workflows, segment) : workflowsInOrder(workflows)[0]);
  const goTo = useGoToWorkflow((id) => workflowsPath(project, id), project);
  const { data } = useLineData(project.key, shown?.id, scope, filter.matches);
  const blocking = useBlockingCount(project, data?.scope.kind === "parent" ? data.scope.id : undefined, data?.shown);
  // A Task scoped to stays in scope across a pick only where it is listed, as on the board; a
  // Parent also where one of its open Subtasks is on the line, as the scope menu offers it.
  const pick = (next: string) => {
    const scope = data?.scope;
    const scoped = scope && (scope.kind === "parent" || scope.kind === "task") ? scope.id : undefined;
    const at = scoped ? data?.shown?.of(scoped) : undefined;
    const working = scope?.kind === "parent" && !!data?.shown?.lines(scope.id).has(next);
    goTo(next, { also: at && !at.has(next) && !working ? (p) => p.delete("scope") : undefined, replace: next === shown?.id });
  };
  if (segment && workflows && !shown) return <NotFound />;
  const named = data && (data.scope.kind === "parent" || data.scope.kind === "task") ? (data.all.find((t) => t.id === (data.scope as { id: string }).id) ?? data.parents.find((p) => p.id === (data.scope as { id: string }).id)) : undefined;
  return (
    <>
      <TopBar
        crumbs={[
          projectCrumb(project),
          // Back to the list; on a phone it gives its room to the Project's mark and the chip.
          { label: "Workflows", to: segment ? workflowsPath(project) : undefined, wide: several },
          // The Workflow drawn, at every width: on a phone too it is the way to another.
          ...(several ? [{ label: <WorkflowChip workflows={workflows} picked={shown?.id} onPick={pick} />, whole: true }] : []),
          ...(data ? [{ label: <ScopeChip data={data} onScope={setScope} />, wide: true }] : []),
        ]}
        view={<LineViewSwitch view={view} onChange={setView} blocking={blocking} />}
        actions={
          <>
            {data && data.scoped.hiddenTotal > 0 && (
              <span className="hidden text-xs text-muted-foreground tabular-nums lg:inline">{data.scoped.hiddenTotal} hidden</span>
            )}
            {named && named.key !== "…" && (
              <Button asChild variant="outline" className="hidden sm:inline-flex">
                <Link to={taskPagePath(named.key)}>Open {named.key}</Link>
              </Button>
            )}
            {view === "line" && <FilterMenuButton {...filter.bar} open={filter.open} onOpenChange={filter.setOpen} />}
            {admin && (
              <Button asChild variant="outline">
                {/* This Workflow's editor; a Project of one names no Workflow, so its Edit says Workflows. */}
                <Link to={workflowsSettingsPath(project, shown?.id)} aria-label={several && shown ? `Edit ${shown.name}` : "Edit the Workflows"}>
                  <PencilIcon />
                  <span className="hidden sm:inline">Edit</span>
                </Link>
              </Button>
            )}
          </>
        }
      />
      <Content className="flex flex-col overflow-hidden">
        {view === "line" && <FilterChipRow {...filter.bar} />}
        <LiveWorkflow project={project} workflowId={shown?.id} view={view} scope={scope} onView={setView} filter={filter.matches} />
      </Content>
    </>
  );
}

const settingsCrumbs = (name: string) => [{ label: "Settings" }, { label: name, wide: true }, { label: "Workflows" }];

/**
 * /settings/projects/:key/workflows: the Workflows as a plain list, editing, for an admin; saved
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
        <Link to={projectPath(project, "workflows")} className="text-foreground underline-offset-2 hover:underline">
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
  const editor = useDraftEditor(project.key, project.name);
  const navigate = useNavigate();
  // `?step=<id>` opens with that Step's name in focus: Edit from the live page.
  const [params] = useSearchParams();
  const [focusStep] = useState(() => {
    const id = params.get(stepParam);
    return id ? toShort(id) : undefined; // an old link's long id reads as the short one
  });
  const [discarding, setDiscarding] = useState(false);
  const live = projectPath(project, "workflows");
  const shown = useEditorWorkflow(project, editor.draft);
  const save = async () => {
    // The Workflow edited, by name: a new one has its id only once saved.
    const editing = editor.draft?.wf.workflows.find((w) => w.id === shown.id)?.name;
    const reply = await editor.save();
    if (!reply) return;
    toast(`Saved ${project.name}'s Workflow`);
    const saved = editing === undefined ? undefined : reply.workflows.find((w) => same(w.name, editing));
    if (saved && reply.workflows.length > 1) {
      remember(project.key, saved.id);
      navigate(workflowsPath(project, saved.id));
    } else navigate(live);
  };
  const n = editor.changes;
  return (
    <>
      <TopBar
        crumbs={settingsCrumbs(project.name)}
        view={<ChangesChip editor={editor} />}
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
