import { useInfiniteQuery, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, call, type ActivityKind, type Member, type Project, type RunnerSession, type Session, type Skill, type SubjectType, type Task, type ViewEntity } from "./client";
import { allPages } from "./pages";
import type { paths } from "./schema.gen";

/**
 * What `GET /v1/tasks` narrows by, as `useTasks` takes it: `project` (id or key), `parent`,
 * `state`, `step`, `aimed_at`, `holder`, and `filter` (the bar's tokens). Every page is read.
 */
export type TaskQuery = Omit<NonNullable<paths["/v1/tasks"]["get"]["parameters"]["query"]>, "limit" | "cursor">;

/** What `GET /v1/activity` narrows by, as `useActivity` takes it. */
export type ActivityQuery = Omit<NonNullable<paths["/v1/activity"]["get"]["parameters"]["query"]>, "after" | "before">;

/** A `before` past every entry: reads the newest page of Activity. */
export const newestActivity = Number.MAX_SAFE_INTEGER;

// The first element of every query key names what it reads; live updates invalidate by it.
// Projects are named by key in keys (the route's), Members and Skills by id.
export const keys = {
  health: ["health"] as const,
  me: ["me"] as const,
  members: ["members"] as const,
  member: (ref: string) => ["member", ref] as const,
  memberSessions: (member: string) => ["member", member, "sessions"] as const,
  tokens: (member: string) => ["tokens", member] as const,
  projects: ["projects"] as const,
  project: (ref: string) => ["project", ref] as const,
  workflow: (project: string) => ["workflow", project] as const,
  /** The Organisation's own Labels. */
  labels: ["labels"] as const,
  /** A Project's own Labels. */
  projectLabels: (project: string) => ["labels", { project }] as const,
  /** Every Label a Task of the Project can carry: its own, then the Organisation's. */
  carriedLabels: (project: string) => ["labels", { project, carried: true }] as const,
  skills: ["skills"] as const,
  skill: (ref: string) => ["skill", ref] as const,
  skillVersions: (ref: string) => ["skill-versions", ref] as const,
  tasks: (query: TaskQuery) => ["tasks", query] as const,
  openTasks: ["tasks", { state: "open" }] as const,
  allTasks: ["tasks", { all: true }] as const,
  anyTask: ["tasks", { any: true }] as const,
  task: (ref: string) => ["task", ref] as const,
  takeable: ["takeable"] as const,
  runnerSessions: ["runner", "sessions"] as const,
  activity: (query: ActivityQuery) => ["activity", query] as const,
  workspaces: ["workspaces"] as const,
  views: (entity: ViewEntity, project?: string) => ["views", { entity, project }] as const,
};

export type Root =
  | "health"
  | "me"
  | "members"
  | "member"
  | "tokens"
  | "projects"
  | "project"
  | "workflow"
  | "labels"
  | "skills"
  | "skill"
  | "skill-versions"
  | "tasks"
  | "task"
  | "takeable"
  | "runner"
  | "workspaces"
  | "activity"
  | "views";

// The work: Task lists and records, what the caller can take, and each Workflow's live facts
// (the open and worked Tasks at every Step).
const work: Root[] = ["tasks", "task", "takeable", "workflow"];
// The Organisation: who is in it, in which Projects, with which Skills. A Workflow lists its
// Steps' takers, so it follows Members, Projects and Skills too.
const organisation: Root[] = ["me", "members", "member", "tokens", "projects", "project", "skills", "skill", "skill-versions", "takeable", "workflow"];

// Which queries an Activity entry can change, by its subject type: the part of its kind before
// the dot (`task.claimed` is about a Task). A kind added later with a new subject type refreshes
// everything.
// The Runner's sessions start and end with Claims (Task entries), and with its agents' settings
// and Sessions. A Workflow's change renames, adds or removes the Steps Tasks stand at; a Label's
// renames or removes it on every Task carrying it.
const affected: Record<SubjectType, Root[]> = {
  task: [...work, "runner"],
  workflow: work,
  label: ["labels", "tasks", "task"],
  skill: [...organisation, "task"],
  member: [...organisation, "task", "runner"],
  project: organisation,
  token: [...organisation, ...work],
  session: [...organisation, ...work, "runner"],
  login_link: [],
  workspace: [...organisation, ...work, "workspaces"],
  // A file is shown only through what names it, such as a Member's avatar, whose change is a
  // member.updated entry of its own.
  file: [],
};

// Kinds that change less than their subject type says. A nudge records what the Runner typed into
// a session; the Task, its Claim and the session's state stay as they were.
const affectedByKind: Partial<Record<ActivityKind, Root[]>> = {
  "task.nudged": [],
};

/** The query roots an Activity entry may have changed. */
export function affectedBy(kind: string): Root[] | "all" {
  return affectedByKind[kind as ActivityKind] ?? affected[kind.split(".")[0] as SubjectType] ?? "all";
}

/** Marks stale whatever the Activity entry may have changed; open views refetch. */
export function invalidateFor(qc: QueryClient, entry: { kind: string }) {
  invalidate(qc, affectedBy(entry.kind));
}

/** Marks every query but Activity history and health stale, as after the caller's own write. */
export function invalidateAll(qc: QueryClient) {
  invalidate(qc, "all");
}

// Neither is changed by a write: Activity history only grows, and the stream brings what is new.
const untouched: Root[] = ["activity", "health"];

function invalidate(qc: QueryClient, roots: Root[] | "all") {
  void qc.invalidateQueries({
    predicate: (q) => {
      const root = q.queryKey[0] as Root;
      return !untouched.includes(root) && (roots === "all" || roots.includes(root));
    },
  });
}

/** The Install's health: how humans sign in, and whether a newer release exists. Needs no credential. */
export function useHealth() {
  return useQuery({ queryKey: keys.health, queryFn: () => call(api.GET("/v1/health")), staleTime: 5 * 60_000 });
}

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => call(api.GET("/v1/me")) });
}

/** The Organisation's Members, deactivated ones included, by name. */
export function useMembers() {
  return useQuery({ queryKey: keys.members, queryFn: () => call(api.GET("/v1/members")).then((r) => r.items) });
}

/** A Member with their Projects, Skills and reports, by id or name. */
export function useMember(ref: string | undefined) {
  return useQuery({
    queryKey: keys.member(ref ?? ""),
    queryFn: () => call(api.GET("/v1/members/{member}", { params: { path: { member: ref! } } })),
    enabled: !!ref,
  });
}

/** A Member's tokens, revoked ones included: theirs, or any Member's for an admin. */
export function useTokens(member: string) {
  return useQuery({
    queryKey: keys.tokens(member),
    queryFn: () => call(api.GET("/v1/members/{member}/tokens", { params: { path: { member } } })).then((r) => r.items),
  });
}

/** A Member's open Sessions, and how many are open and how many have ended. */
export type MemberSessions = { items: Session[]; open: number; ended: number };

// A token Session ends on its own after a time unused, which no Activity entry says: the lists
// are read again every half minute while shown.
const sessionsRefetch = 30_000;

/**
 * A Member's open Sessions, most recently seen first, with the counts of open and ended ones:
 * theirs, or any Member's for an admin.
 */
export function useMemberSessions(member: string, enabled = true) {
  return useQuery({
    queryKey: keys.memberSessions(member),
    queryFn: async (): Promise<MemberSessions> => {
      let counts = { open: 0, ended: 0 };
      const items = await allPages(async (cursor) => {
        const page = await call(api.GET("/v1/members/{member}/sessions", { params: { path: { member }, query: { limit: 500, cursor } } }));
        if (!cursor) counts = { open: page.open, ended: page.ended };
        return page;
      });
      return { items, ...counts };
    },
    enabled: enabled && !!member,
    refetchInterval: sessionsRefetch,
  });
}

/** How many ended Sessions a page of `useEndedSessions` reads. */
export const endedPage = 50;

/**
 * A Member's ended Sessions, most recently ended first, a page at a time (they accumulate: a CLI
 * command run without a Session makes one). Read only once `enabled`, when someone asks to see them.
 */
export function useEndedSessions(member: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...keys.memberSessions(member), "ended"],
    queryFn: ({ pageParam }) =>
      call(api.GET("/v1/members/{member}/sessions", { params: { path: { member }, query: { state: "ended", limit: endedPage, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
    enabled: enabled && !!member,
    refetchInterval: sessionsRefetch,
  });
}

/** Every Project of the Organisation, by name, whether or not the caller is in it. */
export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: () => call(api.GET("/v1/projects")).then((r) => r.items) });
}

/** A Project with its Members, by key or id. */
export function useProject(ref: string | undefined) {
  return useQuery({
    queryKey: keys.project(ref ?? ""),
    queryFn: () => call(api.GET("/v1/projects/{project}", { params: { path: { project: ref! } } })),
    enabled: !!ref,
  });
}

/**
 * A Project's Workflow, by key or id: its Steps in order with what is happening at each (open
 * Tasks, those worked, the takers, the median time there) and the Connectors. Refetched on Task,
 * Workflow, Member, Project and Skill Activity, so the counts and takers stay live.
 */
export function useWorkflow(project: string | undefined) {
  return useQuery({
    queryKey: keys.workflow(project ?? ""),
    queryFn: () => call(api.GET("/v1/projects/{project}/workflow", { params: { path: { project: project! } } })),
    enabled: !!project,
  });
}

/**
 * Labels by name. With no Project, the Organisation's own; with one (key or id), every Label a
 * Task of it can carry: the Project's own, then the Organisation's. A Label's `project_id` says
 * whose it is.
 */
export function useLabels(project?: string) {
  return useQuery({
    queryKey: project ? keys.carriedLabels(project) : keys.labels,
    queryFn: async () => {
      const org = call(api.GET("/v1/labels")).then((r) => r.items);
      if (!project) return org;
      const own = call(api.GET("/v1/projects/{project}/labels", { params: { path: { project } } })).then((r) => r.items);
      const [a, b] = await Promise.all([own, org]);
      return [...a, ...b];
    },
  });
}

/** A Project's own Labels, by name: what Settings › the Project › Labels edits. */
export function useProjectLabels(project: string | undefined) {
  return useQuery({
    queryKey: keys.projectLabels(project ?? ""),
    queryFn: () => call(api.GET("/v1/projects/{project}/labels", { params: { path: { project: project! } } })).then((r) => r.items),
    enabled: !!project,
  });
}

export function useSkills(options: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: keys.skills, queryFn: () => call(api.GET("/v1/skills")).then((r) => r.items), enabled: options.enabled });
}

function byId<T extends { id: string }>(items: T[] | undefined): Map<string, T> {
  return new Map((items ?? []).map((x) => [x.id, x]));
}

/** Members, Projects and Skills by id, for showing names where the API gives ids. */
export function useDirectory() {
  const members = useMembers();
  const projects = useProjects();
  const skills = useSkills();
  return useMemo(
    () => ({
      members: byId<Member>(members.data),
      projects: byId<Project>(projects.data),
      skills: byId<Skill>(skills.data),
      memberList: members.data ?? [],
      projectList: projects.data ?? [],
      skillList: skills.data ?? [],
    }),
    [members.data, projects.data, skills.data],
  );
}

/** The Install's Workspaces, by name: where a Task's session works. */
export function useWorkspaces() {
  return useQuery({ queryKey: keys.workspaces, queryFn: () => call(api.GET("/v1/workspaces")).then((r) => r.items) });
}

function listTasks(query: TaskQuery): Promise<Task[]> {
  return allPages<Task>((cursor) => call(api.GET("/v1/tasks", { params: { query: { ...query, limit: 500, cursor } } })));
}

/**
 * The Tasks `query` narrows to, every page, in `/v1`'s order: by Project, then Rank, each Subtask
 * after its Parent. `{ project: "MAIN" }` is a Project's whole list, open and ended.
 */
export function useTasks(query: TaskQuery, options: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: keys.tasks(query), queryFn: () => listTasks(query), enabled: options.enabled });
}

/** A Task with its record (`TaskDetail`), by display key or id. */
export function useTask(ref: string | undefined) {
  return useQuery({
    queryKey: keys.task(ref ?? ""),
    queryFn: () => call(api.GET("/v1/tasks/{task}", { params: { path: { task: ref! } } })),
    enabled: !!ref,
  });
}

/** Every open Task in the Organisation: what the sidebar's live count reads. */
export function useOpenTasks() {
  return useTasks({ state: "open" });
}

/** Every Task in the Organisation, read when ⌘K opens: /v1 has no search, so the palette matches keys and words in the browser. */
export function useAllTasks(enabled = true) {
  return useQuery({ queryKey: keys.allTasks, queryFn: () => listTasks({}), enabled });
}

/** Whether the Organisation has any Task yet: until it does, /inbox shows the Install checklist. */
export function useAnyTask() {
  return useQuery({
    queryKey: keys.anyTask,
    queryFn: () => call(api.GET("/v1/tasks", { params: { query: { limit: 1 } } })).then((r) => r.items.length > 0),
  });
}

/** The Tasks the signed-in Member can take now, in the order `next` would offer them. */
export function useTakeable() {
  return useQuery({
    queryKey: keys.takeable,
    queryFn: () => call(api.GET("/v1/tasks/takeable", { params: { query: { limit: 500 } } })).then((r) => r.items),
  });
}

/**
 * The newest page of Activity `query` narrows to (`project`, `member`, `kind`, `limit`), in
 * sequence order. Not refetched by the stream, which brings what is new (`useLiveEntries`).
 */
export function useActivity(query: ActivityQuery = {}) {
  return useQuery({
    queryKey: keys.activity(query),
    queryFn: () => call(api.GET("/v1/activity", { params: { query: { ...query, before: newestActivity } } })),
  });
}

/**
 * The signed-in Member's Views of a list, oldest first: of one Project's list (key or id), or
 * across Projects with none. Views write no Activity, so another tab's change shows on the next
 * refetch; this tab's own writes refetch every query.
 */
export function useViews(entity: ViewEntity, project?: string) {
  return useQuery({
    queryKey: keys.views(entity, project),
    queryFn: () => call(api.GET("/v1/views", { params: { query: { entity, project } } })).then((r) => r.items),
  });
}

/**
 * The agent sessions the Runner beside this server runs now (`runner` is false when none is
 * attached), read every 5 s and again on Task, Member and Session Activity. With no Runner it asks
 * no more for the page's life: one starts only with the server.
 */
export function useRunnerSessions() {
  return useQuery({
    queryKey: keys.runnerSessions,
    queryFn: () => call(api.GET("/v1/runner/sessions")),
    enabled: (q) => q.state.data?.runner !== false,
    refetchInterval: 5_000,
  });
}

/** The Runner's session on a Task (by id), if it runs one. */
export function useRunnerSession(taskId: string | undefined): RunnerSession | undefined {
  const items = useRunnerSessions().data?.items;
  return taskId ? items?.find((s) => s.task_id === taskId) : undefined;
}
