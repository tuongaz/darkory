import type { Feature, Health, Me, Member, Skill, Task, Team } from "../api/client";
import type { Handler } from "./api";

const at = "2026-10-01T09:00:00Z";

export const ada: Member = { id: "m-ada", name: "ada", kind: "human", admin: true, created_at: at };
export const bob: Member = { id: "m-bob", name: "bob", kind: "human", admin: false, manager_id: "m-ada", created_at: at };
export const builder: Member = { id: "m-builder", name: "builder", kind: "agent", admin: false, manager_id: "m-ada", created_at: at };

export const web: Team = { id: "t-web", key: "WEB", name: "Web", created_at: at };
export const ops: Team = { id: "t-ops", key: "OPS", name: "Ops", created_at: at };

export const build: Skill = { id: "s-build", name: "build", kind: "generic", builtin: false, current_version: 1, created_at: at };
export const review: Skill = { id: "s-review", name: "review", kind: "generic", builtin: false, current_version: 1, created_at: at };

export function me(member: Member = ada): Me {
  return {
    organisation: { id: "o-1", name: "Acme", created_at: at },
    member,
    teams: [web],
    skills: [build],
    session: { id: "browser-1", member_id: member.id, kind: "browser", started_at: at, last_seen_at: at },
  };
}

export function feature(n: number, rank: number, extra: Partial<Feature> = {}): Feature {
  return {
    id: `f-${n}`,
    key: `WEB-${n}`,
    team_id: web.id,
    title: `Feature ${n}`,
    description: "",
    owner_id: ada.id,
    state: "open",
    rank,
    filed_by: ada.id,
    created_at: at,
    task_counts: { open: 1, claimed: 0, done: 0, dropped: 0 },
    ...extra,
  };
}

export function task(n: number, featureId: string, extra: Partial<Task> = {}): Task {
  return {
    id: `k-${n}`,
    key: `WEB-${n}`,
    feature_id: featureId,
    kind: "work",
    title: `Task ${n}`,
    description: "",
    state: "open",
    status_id: "st-todo",
    skill_id: build.id,
    blocked: false,
    filed_by: ada.id,
    waiting_since: at,
    created_at: at,
    ...extra,
  };
}

export function health(extra: Partial<Health> = {}): Health {
  return { status: "ok", version: "v1.2.0", sign_in_modes: ["printed_link"], ...extra };
}

/**
 * What every signed-in page reads: health, the caller, the Members, Teams and Skills for names, and
 * the shell's reads of every open Task (the live count) and of Features (the Install checklist):
 * none by default.
 */
export function signedIn(member: Member = ada): Record<string, Handler> {
  return {
    "GET /v1/health": health(),
    "GET /v1/me": me(member),
    "GET /v1/members": { items: [ada, bob, builder] },
    "GET /v1/teams": { items: [ops, web] },
    "GET /v1/skills": { items: [build, review] },
    "GET /v1/tasks": { items: [] },
    "GET /v1/features": { items: [] },
  };
}
