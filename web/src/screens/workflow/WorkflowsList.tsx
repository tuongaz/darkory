import { ChevronLeftIcon, ChevronRightIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import type { Project } from "@/api/client";
import { workflowEditPath, workflowsPath } from "@/app/currentProject";
import { useNow } from "@/clock";
import { startOf } from "@/components/filters/dates";
import { Tip } from "@/components/Tip";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useTasks } from "@/api/queries";
import { cn } from "@/lib/utils";
import { MoreMenu } from "@/screens/settings/parts";
import type { WorkflowRecord } from "./bind";
import type { RecordWorkflow } from "./edit/draft";
import type { WorkflowActs } from "./useWorkflowActs";
import { workflowRows } from "./workflowRows";

// Workflow · Steps · Waiting · Working · Done today, the figures right-aligned under their heads;
// for an admin, from `sm` up, Order (‹ ›) and the acts (✎ 🗑), and below `sm` one ⋯ in their place.
// A phone's figure columns are the same for every Member (measured so "Prototypes" reads whole
// beside the admin's ⋯); the admin's grid only adds the ⋯.
const cols = (admin: boolean) =>
  cn(
    "grid gap-1.5 px-4 sm:gap-3 sm:px-6",
    admin
      ? "grid-cols-[minmax(0,1fr)_36px_48px_54px_68px_26px] sm:grid-cols-[minmax(0,1fr)_80px_80px_80px_96px_64px_72px]"
      : "grid-cols-[minmax(0,1fr)_36px_48px_54px_68px] sm:grid-cols-[minmax(0,1fr)_80px_80px_80px_96px]",
  );
const figure = "text-right tabular-nums";
// The act cells sit over the row's link, so a click on them is theirs.
const wide = "relative z-10 hidden items-center sm:flex";
const narrow = "relative z-10 flex items-center justify-end sm:hidden";

/** What the list does for an admin: the acts, and the Workflow the delete asks about. */
type Acts = Pick<WorkflowActs, "busy" | "skillMap" | "move"> & { onDelete: (w: RecordWorkflow) => void };

/**
 * /projects/:key/workflows: a row per Workflow, in order, with its figures; a row opens that
 * Workflow's page. With `acts` (an admin), each row also orders its Workflow, opens its editor and
 * deletes it, the last Workflow staying.
 */
export function WorkflowsList({ project, graph, acts }: { project: Project; graph: WorkflowRecord; acts?: Acts }) {
  const now = useNow();
  // The same read as the line's "N today": what reached Done since midnight.
  const done = useTasks({ project: project.key, state: "done", filter: [`completed_at:gte:${startOf(new Date(now))}`] });
  const rows = useMemo(() => workflowRows(graph, done.data ?? []), [graph, done.data]);
  const admin = !!acts;
  return (
    <div role="table" aria-label="Workflows" className="min-w-0 text-[13px]">
      <div role="row" className={cn(cols(admin), "h-8 items-center border-b text-xs font-medium text-muted-foreground")}>
        <span role="columnheader">Workflow</span>
        <span role="columnheader" className={figure}>
          Steps
        </span>
        <span role="columnheader" className={figure}>
          Waiting
        </span>
        <span role="columnheader" className={figure}>
          Working
        </span>
        <span role="columnheader" className={figure}>
          Done today
        </span>
        {admin && (
          <>
            <span role="columnheader" className="hidden sm:block">
              <span className="sr-only">Order</span>
            </span>
            <span role="columnheader" className="hidden sm:block">
              <span className="sr-only">Edit or delete</span>
            </span>
            <span role="columnheader" className="sm:hidden">
              <span className="sr-only">More</span>
            </span>
          </>
        )}
      </div>
      {rows.map((r, i) => (
        <div role="row" key={r.id} aria-label={r.name} className={cn(cols(admin), "relative h-9 items-center border-b hover:bg-accent/60")}>
          <span role="cell" className="flex min-w-0 items-center gap-1">
            <Link to={workflowsPath(project, r.id)} className="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline">
              {r.name}
            </Link>
            <ChevronRightIcon aria-hidden className="size-3.5 flex-none text-muted-foreground" />
          </span>
          <Figure n={r.steps} />
          <Figure n={r.waiting} />
          <Figure n={r.working} />
          <Figure n={done.data ? r.doneToday : undefined} />
          {acts && <RowActs project={project} graph={graph} acts={acts} name={r.name} id={r.id} earlier={rows[i - 1]?.id} later={rows[i + 1]?.id} last={rows.length < 2} />}
        </div>
      ))}
    </div>
  );
}

/**
 * One row's acts: ‹ › (order) and ✎ 🗑 from `sm` up, the same four in one ⋯ below it. `earlier` and
 * `later` are the neighbours' ids; `last` keeps the only Workflow from being deleted.
 */
function RowActs({
  project,
  graph,
  acts,
  name,
  id,
  earlier: before,
  later: after,
  last,
}: {
  project: Project;
  graph: WorkflowRecord;
  acts: Acts;
  name: string;
  id: string;
  earlier?: string;
  later?: string;
  last: boolean;
}) {
  const find = (x: string | undefined) => (x ? graph.workflows.find((w) => w.id === x) : undefined);
  const w = find(id)!;
  const earlier = find(before);
  const later = find(after);
  const ordering = acts.busy || !acts.skillMap;
  const edit = workflowEditPath(project, id);
  // Why the delete is off, said on the control: the last Workflow stays; a write is on its way.
  const keep = last ? "The last Workflow stays" : acts.busy ? "Saving…" : undefined;
  return (
    <>
      <span role="cell" className={cn(wide, "justify-center")}>
        <ActButton label={`Move ${name} earlier`} disabled={ordering || !earlier} onClick={() => earlier && acts.move(w, earlier, -1)}>
          <ChevronLeftIcon />
        </ActButton>
        <ActButton label={`Move ${name} later`} disabled={ordering || !later} onClick={() => later && acts.move(w, later, 1)}>
          <ChevronRightIcon />
        </ActButton>
      </span>
      <span role="cell" className={cn(wide, "justify-end")}>
        <Tip label={`Edit ${name}`}>
          <Link to={edit} aria-label={`Edit ${name}`} className={act}>
            <PencilIcon />
          </Link>
        </Tip>
        <ActButton label={`Delete ${name}`} why={keep} disabled={!!keep} onClick={() => acts.onDelete(w)}>
          <Trash2Icon />
        </ActButton>
      </span>
      <span role="cell" className={narrow}>
        <MoreMenu label={`More for ${name}`} size="icon-xs">
          <DropdownMenuItem asChild>
            <Link to={edit}>Edit</Link>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={ordering || !earlier} onSelect={() => earlier && acts.move(w, earlier, -1)}>
            Move earlier
          </DropdownMenuItem>
          <DropdownMenuItem disabled={ordering || !later} onSelect={() => later && acts.move(w, later, 1)}>
            Move later
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={!!keep} onSelect={() => acts.onDelete(w)}>
            Delete
            {keep && <span className="ml-auto pl-3 text-xs font-normal text-muted-foreground">{keep}</span>}
          </DropdownMenuItem>
        </MoreMenu>
      </span>
    </>
  );
}

function Figure({ n }: { n: number | undefined }) {
  return (
    <span role="cell" className={cn(figure, (n === undefined || n === 0) && "text-muted-foreground")}>
      {n ?? "…"}
    </span>
  );
}

const act =
  "inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5";

/** `why` says on the control why it is off: a disabled button takes no hover, so the Tip sits on a focusable wrapper. */
function ActButton({ label, why, disabled, onClick, children }: { label: string; why?: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  const button = (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={act}>
      {children}
    </button>
  );
  if (disabled && why) {
    return (
      <Tip label={why}>
        <span tabIndex={0} className="inline-flex rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {button}
        </span>
      </Tip>
    );
  }
  return <Tip label={label}>{button}</Tip>;
}
