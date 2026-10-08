// /projects/:key/tasks?view=list|board: a Project's Tasks as rows grouped by Step, or as a
// kanban whose columns are its Workflow's Steps, with Display and File Task.
import { BanIcon, ListTodoIcon, PlusIcon } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { ApiError, type Task } from "@/api/client";
import { useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { Content, TopBar } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { liveClaim } from "@/work";
import { boardColumns, columnName, compareTasks, dropProblem, groupTasks, listRows, rankFinder, refusalText, type Column } from "./derive";
import { taskMatches } from "./filterSeam";
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
  const [display, changeDisplay] = useDisplay();
  const [expanded, expand] = useRememberedSet(expandedKey);
  const [folded, fold] = useRememberedSet(foldedKey, ["dropped"]);

  const all = model.tasks.data;
  const sorted = useMemo(
    () => (all ?? []).filter(taskMatches).sort(compareTasks(display.order, rankFinder(model.byId))),
    [all, display.order, model.byId],
  );

  const top = (
    <>
      <h1 className="sr-only">{view === "board" ? "Tasks, board" : "Tasks, list"}</h1>
      <TopBar
        crumbs={[projectCrumb(project, false), { label: "Tasks", wide: true }]}
        view={<ViewSwitch view={view} />}
        actions={<DisplayMenu display={display} change={changeDisplay} view={view} />}
        primary={
          <Button onClick={() => openFileTask({ project: project.key })} aria-label="File Task">
            <PlusIcon />
            <span className="hidden sm:inline">File Task</span>
            <Kbd className="hidden h-[18px] min-w-[18px] border-transparent bg-primary-foreground/15 text-[10.5px] text-inherit sm:inline-flex">C</Kbd>
          </Button>
        }
      />
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
          <Board model={model} tasks={sorted} display={display} changeDisplay={changeDisplay} onAdd={add} />
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
  const rows = listRows(sorted, display);
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
          expanded={expanded}
          onExpand={expand}
          folded={folded}
          onFold={fold}
          subtasks={display.showSubtasks}
          showStep={display.group !== "step"}
          onAdd={add}
          footer={footerText(all, rows, display.group === "parent")}
        />
      </Content>
    </>
  );
}

/** "18 Tasks · 4 Subtasks · Dropped hidden (2)". */
function footerText(all: Task[], rows: Task[], bySubtask: boolean): string {
  const top = all.filter((t) => !t.parent_id);
  const parts = [`${rows.length} ${rows.length === 1 ? "Task" : "Tasks"}`];
  if (!bySubtask) {
    const subs = all.length - top.length;
    if (subs > 0) parts.push(`${subs} ${subs === 1 ? "Subtask" : "Subtasks"} under their Parents`);
  }
  const visible = new Set(rows.map((t) => t.id));
  const pool = bySubtask ? all.filter((t) => !t.subtask_counts) : top;
  for (const state of ["done", "dropped"] as const) {
    const n = pool.filter((t) => t.state === state && !visible.has(t.id)).length;
    if (n > 0) parts.push(`${state === "done" ? "Done" : "Dropped"} hidden (${n})`);
  }
  return parts.join(" · ");
}

/** The kanban, with what a drop does: move the Task to the Step, or say why not. */
function Board({
  model,
  tasks,
  display,
  changeDisplay,
  onAdd,
}: {
  model: TasksModel;
  tasks: Task[];
  display: ReturnType<typeof useDisplay>[0];
  changeDisplay: ReturnType<typeof useDisplay>[1];
  onAdd: (step: string) => void;
}) {
  const move = useMoveTask(model.project.key);
  const columns = boardColumns(tasks, { steps: model.steps, children: model.children, members: model.members, display });
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
