import { useQueries } from "@tanstack/react-query";
import type { Member, Skill } from "@/api/client";
import { api, call } from "@/api/client";
import { keys, useMembers, useProjects } from "@/api/queries";
import type { WorkflowRecord } from "../bind";
import { inProjectOrder } from "@/components/workflowLine/model";
import { orgWide } from "./holders";

/*
 * How far an act on who takes a Step reaches. A Step is taken by the Members of its Project who
 * have its Skill (the Organisation's, for skill-review), so giving or taking a Skill reaches every
 * Project the Member is in, and joining or leaving a Project reaches every Step there whose Skill
 * the Member has. Read from every Project's Workflow and Members and every Member's Skills; each
 * act names the Steps it reaches, with their open Tasks, before it is made.
 */

export type OrgProject = { id: string; key: string; name: string; members: ReadonlySet<string> };

/** What the reach of an act is read from. */
export type OrgFacts = {
  projects: OrgProject[];
  workflows: ReadonlyMap<string, WorkflowRecord>;
  /** Each active Member's Skills, by the Member's id. */
  skillsOf: ReadonlyMap<string, ReadonlySet<string>>;
  members: Pick<Member, "id" | "name" | "kind">[];
};

/** A Step an act reaches: its Project, its name and the open Tasks at it. */
export type Place = { project: OrgProject; step: { id: string; name: string }; tasks: number };

type SkillRef = Pick<Skill, "id" | "name" | "builtin">;

const placesOf = (facts: OrgFacts, project: OrgProject, has: (skill: string | undefined) => boolean): Place[] =>
  [...(facts.workflows.get(project.key)?.steps ?? [])]
    .sort(inProjectOrder(facts.workflows.get(project.key)?.workflows ?? []))
    .filter((s) => has(s.skill_id))
    .map((s) => ({ project, step: { id: s.id, name: s.name }, tasks: s.tasks }));

/** The Projects a Member takes Tasks in by a Skill: their own, or every Project for skill-review. */
function projectsFor(facts: OrgFacts, member: string, skill: SkillRef): OrgProject[] {
  return orgWide(skill) ? facts.projects : facts.projects.filter((p) => p.members.has(member));
}

/** Who else takes the Tasks at `place` by `skill`, the Member left out. */
export function othersAt(facts: OrgFacts, place: Place, skill: SkillRef, member: string): string[] {
  const pool = orgWide(skill) ? facts.members : facts.members.filter((m) => place.project.members.has(m.id));
  return pool.filter((m) => m.id !== member && facts.skillsOf.get(m.id)?.has(skill.id)).map((m) => m.name);
}

/** Taking `skill` from `member`: every Step carrying it in every Project they take it in. */
export function takeAwayReach(facts: OrgFacts, member: string, skill: SkillRef): Place[] {
  return projectsFor(facts, member, skill).flatMap((p) => placesOf(facts, p, (s) => s === skill.id));
}

/**
 * Removing `member` from `project`: every Step there whose Skill they have (skill-review left out:
 * they take that in every Project, in it or not).
 */
export function leaveReach(facts: OrgFacts, member: string, project: string, skills: readonly SkillRef[]): Place[] {
  const p = facts.projects.find((x) => x.key === project);
  const mine = facts.skillsOf.get(member) ?? new Set<string>();
  const wide = new Set(skills.filter(orgWide).map((s) => s.id));
  return p ? placesOf(facts, p, (s) => !!s && mine.has(s) && !wide.has(s)) : [];
}

/** The other Projects `member` is in: where they stay when they leave `project`. */
export function staysIn(facts: OrgFacts, member: string, project: string): OrgProject[] {
  return facts.projects.filter((p) => p.key !== project && p.members.has(member));
}

/** Giving `skill` to `member`: the Projects other than `project` where they would take it too, by its Steps there. */
export function grantElsewhere(facts: OrgFacts, member: string, skill: SkillRef, project: string): OrgProject[] {
  return projectsFor(facts, member, skill).filter((p) => p.key !== project && placesOf(facts, p, (s) => s === skill.id).length > 0);
}

/** `member` joining `project`: the Steps there they would take besides those carrying `skill`, by the Skills they have. */
export function joinAlso(facts: OrgFacts, member: string, skill: SkillRef, project: string, skills: readonly SkillRef[]): Place[] {
  return leaveReach(facts, member, project, skills).filter((p) => facts.workflows.get(project)?.steps.find((s) => s.id === p.step.id)?.skill_id !== skill.id);
}

/** "Main", "Main and Sample", "Big, Main and Sample"; with `or`, "Main or Sample". */
export function andList(names: readonly string[], word = "and"): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${word} ${names.at(-1)}`;
}

/**
 * Every Project with its Members and Workflow, and every active Member's Skills, for an admin: the
 * facts each act's reach is read from. Undefined until all are read.
 */
export function useOrgFacts(enabled = true): OrgFacts | undefined {
  const projects = useProjects();
  const members = useMembers();
  const list = enabled ? (projects.data ?? []) : [];
  const active = enabled ? (members.data ?? []).filter((m) => !m.deactivated_at) : [];
  const details = useQueries({
    queries: list.map((p) => ({ queryKey: keys.project(p.key), queryFn: () => call(api.GET("/v1/projects/{project}", { params: { path: { project: p.key } } })) })),
  });
  const workflows = useQueries({
    queries: list.map((p) => ({ queryKey: keys.workflow(p.key), queryFn: () => call(api.GET("/v1/projects/{project}/workflow", { params: { path: { project: p.key } } })) })),
  });
  const people = useQueries({
    queries: active.map((m) => ({ queryKey: keys.member(m.id), queryFn: () => call(api.GET("/v1/members/{member}", { params: { path: { member: m.id } } })) })),
  });
  if (!enabled || !projects.data || !members.data || ![...details, ...workflows, ...people].every((q) => q.data)) return undefined;
  return {
    projects: list.map((p, i) => ({ id: p.id, key: p.key, name: p.name, members: new Set((details[i].data?.members ?? []).map((m) => m.id)) })),
    workflows: new Map(list.map((p, i) => [p.key, workflows[i].data!])),
    skillsOf: new Map(people.map((q) => [q.data!.member.id, new Set(q.data!.skills.map((s) => s.id))])),
    members: active.map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
  };
}
