import { LoaderIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useSkills, useTasks, useWorkflow } from "@/api/queries";
import { asksForTheLine, workflowParam } from "@/components/pickedWorkflow";
import type { Project } from "@/api/client";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkflowChip } from "@/components/WorkflowChip";
import { useRouteProject, workflowEditPath, workflowsPath } from "@/app/currentProject";
import { NotFound } from "@/app/NotFound";
import { projectCrumb } from "@/app/crumbs";
import { BarAction, Content, TopBar, type Crumb } from "@/app/TopBar";
import { FormDialog } from "@/components/FormDialog";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/Tip";
import { useCurrentMe } from "@/me";
import { FilterChipRow, FilterMenuButton } from "@/components/filters/FilterBar";
import { useTaskFilter } from "@/components/filters/useTaskFilter";
import { useBlockingCount } from "@/components/workflow/blocking";
import { useLineData } from "@/components/workflowLine";
import { taskPath as taskPagePath } from "@/screens/task/format";
import { fromRecord, type RecordWorkflow } from "./edit/draft";
import { DeleteWorkflowDialog } from "./edit/DeleteWorkflow";
import { useDraftEditor } from "./edit/useDraft";
import { useEditorWorkflow } from "./edit/useEditorWorkflow";
import { EditingWorkflow } from "./Editing";
import { LiveWorkflow } from "./Live";
import { useLineView, useScopeParam } from "./lineView";
import { LineViewSwitch } from "./LineViewSwitch";
import { ScopeChip } from "./ScopeChip";
import { WorkflowsList } from "./WorkflowsList";
import { useWorkflowActs } from "./useWorkflowActs";
import { useGoToWorkflow, useWorkflowSegment, workflowNamed, type EditorState } from "./routeWorkflow";
import { stepParam } from "./StepPeek";
import { ChangesChip } from "./edit/Changes";
import { toShort } from "@/lib/shortid";

/**
 * /projects/:key/workflows: the Project's Workflows as a list, a Project of one included, each row
 * opening that Workflow's page. For an admin the list carries its acts (order, edit, delete) and
 * the bar's primary adds a Workflow, each written at once (`useWorkflowActs`). A `?workflow=` (an
 * address of the board's kind) opens the page of the Workflow it names; of a Project of one, an
 * address saying what only a Workflow's page reads (`asksForTheLine`: a bookmark of round 2, when
 * this address was that one Workflow's page) opens that page, keeping what it says.
 */
export function WorkflowsPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  const acts = useWorkflowActs(project, admin);
  const { query, graph } = acts;
  const [deleting, setDeleting] = useState<RecordWorkflow | undefined>();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const named = params.get(workflowParam);
  const line = !named && asksForTheLine(params);
  // An address that may be one Workflow's page: nothing of the list until the Workflows are read.
  if ((named || line) && !graph && !query.isError) return <Skeleton aria-label="Loading the Workflows" className="m-6 h-[180px]" />;
  const asked = named && graph ? workflowNamed(graph.workflows, named) : undefined;
  if (asked) {
    params.delete(workflowParam);
    const rest = params.toString();
    return <Navigate to={{ pathname: workflowsPath(project, asked.id), search: rest ? `?${rest}` : "" }} replace />;
  }
  const only = line && graph?.workflows.length === 1 ? graph.workflows[0] : undefined;
  if (only) return <Navigate to={{ pathname: workflowsPath(project, only.id), search }} replace />;
  return (
    <>
      <TopBar
        crumbs={[projectCrumb(project), { label: "Workflows" }]}
        primary={
          admin && (
            <BarAction icon={<PlusIcon />} label="Workflow" onClick={acts.add} disabled={!graph || acts.busy} />
          )
        }
      />
      <Content>
        {query.isError ? (
          <Refusal error={query.error} className="m-6" />
        ) : !graph ? (
          <Skeleton aria-label="Loading the Workflows" className="m-6 h-[180px]" />
        ) : (
          <WorkflowsList project={project} graph={graph} acts={admin ? { busy: acts.busy, skillMap: acts.skillMap, move: acts.move, onDelete: setDeleting } : undefined} />
        )}
      </Content>
      {deleting && graph && (
        <DeleteWorkflowDialog
          draft={fromRecord(graph)}
          workflow={deleting}
          onClose={() => setDeleting(undefined)}
          onDelete={(moves, repoint) => {
            const gone = deleting;
            setDeleting(undefined);
            acts.remove(gone, moves, repoint);
          }}
        />
      )}
    </>
  );
}

/**
 * /projects/:key/workflows/:workflow: one Workflow of the Project, live, as one line with its
 * panels. Of a Project of several, the chip in the breadcrumb says which and goes to another's
 * page, remembered as the board's pick; of a Project of one, the last crumb is its name. `?scope=`
 * (the scope chip, on the bar's second row after the view switch) narrows it to the Tasks with no
 * Parent, a Parent's Subtasks or one Task, `?view=` swaps the line for the Blocking among its Tasks
 * or a list.
 */
export function WorkflowPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  const [view, setView] = useLineView();
  const [scope, setScope] = useScopeParam();
  const tasks = useTasks({ project: project.key, state: "open" }).data;
  const filter = useTaskFilter({ projects: [project], tasks });
  const acts = useWorkflowActs(project, admin);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<RecordWorkflow | undefined>();
  const workflows = acts.graph?.workflows;
  const segment = useWorkflowSegment();
  const several = !!workflows && workflows.length > 1;
  // The Workflow the address names (the route always has the segment).
  const shown = workflows && segment ? workflowNamed(workflows, segment) : undefined;
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
  if (!segment || (workflows && !shown)) return <NotFound />;
  const named = data && (data.scope.kind === "parent" || data.scope.kind === "task") ? (data.all.find((t) => t.id === (data.scope as { id: string }).id) ?? data.parents.find((p) => p.id === (data.scope as { id: string }).id)) : undefined;
  return (
    <>
      <TopBar
        crumbs={[
          projectCrumb(project),
          // Back to the list; of several, on a phone it gives its room to the Project's mark and the
          // chip; of one, it stays, the name beside it short.
          { label: "Workflows", to: workflowsPath(project), wide: several },
          // The Workflow drawn, at every width: of several the chip, on a phone too the way to
          // another; of one its name.
          ...(several ? [{ label: <WorkflowChip workflows={workflows} picked={shown?.id} onPick={pick} />, whole: true }] : shown ? [{ label: shown.name }] : []),
        ]}
        view={
          <>
            <LineViewSwitch view={view} onChange={setView} blocking={blocking} />
            {data && <ScopeChip data={data} onScope={setScope} />}
          </>
        }
        actions={
          <>
            {data && data.scoped.hiddenTotal > 0 && (
              <span className="hidden text-xs text-muted-foreground tabular-nums @2xl/page:inline">{data.scoped.hiddenTotal} hidden</span>
            )}
            {named && named.key !== "…" && (
              <Button asChild variant="outline" size="sm" className="hidden text-xs @2xl/page:inline-flex">
                <Link to={taskPagePath(named.key)}>Open {named.key}</Link>
              </Button>
            )}
            {view === "line" && <FilterMenuButton {...filter.bar} open={filter.open} onOpenChange={filter.setOpen} />}
            {admin && shown && (
              <BarAction asChild variant="outline" icon={<PencilIcon />} label="Edit">
                {/* This Workflow's editor, in the app. */}
                <Link to={workflowEditPath(project, shown.id)} aria-label={`Edit ${shown.name}`} />
              </BarAction>
            )}
            {admin && shown && workflows && (
              <DeleteAct
                name={shown.name}
                // Why it is off, said on the control: the last Workflow stays; a write is on its way.
                why={workflows.length < 2 ? "The last Workflow stays" : acts.busy ? "Saving…" : undefined}
                onClick={() => setDeleting(shown)}
              />
            )}
          </>
        }
      />
      <Content className="flex flex-col overflow-hidden">
        {view === "line" && <FilterChipRow {...filter.bar} />}
        <LiveWorkflow project={project} workflowId={shown?.id} view={view} scope={scope} onView={setView} filter={filter.matches} pills={filter.pills} />
      </Content>
      {deleting && acts.graph && (
        <DeleteWorkflowDialog
          draft={fromRecord(acts.graph)}
          workflow={deleting}
          onClose={() => setDeleting(undefined)}
          onDelete={(moves, repoint) => {
            const gone = deleting;
            setDeleting(undefined);
            // The page is gone with it: land on the list.
            acts.remove(gone, moves, repoint, () => navigate(workflowsPath(project)));
          }}
        />
      )}
    </>
  );
}

/** Delete, beside Edit on a Workflow's page; off, it stays focusable (aria-disabled) and says why. */
function DeleteAct({ name, why, onClick }: { name: string; why?: string; onClick: () => void }) {
  return (
    <Tip label={why ?? `Delete ${name}`}>
      <BarAction
        variant="outline"
        icon={<Trash2Icon />}
        label="Delete"
        aria-label={`Delete ${name}`}
        aria-description={why}
        aria-disabled={why ? true : undefined}
        className={why ? "cursor-not-allowed opacity-50" : undefined}
        onClick={why ? undefined : onClick}
      />
    </Tip>
  );
}

/** The crumbs of a Workflow's editor: the Project › Workflows (back to the list) › the Workflow. */
const editorCrumbs = (project: Project, name: string): Crumb[] => [projectCrumb(project), { label: "Workflows", to: workflowsPath(project) }, { label: name }];

/**
 * /projects/:key/workflows/:workflow/edit: one Workflow's editor, for an admin; the draft is the
 * Project's whole graph, saved whole on Save, which lands on the Workflow's page, as Cancel does.
 * Anyone else reads it.
 */
export function WorkflowEditPage() {
  const admin = useCurrentMe().member.admin;
  return admin ? <EditingPage /> : <ReadingPage />;
}

function ReadingPage() {
  const project = useRouteProject();
  const query = useWorkflow(project.key);
  const skills = useSkills();
  const draft = useMemo(() => query.data && fromRecord(query.data), [query.data]);
  const shown = useEditorWorkflow(project, draft, query.data);
  const { search, state } = useLocation();
  if (shown.redirect) return <Navigate to={{ pathname: workflowEditPath(project, shown.redirect), search }} state={state} replace />;
  if (draft && !shown.id) return <NotFound crumbs={editorCrumbs(project, "Not found")} />;
  return (
    <>
      <TopBar crumbs={editorCrumbs(project, shown.workflow?.name.trim() || "…")} />
      <p className="border-b bg-muted/50 px-4 py-2 text-muted-foreground sm:px-6">
        Only an admin changes {project.name}'s Workflows.{" "}
        <Link to={workflowsPath(project, shown.id)} className="text-foreground underline-offset-2 hover:underline">
          Open {shown.workflow?.name ?? "it"} in {project.name}
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
  const { state, search } = useLocation();
  const [focusName] = useState(() => !focusStep && !!(state as EditorState | null)?.rename);
  const [discarding, setDiscarding] = useState(false);
  const shown = useEditorWorkflow(project, editor.draft, editor.base);
  // The Workflow's live page, where Cancel and Discard land.
  const page = workflowsPath(project, shown.id);
  const save = async () => {
    const id = shown.id;
    const reply = await editor.save();
    if (!reply) return;
    const saved = reply.workflows.find((w) => w.id === id);
    toast(`Saved ${saved?.name ?? "the Workflows"}`);
    // That Workflow's live page.
    navigate(workflowsPath(project, saved?.id ?? id));
  };
  const n = editor.changes;
  // The bar's "+ Step": the editor sets what it does (a Step at the end of the line).
  const addStepRef = useRef<(() => void) | null>(null);
  // An address naming the Workflow by name goes to its id first: a rename then keeps the address.
  if (shown.redirect) return <Navigate to={{ pathname: workflowEditPath(project, shown.redirect), search }} state={state} replace />;
  if (editor.draft && !shown.id) return <NotFound crumbs={editorCrumbs(project, "Not found")} />;
  return (
    <>
      <TopBar
        crumbs={editorCrumbs(project, shown.workflow?.name.trim() || "…")}
        view={<BarAction variant="outline" icon={<PlusIcon aria-hidden />} label="Step" aria-label="Add a Step at the end of the line" disabled={!editor.draft} onClick={() => addStepRef.current?.()} />}
        actions={
          <>
            <ChangesChip editor={editor} />
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => (n > 0 ? setDiscarding(true) : navigate(page))}>
              Cancel
            </Button>
          </>
        }
        primary={
          <Button size="sm" className="text-xs" disabled={!editor.draft || editor.saving || n === 0} onClick={() => void save()}>
            {editor.saving && <LoaderIcon aria-hidden className="animate-spin" />}
            {editor.saving ? "Saving…" : "Save"}
          </Button>
        }
      />
      <Content className="flex flex-col overflow-hidden">
        <EditingWorkflow project={project} editor={editor} draft={editor.draft} base={editor.base} skills={editor.skills} focusStep={focusStep} focusName={focusName} addStepRef={addStepRef} />
      </Content>
      {discarding && (
        <FormDialog
          open
          onOpenChange={(o) => !o && setDiscarding(false)}
          title={`Discard ${n} ${n === 1 ? "change" : "changes"}?`}
          description={`${project.name}'s Workflows stay as they were saved.`}
          submitLabel="Discard"
          destructive
          onSubmit={() => navigate(page)}
        >
          {null}
        </FormDialog>
      )}
    </>
  );
}
