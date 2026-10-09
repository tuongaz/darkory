// /projects/:key/tasks?view=list|board: a Project's Tasks as rows grouped by Step, or as a
// kanban whose columns are one Workflow's Steps (picked by the chip, ?workflow=, when the Project
// has two or more), with Views, Filter (its pills in ?filter.tasks=), Display and File Task.
import { BanIcon, ListTodoIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { ApiError, type Task } from "@/api/client";
import { useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { BarAction, Content, TopBar } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import { FilterChipRow, FilterMenuButton } from "@/components/filters/FilterBar";
import { useSavedViews } from "@/components/filters/useSavedViews";
import { useTaskFilter } from "@/components/filters/useTaskFilter";
import { AppliedView, ViewsMenu } from "@/components/filters/ViewsMenu";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { usePickedWorkflow } from "@/components/pickedWorkflow";
import { WorkflowChip } from "@/components/WorkflowChip";
import { Skeleton } from "@/components/ui/skeleton";
import { liveClaim } from "@/work";
import type { Display } from "./derive";
import { boardColumns, columnName, compareTasks, defaultDisplay, dropProblem, groupTasks, listRows, rankFinder, refusalText, type Column } from "./derive";
import { useTasksModel, type TasksModel } from "./model";
import { useMoveTask } from "./queries";
import { expandedKey, foldedKey, openFileTask, useDisplay, useRememberedSet } from "./state";
import { TaskBoard } from "./TaskBoard";
import { TaskList } from "./TaskList";
import { DisplayMenu, ViewSwitch, type Layout } from "./ViewMenus";

export function TasksPage() {
  const project = useRouteProject();
  const [params] = useSearchParams();
  const view: Layout = params.get("view") === "board" ? "board" : "list";
  const model = useTasksModel(project);
  const picked = usePickedWorkflow(project, model.workflow.data?.workflows);
  const [display, changeDisplay] = useDisplay();
  const [expanded, expand] = useRememberedSet(expandedKey);
  const [folded, fold] = useRememberedSet(foldedKey, ["dropped"]);

  const all = model.tasks.data;
  const projects = useMemo(() => [project], [project]);
  // Reset leaves an applied View too: the Views' clear, which needs the Filter's pills first.
  const clear = useRef<() => void>(() => {});
  const filter = useTaskFilter({ projects, tasks: all, trails: model.trails, onClearAll: () => clear.current() });
  // A View keeps the pills, the order as its sort, and the Display with the layout; applying one
  // sets all three.
  const savedViews = useSavedViews({
    entity: "tasks",
    project: project.key,
    fields: filter.fields,
    pills: filter.pills,
    rest: { sort: display.order, display: { ...display, layout: view } },
    restParams: (v, next) => {
      const layout = v.display?.layout;
      if (layout === "list" || layout === "board") next.set("view", layout);
    },
    onApplied: (v) => changeDisplay(displayOf(v.display)),
  });
  useEffect(() => {
    clear.current = savedViews.clear;
  });
  const filtering = filter.pills.length > 0;

  const sorted = useMemo(() => [...(all ?? [])].sort(compareTasks(display.order, rankFinder(model.byId))), [all, display.order, model.byId]);
  // What the Filter keeps. On the list a Parent's row stays while any of its Subtasks passes, and
  // opens to those that do; on the board each card stands or falls by itself.
  const passed = useMemo(() => new Set(sorted.filter(filter.matches).map((t) => t.id)), [sorted, filter.matches]);
  const kept = useMemo(() => {
    const shown = new Map<string, Task[]>();
    for (const [parent, subs] of model.children) shown.set(parent, subs.filter((s) => passed.has(s.id)));
    const rows = sorted.filter((t) => passed.has(t.id) || (shown.get(t.id)?.length ?? 0) > 0);
    return { rows, shown };
  }, [sorted, passed, model.children]);
  const opened = useMemo(() => {
    if (!filtering) return expanded;
    const out = new Set(expanded);
    for (const [parent, subs] of kept.shown) if (subs.length > 0 && !passed.has(parent)) out.add(parent);
    return out;
  }, [filtering, expanded, kept.shown, passed]);

  // The Workflow chip, in the bar on the board of a Project of several Workflows.
  const chip = view === "board" && model.workflows.length > 1;
  const top = (
    <>
      <h1 className="sr-only">{view === "board" ? "Tasks, board" : "Tasks, list"}</h1>
      <TopBar
        crumbs={[
          projectCrumb(project, false),
          // The board shows one Workflow, picked here at every width (a phone has no other way to
          // another); the list, the whole Project.
          ...(chip ? [{ label: <WorkflowChip workflows={model.workflows} picked={picked.id} onPick={picked.set} />, whole: true }] : []),
          { label: "Tasks", wide: true },
        ]}
        view={<ViewSwitch view={view} />}
        actions={
          <>
            <ViewsMenu {...savedViews} />
            <FilterMenuButton {...filter.bar} open={filter.open} onOpenChange={filter.setOpen} />
            <DisplayMenu display={display} change={changeDisplay} view={view} />
          </>
        }
        primary={
          <BarAction icon={<PlusIcon />} label="File Task" onClick={() => openFileTask({ project: project.key })}>
            <Kbd className="hidden h-[18px] min-w-[18px] border-transparent bg-primary-foreground/15 text-[10.5px] text-inherit @2xl/page:inline-flex">C</Kbd>
          </BarAction>
        }
      />
      <FilterChipRow {...filter.bar} leading={savedViews.applied && <AppliedView name={savedViews.applied.name} edited={savedViews.edited} />} />
    </>
  );

  const failed = model.tasks.error ?? model.workflow.error;
  if (failed) {
    return (
      <>
        {top}
        <Content pad>
          <Refusal error={failed} />
        </Content>
      </>
    );
  }
  if (!all || !model.workflow.data) {
    return (
      <>
        {top}
        <Content pad>
          <div className="flex flex-col gap-2" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </Content>
      </>
    );
  }

  const add = (step: string) => openFileTask({ project: project.key, step });
  if (view === "board") {
    return (
      <>
        {top}
        <Content>
          <Board model={model} workflow={picked.id ?? ""} tasks={sorted.filter((t) => passed.has(t.id))} display={display} changeDisplay={changeDisplay} onAdd={add} />
        </Content>
      </>
    );
  }
  if (all.length === 0) {
    return (
      <>
        {top}
        <Content>
          <EmptyState
            icon={<ListTodoIcon />}
            title="No Tasks yet"
            action={
              <Button variant="outline" onClick={() => openFileTask({ project: project.key })}>
                <PlusIcon />
                File Task
              </Button>
            }
          >
            A Task starts at a Step of {project.name}&apos;s Workflow.
          </EmptyState>
        </Content>
      </>
    );
  }
  const rows = listRows(kept.rows, display);
  const groups = groupTasks(rows, display.group, {
    steps: model.steps,
    children: model.children,
    members: model.members,
    labels: model.labelById,
    byId: model.byId,
  });
  return (
    <>
      {top}
      <Content>
        <TaskList
          model={model}
          groups={groups}
          expanded={opened}
          shownSubtasks={filtering ? kept.shown : undefined}
          onExpand={expand}
          folded={folded}
          onFold={fold}
          subtasks={display.showSubtasks}
          showStep={display.group !== "step"}
          onAdd={add}
          footer={footerText(all, rows, display.group === "parent", filtering)}
        />
      </Content>
    </>
  );
}

/** "18 Tasks · 4 Subtasks · Dropped hidden (2)". */
function footerText(all: Task[], rows: Task[], bySubtask: boolean, filtering: boolean): string {
  const top = all.filter((t) => !t.parent_id);
  const parts = [`${rows.length} ${rows.length === 1 ? "Task" : "Tasks"}${filtering ? " match the Filter" : ""}`];
  if (!bySubtask) {
    const subs = all.length - top.length;
    if (subs > 0) parts.push(`${subs} ${subs === 1 ? "Subtask" : "Subtasks"} under their Parents`);
  }
  const visible = new Set(rows.map((t) => t.id));
  const pool = bySubtask ? all.filter((t) => !t.subtask_counts) : top;
  for (const state of filtering ? [] : (["done", "dropped"] as const)) {
    const n = pool.filter((t) => t.state === state && !visible.has(t.id)).length;
    if (n > 0) parts.push(`${state === "done" ? "Done" : "Dropped"} hidden (${n})`);
  }
  return parts.join(" · ");
}

/** The kanban, with what a drop does: move the Task to the Step, or say why not. */
function Board({
  model,
  workflow,
  tasks,
  display,
  changeDisplay,
  onAdd,
}: {
  model: TasksModel;
  /** The Workflow whose board this is. */
  workflow: string;
  tasks: Task[];
  display: ReturnType<typeof useDisplay>[0];
  changeDisplay: ReturnType<typeof useDisplay>[1];
  onAdd: (step: string) => void;
}) {
  const move = useMoveTask(model.project.key);
  const columns = boardColumns(tasks, {
    workflows: model.workflows,
    workflow,
    steps: model.steps,
    position: model.position,
    children: model.children,
    members: model.members,
    display,
  });
  const me = model.me.member.id;

  const refuse = (task: Task, to: Column, body: string) =>
    toast(`${task.key} not moved to ${columnName(to, model)}`, { description: body, icon: <BanIcon className="size-4 text-state-blocked" /> });

  const drop = (task: Task, to: Column) => {
    const claim = liveClaim(task, model.now);
    const problem = dropProblem(task, to, claim?.holder_id === me) ?? model.moveProblem(task);
    if (problem || to.kind !== "step") return refuse(task, to, problem ?? "");
    // Moving a held Task ends the Claim, as a take-back would; the mover may take it back.
    const ends = claim && model.members.get(claim.holder_id)?.name;
    move.mutate(
      { task, step: to.step.id },
      {
        onSuccess: () => {
          if (ends) toast(`${task.key} moved to ${to.step.name}`, { description: `${ends}'s Claim on it ended.` });
        },
        onError: (err) =>
          refuse(
            task,
            to,
            refusalText(err instanceof ApiError ? err.code : "network", {
              task,
              to: to.step.name,
              projectName: model.project.name,
              message: err instanceof Error ? err.message : String(err),
            }),
          ),
      },
    );
  };

  return (
    <TaskBoard
      model={model}
      columns={columns}
      onDrop={drop}
      onExpand={(c) => changeDisplay(c.kind === "done" ? { showDone: true } : { showDropped: true })}
      onAdd={onAdd}
    />
  );
}


/** The Display a View kept, over the defaults for anything it does not say. */
function displayOf(saved: Record<string, unknown> | undefined): Display {
  const out: Display = { ...defaultDisplay };
  for (const k of Object.keys(defaultDisplay) as (keyof Display)[]) {
    if (saved && typeof saved[k] === typeof defaultDisplay[k]) (out as Record<string, unknown>)[k] = saved[k];
  }
  return out;
}
