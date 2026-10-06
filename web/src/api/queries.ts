import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, call, type Feature, type Member, type Skill, type SubjectType, type Task, type Team } from "./client";
import { allPages } from "./pages";

// The first element of every query key names what it reads; live updates invalidate by it.
export const keys = {
  health: ["health"] as const,
  me: ["me"] as const,
  members: ["members"] as const,
  member: (ref: string) => ["member", ref] as const,
  tokens: (member: string) => ["tokens", member] as const,
  teams: ["teams"] as const,
  team: (ref: string) => ["team", ref] as const,
  skills: ["skills"] as const,
  skill: (ref: string) => ["skill", ref] as const,
  skillVersions: (ref: string) => ["skill-versions", ref] as const,
  features: (team: string) => ["features", team] as const,
  feature: (ref: string) => ["feature", ref] as const,
  featureObservations: (ref: string) => ["feature-observations", ref] as const,
  heldTasks: (member: string) => ["tasks", { holder: member }] as const,
  openTasks: ["tasks", { state: "open" }] as const,
  allTasks: ["tasks", { all: true }] as const,
  allFeatures: ["features", { all: true }] as const,
  task: (ref: string) => ["task", ref] as const,
  takeable: ["takeable"] as const,
  activity: ["activity"] as const,
};

type Root =
  | "health"
  | "me"
  | "members"
  | "member"
  | "tokens"
  | "teams"
  | "team"
  | "skills"
  | "skill"
  | "skill-versions"
  | "features"
  | "feature"
  | "feature-observations"
  | "tasks"
  | "task"
  | "takeable"
  | "activity";

const work: Root[] = ["features", "feature", "feature-observations", "tasks", "task", "takeable"];
const organisation: Root[] = ["me", "members", "member", "tokens", "teams", "team", "skills", "skill", "skill-versions", "takeable"];

// Which queries an Activity entry can change, by its subject type: the part of its kind before
// the dot (`task.claimed` is about a Task). A kind added later with a new subject type refreshes
// everything.
const affected: Record<SubjectType, Root[]> = {
  task: work,
  feature: work,
  member: [...organisation, "task", "feature"],
  team: organisation,
  skill: [...organisation, "task"],
  token: [...organisation, ...work],
  session: [...organisation, ...work],
  login_link: [],
};

/** The query roots an Activity entry may have changed. */
export function affectedBy(kind: string): Root[] | "all" {
  return affected[kind.split(".")[0] as SubjectType] ?? "all";
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

export function useMembers() {
  return useQuery({ queryKey: keys.members, queryFn: () => call(api.GET("/v1/members")).then((r) => r.items) });
}

export function useTeams() {
  return useQuery({ queryKey: keys.teams, queryFn: () => call(api.GET("/v1/teams")).then((r) => r.items) });
}

export function useSkills() {
  return useQuery({ queryKey: keys.skills, queryFn: () => call(api.GET("/v1/skills")).then((r) => r.items) });
}

function byId<T extends { id: string }>(items: T[] | undefined): Map<string, T> {
  return new Map((items ?? []).map((x) => [x.id, x]));
}

/** Members, Teams and Skills by id, for showing names where the API gives ids. */
export function useDirectory() {
  const members = useMembers();
  const teams = useTeams();
  const skills = useSkills();
  return useMemo(
    () => ({
      members: byId<Member>(members.data),
      teams: byId<Team>(teams.data),
      skills: byId<Skill>(skills.data),
      memberList: members.data ?? [],
      teamList: teams.data ?? [],
      skillList: skills.data ?? [],
    }),
    [members.data, teams.data, skills.data],
  );
}

/** Every open Task in the Organisation, in `next` order: what the sidebar's live count reads. */
export function useOpenTasks() {
  return useQuery({
    queryKey: keys.openTasks,
    queryFn: () => allPages<Task>((cursor) => call(api.GET("/v1/tasks", { params: { query: { state: "open", limit: 500, cursor } } }))),
  });
}

/**
 * Every Task and every Feature in the Organisation, read when ⌘K opens: /v1 has no search, so the
 * palette matches keys and words in the browser.
 */
export function useAllTasks(enabled = true) {
  return useQuery({
    queryKey: keys.allTasks,
    queryFn: () => allPages<Task>((cursor) => call(api.GET("/v1/tasks", { params: { query: { limit: 500, cursor } } }))),
    enabled,
  });
}

export function useAllFeatures(enabled = true) {
  return useQuery({
    queryKey: keys.allFeatures,
    queryFn: () => allPages<Feature>((cursor) => call(api.GET("/v1/features", { params: { query: { limit: 500, cursor } } }))),
    enabled,
  });
}
