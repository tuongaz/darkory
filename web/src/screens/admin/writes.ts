import { api, call } from "@/api/client";
import type { components } from "@/api/schema.gen";

type Schemas = components["schemas"];

// Admin's writes, one per /v1 operation. Members are named by id: a name may hold a dot, which
// the server would read as a file name.

export const createMember = (body: Schemas["CreateMemberBody"]) => call(api.POST("/v1/members", { body }));

export const updateMember = (member: string, body: Schemas["UpdateMemberBody"]) =>
  call(api.PATCH("/v1/members/{member}", { params: { path: { member } }, body }));

export const deactivateMember = (member: string) => call(api.POST("/v1/members/{member}/deactivate", { params: { path: { member } } }));

export const reactivateMember = (member: string) => call(api.POST("/v1/members/{member}/reactivate", { params: { path: { member } } }));

export const grantSkill = (member: string, skill: string) =>
  call(api.PUT("/v1/members/{member}/skills/{skill}", { params: { path: { member, skill } } }));

export const revokeSkill = (member: string, skill: string) =>
  call(api.DELETE("/v1/members/{member}/skills/{skill}", { params: { path: { member, skill } } }));

export const setManager = (member: string, manager: string) =>
  call(api.PUT("/v1/members/{member}/manager", { params: { path: { member } }, body: { manager } }));

export const clearManager = (member: string) => call(api.DELETE("/v1/members/{member}/manager", { params: { path: { member } } }));

export const addTeamMember = (team: string, member: string) =>
  call(api.PUT("/v1/teams/{team}/members/{member}", { params: { path: { team, member } } }));

export const removeTeamMember = (team: string, member: string) =>
  call(api.DELETE("/v1/teams/{team}/members/{member}", { params: { path: { team, member } } }));

export const createTeam = (body: Schemas["CreateTeamBody"]) => call(api.POST("/v1/teams", { body }));

export const updateTeam = (team: string, body: Schemas["UpdateTeamBody"]) =>
  call(api.PATCH("/v1/teams/{team}", { params: { path: { team } }, body }));

export const createSkill = (body: Schemas["CreateSkillBody"]) => call(api.POST("/v1/skills", { body }));

export const setAgentSettings = (member: string, body: Schemas["SetAgentSettingsBody"]) =>
  call(api.PATCH("/v1/members/{member}/agent", { params: { path: { member } }, body }));

// Workspaces are named by id, as Members are.
export const createWorkspace = (body: Schemas["CreateWorkspaceBody"]) => call(api.POST("/v1/workspaces", { body }));

export const updateWorkspace = (workspace: string, body: Schemas["UpdateWorkspaceBody"]) =>
  call(api.PATCH("/v1/workspaces/{workspace}", { params: { path: { workspace } }, body }));

export const removeWorkspace = (workspace: string) => call(api.DELETE("/v1/workspaces/{workspace}", { params: { path: { workspace } } }));

export const issueToken = (member: string, name: string, timeout?: number) =>
  call(api.POST("/v1/members/{member}/tokens", { params: { path: { member } }, body: { name, default_heartbeat_timeout_seconds: timeout } }));

export const revokeToken = (token: string) => call(api.POST("/v1/tokens/{token}/revoke", { params: { path: { token } } }));

export const issueLoginLink = (member: string) => call(api.POST("/v1/members/{member}/login-links", { params: { path: { member } } }));

/** Closes a Session by the id its running copy chose; `member` names another Member's (admin). */
export const closeSession = (session: string, member?: string) =>
  call(api.POST("/v1/sessions/{session}/close", { params: { path: { session }, query: member ? { member } : {} } }));

export const setStatuses = (body: Schemas["SetStatusesBody"]) => call(api.PUT("/v1/statuses", { body }));

export const logout = () => call(api.POST("/v1/logout"));
