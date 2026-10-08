import { api, call, type Schemas } from "@/api/client";

// Settings' writes, one per /v1 operation; the shell's own (createProject, updateProject,
// createMember, the Project's Members, logout) are in @/api/writes. Members and Workspaces are
// named by id: a name may hold a dot, which the server would read as a file name.

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

export const createSkill = (body: Schemas["CreateSkillBody"]) => call(api.POST("/v1/skills", { body }));

export const setAgentSettings = (member: string, body: Schemas["SetAgentSettingsBody"]) =>
  call(api.PATCH("/v1/members/{member}/agent", { params: { path: { member } }, body }));

export const clearAgentSettings = (member: string) => call(api.DELETE("/v1/members/{member}/agent", { params: { path: { member } } }));

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

/** Defines a Label: the Organisation's, or a Project's own when `project` (key or id) is given. */
export const createLabel = (body: Schemas["CreateLabelBody"], project?: string) =>
  project
    ? call(api.POST("/v1/projects/{project}/labels", { params: { path: { project } }, body }))
    : call(api.POST("/v1/labels", { body }));

export const updateLabel = (label: string, body: Schemas["UpdateLabelBody"]) =>
  call(api.PATCH("/v1/labels/{label}", { params: { path: { label } }, body }));

export const deleteLabel = (label: string) => call(api.DELETE("/v1/labels/{label}", { params: { path: { label } } }));
