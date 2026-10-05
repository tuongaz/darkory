import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, call, type Activity, type Member, type Skill, type Team } from "./client";

// The first element of every query key names what it reads; live updates invalidate by it.
export const keys = {
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
  teamTasks: (team: string) => ["tasks", { team }] as const,
  heldTasks: (member: string) => ["tasks", { holder: member }] as const,
  task: (ref: string) => ["task", ref] as const,
  takeable: ["takeable"] as const,
  activity: ["activity"] as const,
};

type Root =
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

// Which queries an Activity entry can change, by the area its kind names (`task.claimed` is a
// Task's). The spec does not list the kinds, so an unknown area refreshes everything.
const affected: Record<string, Root[]> = {
  task: work,
  claim: work,
  feature: work,
  note: ["task"],
  observation: ["task", "feature-observations"],
  evidence: ["task", "feature"],
  member: [...organisation, "task", "feature"],
  team: organisation,
  skill: [...organisation, "task"],
  token: [...organisation, ...work],
  session: [...organisation, ...work],
};

/** The query roots an Activity entry may have changed. */
export function affectedBy(kind: string): Root[] | "all" {
  return affected[kind.split(".")[0]] ?? "all";
}

/** Marks stale whatever the Activity entry may have changed; open views refetch. */
export function invalidateFor(qc: QueryClient, entry: Pick<Activity, "kind">) {
  invalidate(qc, affectedBy(entry.kind));
}

/** Marks every query but Activity history stale, as after the caller's own write. */
export function invalidateAll(qc: QueryClient) {
  invalidate(qc, "all");
}

function invalidate(qc: QueryClient, roots: Root[] | "all") {
  void qc.invalidateQueries({
    predicate: (q) => {
      const root = q.queryKey[0] as Root;
      return root !== "activity" && (roots === "all" || roots.includes(root));
    },
  });
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
