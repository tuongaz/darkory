// /teams/:team/tasks?view=list|board: a Team's Tasks as rows grouped by Status (F-B2) or as a
// kanban (F-B1), with Filter (its pills in ?filter.tasks=), Display and File Task.
import { useQueryClient } from "@tanstack/react-query";
import { BanIcon, LayersIcon, ListTodoIcon, PlusIcon, SearchXIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ApiError, type Task } from "@/api/client";
import { useRunnerSessions, useWorkspaces } from "@/api/queries";
import { sendIntent, useIntent } from "@/app/intents";
import { usePeekLink } from "@/app/peek";
import { Content, TopBar } from "@/app/TopBar";
import { EmptyState } from "@/components/EmptyState";
import { FilterChipRow, FilterMenuButton, type FilterBarProps } from "@/components/filters/FilterBar";
import { useFilterState } from "@/components/filters/filterState";
import { usablePills } from "@/components/filters/operators";
import { Refusal } from "@/components/Refusal";
import { TeamMark } from "@/components/TeamMark";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { liveClaim } from "@/work";
import { compareTasks, groupTasks, refusalNote, visibleTasks, type Status } from "./derive";
import { taskFields, taskFilterOptions } from "./filters";
import { useBoardModel, type BoardModel } from "./model";
import { fetchTakeable, useClaim, useSetStatus } from "./queries";
import { openFileTask, useDisplay, useLegacyTaskFilters } from "./state";
import { TaskBoard, type Column } from "./TaskBoard";
import { TaskList } from "./TaskList";
import { DisplayMenu, ViewSwitch } from "./ViewMenus";

export function TeamTasksPage() {
  const { team: teamRef = "" } = useParams();
  const [params] = useSearchParams();
  const view = params.get("view") === "board" ? "board" : "list";
  const model = useBoardModel(teamRef);
  const [display, changeDisplay] = useDisplay();
  const { team } = model;

  const filter = useFilterState("tasks");
  useLegacyTaskFilters(model);
  const pills = useMemo(() => usablePills(filter.pills, taskFields), [filter.pills]);
  const [filterOpen, setFilterOpen] = useState(false);
  useIntent("filter", () => setFilterOpen(true));
  const workspaces = useWorkspaces().data;
  const runner = useRunnerSessions().data?.items;
  // The Tasks a Runner session works now, for the Claim axis' Live session.
  const sessions = useMemo(() => new Set((runner ?? []).filter((r) => r.state !== "ending").map((r) => r.task_id)), [runner]);
  const all = model.tasks.data;
  const options = useMemo(
    () =>
      taskFilterOptions({
        tasks: all ?? [],
        statuses: model.statusList,
        glyphs: model.glyphs,
        features: model.featureList,
        members: model.members,
        skills: model.skills,
        workspaces: workspaces ?? [],
        me: model.me.member.id,
      }),
    [all, model.statusList, model.glyphs, model.featureList, model.members, model.skills, workspaces, model.me.member.id],
  );
  const bar: FilterBarProps = {
    fields: taskFields,
    pills,
    optionsFor: (field) => options.get(field),
    onSetFilter: filter.setFilter,
    onRemoveFilter: filter.removeFilter,
    onClearAll: filter.clearAll,
  };

  const sorted = useMemo(() => [...(all ?? [])].sort(compareTasks(display.order, model.featureById)), [all, display.order, model.featureById]);
  const shown = useMemo(
    () =>
      visibleTasks(sorted, {
        display,
        pills,
        features: model.featureById,
        statuses: model.statusById,
        now: model.now,
        trails: model.trails,
        sessions,
        byKind: view === "list",
      }),
    [sorted, display, pills, model.featureById, model.statusById, model.now, model.trails, sessions, view],
  );

  // On a phone the bar shows the Team alone, beside the view switch and the actions.
  const crumbs = [{ label: team?.name ?? teamRef, icon: team ? <TeamMark team={team} /> : undefined }, { label: "Tasks", wide: true }];
  const top = (
    <>
      <h1 className="sr-only">{view === "board" ? "Tasks, board" : "Tasks, list"}</h1>
      <TopBar
        crumbs={crumbs}
        view={<ViewSwitch view={view} />}
        actions={
          team && (
            <>
              <FilterMenuButton {...bar} open={filterOpen} onOpenChange={setFilterOpen} />
              <DisplayMenu display={display} change={changeDisplay} view={view} />
            </>
          )
        }
        primary={
          <Button onClick={() => openFileTask({ team: team?.key })} aria-label="File Task">
            <PlusIcon />
            <span className="hidden sm:inline">File Task</span>
            <Kbd className="hidden h-[18px] min-w-[18px] border-transparent bg-primary-foreground/15 text-[10.5px] text-inherit sm:inline-flex">C</Kbd>
          </Button>
        }
      />
      {team && <FilterChipRow {...bar} />}
    </>
  );

  if (model.teamsLoaded && !team) {
    return (
      <>
        {top}
        <Content>
          <EmptyState icon={<SearchXIcon />} title="No such Team">
            No Team has the key {teamRef}.
          </EmptyState>
        </Content>
      </>
    );
  }
  const failed = model.tasks.error ?? model.statuses.error ?? model.features.error;
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
  if (!team || !all || !model.statuses.data || !model.features.data) {
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

  return (
    <>
      {top}
      <Content>
        {view === "board" ? (
          <Board model={model} tasks={shown} display={display} changeDisplay={changeDisplay} />
        ) : all.length === 0 ? (
          <EmptyState
            icon={<ListTodoIcon />}
            title="No Tasks yet"
            action={
              <Button variant="outline" onClick={() => sendIntent({ kind: "file-feature", team: team.key })}>
                <LayersIcon />
                File Feature
              </Button>
            }
          >
            A Feature comes with its Break down Task.
          </EmptyState>
        ) : (
          <TaskList
            model={model}
            groups={groupTasks(shown, display.group, {
              statuses: model.statusList,
              features: model.featureList,
              holderName: (id) => model.members.get(id)?.name ?? "",
              now: model.now,
            })}
            footer={footerText(all, shown, model)}
          />
        )}
      </Content>
    </>
  );
}

/** "18 Tasks · Dropped hidden (2)". */
function footerText(all: Task[], shown: Task[], model: BoardModel): string {
  const parts = [`${shown.length} ${shown.length === 1 ? "Task" : "Tasks"}`];
  const hidden = new Map<string, number>();
  const visible = new Set(shown.map((t) => t.id));
  for (const t of all) {
    if (visible.has(t.id)) continue;
    const kind = model.statusById.get(t.status_id)?.kind;
    const label = kind === "done" ? "Done" : kind === "dropped" ? "Dropped" : "Filtered";
    hidden.set(label, (hidden.get(label) ?? 0) + 1);
  }
  for (const [label, n] of hidden) parts.push(`${label} hidden (${n})`);
  return parts.join(" · ");
}

/** The kanban, with what a drag does: set the Status, or say why not and what would. */
function Board({
  model,
  tasks,
  display,
  changeDisplay,
}: {
  model: BoardModel;
  tasks: Task[];
  display: ReturnType<typeof useDisplay>[0];
  changeDisplay: ReturnType<typeof useDisplay>[1];
}) {
  const team = model.team!;
  const qc = useQueryClient();
  const setStatus = useSetStatus(team.key);
  const claim = useClaim();
  const navigate = useNavigate();
  const peek = usePeekLink();

  const columns: Column[] = model.statusList.map((status) => ({
    status,
    tasks: tasks.filter((t) => t.status_id === status.id),
    collapsed: (status.kind === "done" && !display.showDone) || (status.kind === "dropped" && !display.showDropped),
  }));

  const refused = async (task: Task, to: Status, err: unknown) => {
    const code = err instanceof ApiError ? err.code : "network";
    const me = model.me.member.id;
    const holds = liveClaim(task, model.now)?.holder_id === me;
    const feature = model.featureById.get(task.feature_id);
    let takeable = false;
    if (code === "use_complete" && !holds) {
      takeable = await fetchTakeable(qc).then(
        (list) => list.some((t) => t.id === task.id),
        () => false,
      );
    }
    const note = refusalNote(code, {
      task,
      target: to,
      takeable,
      holds,
      owns: feature?.owner_id === me,
      ownerName: feature ? model.members.get(feature.owner_id)?.name : undefined,
      teamName: team.name,
      message: err instanceof Error ? err.message : String(err),
    });
    const action = note.action;
    toast(note.title, {
      description: note.body,
      icon: <BanIcon className="size-4 text-state-blocked" />,
      action: action && {
        label: action.label,
        onClick: () => {
          if (action.kind === "open") navigate(peek(task.key));
          else
            claim.mutate(task.key, {
              onError: (e) => toast(`Not claimed: ${task.key}`, { description: e instanceof Error ? e.message : String(e) }),
            });
        },
      },
    });
  };

  return (
    <TaskBoard
      model={model}
      columns={columns}
      onMove={(task, to) => setStatus.mutate({ task, status: to }, { onError: (err) => void refused(task, to, err) })}
      onExpand={(status) => changeDisplay(status.kind === "done" ? { showDone: true } : { showDropped: true })}
      onAdd={(status) => openFileTask({ team: team.key, status: status.id })}
    />
  );
}
