import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { invalidateAll, keys, useWorkflow } from "@/api/queries";
import { setWorkflow } from "@/api/writes";
import { useRouteProject, workflowsSettingsPath } from "@/app/currentProject";
import { Refusal } from "@/components/Refusal";
import { Tip } from "@/components/Tip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { refusalToast } from "@/screens/inbox/toast";
import { SettingsFrame } from "@/screens/settings/frame";
import { same, type WorkflowRecord } from "./bind";
import { DeleteWorkflowDialog } from "./edit/DeleteWorkflow";
import { addWorkflow, deleteWorkflow, fromRecord, moveWorkflowTo, problem, saveBody, stepsIn, workflowsOf, type Draft, type RecordWorkflow } from "./edit/draft";
import type { EditorState } from "./routeWorkflow";

// Workflow · Steps · Order · delete for an admin; Workflow · Steps for anyone else.
const cols = (admin: boolean) =>
  cn("grid gap-2 px-4 sm:gap-3 sm:px-6", admin ? "grid-cols-[minmax(0,1fr)_48px_60px_32px] sm:grid-cols-[minmax(0,1fr)_80px_80px_40px]" : "grid-cols-[minmax(0,1fr)_48px] sm:grid-cols-[minmax(0,1fr)_80px]");

/**
 * /settings/projects/:key/workflows: the Project's Workflows in their order, always a list, each
 * row opening its editor. An admin adds one (`+ Workflow`, named "Workflow 2", "Workflow 3"…, its
 * editor opened with the name to type), moves one earlier or later (‹ ›) and deletes one (the
 * last stays). Each is written at once, one `PUT …/workflow` of the whole graph, and said in a
 * toast; what `/v1` refuses is said in its words.
 */
export function WorkflowsSettingsPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  const query = useWorkflow(project.key);
  const graph = query.data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<RecordWorkflow | undefined>();
  // One write at a time: the controls wait while one is on its way.
  const write = useMutation({
    mutationFn: (draft: Draft) => setWorkflow(project.key, saveBody(draft)),
    onSuccess: (reply) => {
      qc.setQueryData(keys.workflow(project.key), reply);
      invalidateAll(qc);
    },
    onError: refusalToast,
  });
  const busy = write.isPending;

  /** Writes the graph `edit` makes of the one read; `then` says what it did. */
  const act = (edit: (d: Draft) => Draft, then: (reply: WorkflowRecord, sent: Draft) => void) => {
    if (!graph || busy) return;
    const next = edit(fromRecord(graph));
    const said = problem(next, graph, []);
    if (said) return void toast.error(said);
    write.mutate(next, { onSuccess: (reply) => then(reply, next) });
  };

  const add = () => {
    let made = "";
    act(
      (d) => {
        const r = addWorkflow(d);
        made = r.id;
        return r.draft;
      },
      (reply, sent) => {
        const name = sent.wf.workflows.find((w) => w.id === made)?.name ?? "";
        const saved = reply.workflows.find((w) => same(w.name, name));
        toast(`Added ${name}`);
        if (saved) navigate(workflowsSettingsPath(project, saved.id), { state: { rename: true } satisfies EditorState });
      },
    );
  };
  const move = (w: RecordWorkflow, onto: RecordWorkflow, by: -1 | 1) =>
    act(
      (d) => moveWorkflowTo(d, w.id, onto.id),
      () => toast(`Moved ${w.name} ${by < 0 ? "earlier" : "later"}`),
    );

  const workflows = graph ? workflowsOf(graph) : [];
  return (
    <SettingsFrame
      crumbs={[{ label: project.name, wide: true }, { label: "Workflows" }]}
      pad={false}
      primary={
        admin && (
          <Button onClick={add} disabled={!graph || busy}>
            <PlusIcon />
            Workflow
          </Button>
        )
      }
    >
      {query.isError ? (
        <Refusal error={query.error} className="m-6" />
      ) : !graph ? (
        <Skeleton aria-label="Loading the Workflows" className="m-6 h-[180px]" />
      ) : (
        <div role="table" aria-label="Workflows" className="min-w-0 text-[13px]">
          <div role="row" className={cn(cols(admin), "h-8 items-center border-b text-xs font-medium text-muted-foreground")}>
            <span role="columnheader">Workflow</span>
            <span role="columnheader" className="text-right">
              Steps
            </span>
            {admin && (
              <>
                <span role="columnheader" className="text-center">
                  Order
                </span>
                <span role="columnheader">
                  <span className="sr-only">Delete</span>
                </span>
              </>
            )}
          </div>
          {workflows.map((w, i) => (
            <div role="row" key={w.id} aria-label={w.name} className={cn(cols(admin), "relative h-9 items-center border-b hover:bg-accent/60")}>
              <span role="cell" className="flex min-w-0 items-center gap-1">
                <Link to={workflowsSettingsPath(project, w.id)} className="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline">
                  {w.name}
                </Link>
                <ChevronRightIcon aria-hidden className="size-3.5 flex-none text-muted-foreground" />
              </span>
              <span role="cell" className="text-right tabular-nums">
                {stepsIn(graph, w.id).length}
              </span>
              {admin && (
                <>
                  <span role="cell" className="relative z-10 flex items-center justify-center">
                    <IconButton label={`Move ${w.name} earlier`} disabled={busy || i === 0} onClick={() => move(w, workflows[i - 1], -1)}>
                      <ChevronLeftIcon />
                    </IconButton>
                    <IconButton label={`Move ${w.name} later`} disabled={busy || i === workflows.length - 1} onClick={() => move(w, workflows[i + 1], 1)}>
                      <ChevronRightIcon />
                    </IconButton>
                  </span>
                  <span role="cell" className="relative z-10 flex items-center justify-end">
                    <IconButton label={`Delete ${w.name}`} disabled={busy || workflows.length < 2} onClick={() => setDeleting(w)}>
                      <Trash2Icon />
                    </IconButton>
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {deleting && graph && (
        <DeleteWorkflowDialog
          draft={fromRecord(graph)}
          workflow={deleting}
          onClose={() => setDeleting(undefined)}
          onDelete={(moves, repoint) => {
            const gone = deleting;
            setDeleting(undefined);
            act(
              (d) => deleteWorkflow(d, gone.id, moves, repoint),
              () => toast(`Deleted ${gone.name}`),
            );
          }}
        />
      )}
    </SettingsFrame>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5"
      >
        {children}
      </button>
    </Tip>
  );
}
