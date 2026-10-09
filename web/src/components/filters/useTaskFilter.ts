// The Filter of a list of Tasks, wired: the pills in `?filter.tasks=`, the values each axis offers
// for the list's Projects, what `matches` reads (the Workflows' Steps, the Runner's sessions, the
// Claim trail), the F key, and old links rewritten. A page that lists Tasks renders the bar from
// `bar` and keeps the Tasks `matches` passes.
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api, call, type Activity, type Member, type Project, type Skill, type Task, type Workflows } from "@/api/client";
import { useLiveEntries } from "@/api/live";
import { keys, newestActivity, useDirectory, useLabels, useRunnerSessions, useWorkspaces } from "@/api/queries";
import { useIntent } from "@/app/intents";
import { useNow } from "@/clock";
import { useCurrentMe } from "@/me";
import type { FilterBarProps } from "./FilterBar";
import { serializeFilter, useFilterState, type FilterPill } from "./filterState";
import { usablePills } from "./operators";
import {
  claimTrails,
  matches as taskMatches,
  projectTaskFields,
  stepsOf,
  taskFields,
  taskFilterOptions,
  trailKinds,
  type ClaimTrail,
  type FilterContext,
} from "./taskAxes";

// ---------------------------------------------------------------- old links

/**
 * The Tasks list's parameters before `filter.tasks`, by name, one value each: `?skill=`,
 * `?holder=`, `?blocked=1` and the old Features list's `?owner=`; and those of the model before
 * Projects: `?feature=<key>` (a Feature is a Task with Subtasks now, under the same key),
 * `?status=` and `?team=` (Statuses are gone; the Project is in the address).
 */
export const legacyTaskKeys = ["skill", "holder", "blocked", "owner", "feature", "status", "team"] as const;

/** What an old link's names are looked up in. */
export type LegacyLookup = {
  members: ReadonlyMap<string, Pick<Member, "id" | "name">>;
  skills: ReadonlyMap<string, Pick<Skill, "id" | "name">>;
  /** The Steps of the list's Workflows: a Skill named by an old link is the Steps carrying it. */
  steps: readonly { id: string; skill_id?: string }[];
  /** The list's Tasks: a Feature named by its key is the Parent with that key. */
  tasks: readonly Pick<Task, "id" | "key">[];
};

const idOf = <T extends { id: string; name: string }>(items: ReadonlyMap<string, T>, name: string | null) =>
  name ? [...items.values()].find((x) => x.name === name)?.id : undefined;

/**
 * The pills an old Tasks link stands for: ?skill=<name> is the Steps carrying that Skill,
 * ?holder= and ?owner= a Member by name, ?blocked=1 Blocked, ?feature=<key> the Parent with that
 * key. ?status= and ?team= stand for nothing now. A name that matches nothing is dropped.
 */
export function legacyTaskPills(params: URLSearchParams, lookup: LegacyLookup): FilterPill[] {
  const pills: FilterPill[] = [];
  const skill = idOf(lookup.skills, params.get("skill"));
  const steps = skill ? lookup.steps.filter((s) => s.skill_id === skill).map((s) => s.id) : [];
  if (steps.length > 0) pills.push({ field: "step", op: steps.length > 1 ? "in" : "is", values: steps });
  const holder = idOf(lookup.members, params.get("holder"));
  if (holder) pills.push({ field: "holder", op: "is", values: [holder] });
  const owner = idOf(lookup.members, params.get("owner"));
  if (owner) pills.push({ field: "owner", op: "is", values: [owner] });
  if (params.get("blocked") === "1") pills.push({ field: "blocked", op: "is", values: ["true"] });
  const feature = params.get("feature");
  const parent = feature ? lookup.tasks.find((t) => t.key.toUpperCase() === feature.toUpperCase())?.id : undefined;
  if (parent) pills.push({ field: "parent", op: "is", values: [parent] });
  return pills;
}

/**
 * Rewrites an old link's by-name parameters into `filter.tasks` once what names their values has
 * loaded (`lookup` undefined until then), in one write that also drops the old parameters.
 */
export function useLegacyTaskFilters(lookup: LegacyLookup | undefined) {
  const [params, setParams] = useSearchParams();
  const legacy = legacyTaskKeys.some((k) => params.has(k));
  useEffect(() => {
    if (!legacy || !lookup) return;
    const key = "filter.tasks";
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        const pills = legacyTaskPills(current, lookup);
        for (const k of legacyTaskKeys) next.delete(k);
        const kept = next.getAll(key).filter((t) => !pills.some((p) => t.startsWith(`${p.field}:`)));
        next.delete(key);
        for (const t of [...kept, ...pills.map(serializeFilter)]) next.append(key, t);
        return next;
      },
      { replace: true },
    );
  }, [legacy, lookup, setParams]);
}

// ---------------------------------------------------------------- reads

/** Each Project's Workflow, by Project id, read under the same keys as `useWorkflow`. */
export function useWorkflows(projects: readonly Project[]): { workflows: Map<string, Workflows | undefined>; loaded: boolean } {
  const results = useQueries({
    queries: projects.map((p) => ({
      queryKey: keys.workflow(p.key),
      queryFn: () => call(api.GET("/v1/projects/{project}/workflow", { params: { path: { project: p.key } } })),
    })),
  });
  const data = results.map((r) => r.data);
  const loaded = results.every((r) => !r.isPending);
  // A new Map only when a Workflow is read again, so what is computed from it keeps its identity.
  const stamp = results.map((r) => r.dataUpdatedAt).join();
  const workflows = useMemo(() => new Map(projects.map((p, i) => [p.id, data[i]])), [stamp, projects]); // eslint-disable-line react-hooks/exhaustive-deps
  return { workflows, loaded };
}

/** The Labels the Tasks of `projects` can carry: each one's own, then the Organisation's. */
function useCarriedLabels(projects: readonly Project[]) {
  const org = useLabels();
  const own = useQueries({
    queries: projects.map((p) => ({
      queryKey: keys.projectLabels(p.key),
      queryFn: () => call(api.GET("/v1/projects/{project}/labels", { params: { path: { project: p.key } } })).then((r) => r.items),
    })),
  });
  const data = [...own.map((q) => q.data ?? []), org.data ?? []];
  const stamp = [...own.map((q) => q.dataUpdatedAt), org.dataUpdatedAt].join();
  return useMemo(() => data.flat(), [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The Claim trail of a Project's Tasks (or every Task's, with none), from its latest 500 Claim
 * entries joined with the stream: when each last lapsed, and who completed it. A lapse older than
 * that read counts as none.
 */
export function useClaimTrails(project: string | undefined, enabled = true): Map<string, ClaimTrail> {
  const query = { project, kind: [...trailKinds], limit: 500 };
  const read = useQuery({
    queryKey: keys.activity(query),
    queryFn: () => call(api.GET("/v1/activity", { params: { query: { ...query, before: newestActivity } } })),
    enabled,
  });
  const live = useLiveEntries();
  const entries = read.data?.items;
  return useMemo(() => {
    if (!enabled) return new Map();
    const kinds = new Set<string>(trailKinds);
    const fresh: Activity[] = live.filter((e) => kinds.has(e.kind));
    return claimTrails([...(entries ?? []), ...fresh]);
  }, [enabled, entries, live]);
}

// ---------------------------------------------------------------- the hook

export type TaskFilter = {
  /** The axes the list offers. */
  fields: typeof taskFields;
  /** The pills in force: those in the address the list can apply. */
  pills: FilterPill[];
  /** The bar's props: render `FilterMenuButton` and `FilterChipRow` from them. */
  bar: FilterBarProps;
  /** Whether the Filters menu is open (F opens it). */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** What `matches` reads. */
  ctx: FilterContext;
  /** Whether a Task passes every pill. */
  matches: (task: Task) => boolean;
  /** Each of the list's Projects' Workflow, by Project id. */
  workflows: Map<string, Workflows | undefined>;
};

/**
 * The Filter of a list of `tasks` from `projects`: one Project's list, or (`acrossProjects`) a
 * list across them, which adds the Project axis. `trails` is the Claim trail when the page reads
 * it already; otherwise it is read only while a pill asks for Lapsed. `onClearAll` replaces the
 * bar's Reset (a page with Views passes `useSavedViews`' `clear`, which leaves the View too).
 */
export function useTaskFilter(cfg: {
  projects: readonly Project[];
  tasks: readonly Task[] | undefined;
  acrossProjects?: boolean;
  trails?: ReadonlyMap<string, ClaimTrail>;
  onClearAll?: () => void;
}): TaskFilter {
  const { projects, tasks, acrossProjects = false } = cfg;
  const me = useCurrentMe();
  const now = useNow();
  const dir = useDirectory();
  const fields = acrossProjects ? taskFields : projectTaskFields;
  const filter = useFilterState("tasks");
  const pills = useMemo(() => usablePills(filter.pills, fields), [filter.pills, fields]);
  const [open, setOpen] = useState(false);
  useIntent("filter", () => setOpen(true));

  const { workflows, loaded } = useWorkflows(projects);
  const labels = useCarriedLabels(projects);
  const workspaces = useWorkspaces().data;
  const runner = useRunnerSessions().data?.items;
  const sessions = useMemo(() => new Set((runner ?? []).map((r) => r.task_id)), [runner]);
  const wantsLapsed = pills.some((p) => p.field === "claim" && p.values.includes("lapsed"));
  const read = useClaimTrails(projects.length === 1 && !acrossProjects ? projects[0].key : undefined, wantsLapsed && !cfg.trails);
  const trails = cfg.trails ?? read;

  const steps = useMemo(() => stepsOf(workflows.values()), [workflows]);
  const ctx = useMemo<FilterContext>(() => ({ now, steps, trails, sessions }), [now, steps, trails, sessions]);

  const options = useMemo(
    () =>
      taskFilterOptions({
        projects,
        workflows,
        tasks: tasks ?? [],
        labels,
        members: dir.members,
        skills: dir.skills,
        workspaces: workspaces ?? [],
        allProjects: dir.projectList,
        me: me.member.id,
      }),
    [projects, workflows, tasks, labels, dir.members, dir.skills, dir.projectList, workspaces, me.member.id],
  );

  const ready = loaded && !!tasks && dir.members.size > 0 && dir.skills.size > 0;
  const lookup = useMemo<LegacyLookup | undefined>(
    () => (ready ? { members: dir.members, skills: dir.skills, steps: [...workflows.values()].flatMap((w) => w?.steps ?? []), tasks: tasks ?? [] } : undefined),
    [ready, dir.members, dir.skills, workflows, tasks],
  );
  useLegacyTaskFilters(lookup);

  const matches = useCallback((t: Task) => taskMatches(t, pills, ctx), [pills, ctx]);
  const bar: FilterBarProps = {
    fields,
    pills,
    optionsFor: (field) => options.get(field),
    onSetFilter: filter.setFilter,
    onRemoveFilter: filter.removeFilter,
    onClearAll: cfg.onClearAll ?? filter.clearAll,
  };
  return { fields, pills, bar, open, setOpen, ctx, matches, workflows };
}
