import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { useMatch } from "react-router";
import type { Project } from "@/api/client";
import { useProjects } from "@/api/queries";
import { useCurrentMe } from "@/me";

/** The places of a Project the sidebar lists under it, each at `/projects/:key/<area>`. */
export type ProjectArea = "tasks" | "workflow" | "agents" | "activity";

/** The pages of a Project's settings, each at `/settings/projects/:key/<page>`. */
export type ProjectSettingsPage = "general" | "workflow" | "members" | "labels" | "workspaces";

// The Project last shown, remembered by this browser, so the app reopens where you left it.
const lastProjectKey = "darkory.project";
// The Project of the Task whose page or peek is showing, by id or key, which it reports once read.
let reported: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function lastProject(): string | undefined {
  try {
    return localStorage.getItem(lastProjectKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(key: string) {
  if (lastProject() === key) return;
  try {
    localStorage.setItem(lastProjectKey, key);
  } catch {
    // Storage refused (a private window): the next page load starts at the Member's first Project.
  }
  changed();
}

/**
 * A Task's page or peek says which Project the Task is in (its `project_id`, or a key), so the
 * current Project follows the record: opening MAIN-2 from the Inbox switches the sidebar to MAIN,
 * and MAIN stays current after the Task closes.
 */
export function useReportProject(ref: string | undefined) {
  useEffect(() => {
    if (!ref) return;
    reported = ref;
    changed();
    return () => {
      if (reported !== ref) return;
      reported = null;
      changed();
    };
  }, [ref]);
}

/** The key in the address of a Project's page (`/projects/:key/…`), as typed. */
export function useRouteProjectKey(): string | undefined {
  return useMatch("/projects/:key/*")?.params.key;
}

/** Finds a Project by id or key, ignoring the key's case. */
export function findProject(projects: Project[], ref: string | undefined): Project | undefined {
  if (!ref) return undefined;
  const upper = ref.toUpperCase();
  return projects.find((p) => p.id === ref || p.key.toUpperCase() === upper);
}

/**
 * The Project the app is in: the one in the address (`/projects/:key/…`), else the one a Task's
 * page or peek reported, else the one last shown in this browser, else the signed-in Member's
 * first Project, else the Organisation's first. Undefined while the Projects load, and with none.
 */
export function useCurrentProject(): Project | undefined {
  useSyncExternalStore(subscribe, () => version);
  const me = useCurrentMe();
  const projects = useProjects().data ?? [];
  const shown = findProject(projects, useRouteProjectKey()) ?? findProject(projects, reported ?? undefined);
  useEffect(() => {
    if (shown) remember(shown.key);
  }, [shown]);
  return shown ?? findProject(projects, lastProject()) ?? findProject(projects, me.projects[0]?.id) ?? projects[0];
}

/**
 * The Project of a page under `/projects/:key/…`, which `ProjectScope` has found: the page is not
 * drawn for a key that names no Project.
 */
export const RouteProjectContext = createContext<Project | null>(null);

export function useRouteProject(): Project {
  const project = useContext(RouteProjectContext);
  if (!project) throw new Error("useRouteProject is only for pages under /projects/:key");
  return project;
}

/**
 * The address of one of a Project's places; for Tasks, `view` picks the list or the board, and
 * `params` adds what else the address says (`workflow`, the Workflow a board shows).
 */
export function projectPath(project: Pick<Project, "key">, area: ProjectArea = "tasks", view?: "list" | "board", params: Record<string, string> = {}): string {
  const search = new URLSearchParams(view ? { view, ...params } : params).toString();
  return `/projects/${encodeURIComponent(project.key)}/${area}${search ? `?${search}` : ""}`;
}

/** The address of a Project's settings, its General page unless another is named. */
export function projectSettingsPath(project: Pick<Project, "key">, page: ProjectSettingsPage = "general"): string {
  return `/settings/projects/${encodeURIComponent(project.key)}/${page}`;
}

/** Which of a Project's places the address is in, if any. */
export function useProjectArea(): ProjectArea | undefined {
  return useMatch("/projects/:key/:area/*")?.params.area as ProjectArea | undefined;
}
