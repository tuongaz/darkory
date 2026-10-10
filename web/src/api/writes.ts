import { api, call, type Schemas } from "./client";

// The app's writes outside a Task's own actions, one per /v1 operation: Projects and their
// Members, Workflows, Members, Skills, agents' settings, tokens and Sessions, Workspaces, Labels,
// filing a Task, signing out. Run them through `useMutation`: its success refetches every query
// (queryClient.ts), as the stream would for another tab. Members and Workspaces are named by id: a
// name may hold a dot, which the server would read as a file name. Projects are named by key or id.

export const createProject = (body: Schemas["CreateProjectBody"]) => call(api.POST("/v1/projects", { body }));

export const updateProject = (project: string, body: Schemas["UpdateProjectBody"]) =>
  call(api.PATCH("/v1/projects/{project}", { params: { path: { project } }, body }));

export const addProjectMember = (project: string, member: string) =>
  call(api.PUT("/v1/projects/{project}/members/{member}", { params: { path: { project, member } } }));

export const removeProjectMember = (project: string, member: string) =>
  call(api.DELETE("/v1/projects/{project}/members/{member}", { params: { path: { project, member } } }));

/** Replaces the Project's whole Workflow (admin); answers with it as `GET` does. */
export const setWorkflow = (project: string, body: Schemas["SetWorkflowBody"]) =>
  call(api.PUT("/v1/projects/{project}/workflow", { params: { path: { project } }, body }));

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

export const createSkill = (body: Schemas["CreateSkillBody"]) => call(api.POST("/v1/skills", { body }));

/** Sets the Project an own Skill belongs to (admin); `""` makes it the Organisation's. */
export const updateSkill = (skill: string, body: Schemas["UpdateSkillBody"]) =>
  call(api.PATCH("/v1/skills/{skill}", { params: { path: { skill } }, body }));

export const setAgentSettings = (member: string, body: Schemas["SetAgentSettingsBody"]) =>
  call(api.PATCH("/v1/members/{member}/agent", { params: { path: { member } }, body }));

export const clearAgentSettings = (member: string) => call(api.DELETE("/v1/members/{member}/agent", { params: { path: { member } } }));

export const createWorkspace = (body: Schemas["CreateWorkspaceBody"]) => call(api.POST("/v1/workspaces", { body }));

export const updateWorkspace = (workspace: string, body: Schemas["UpdateWorkspaceBody"]) =>
  call(api.PATCH("/v1/workspaces/{workspace}", { params: { path: { workspace } }, body }));

export const removeWorkspace = (workspace: string) => call(api.DELETE("/v1/workspaces/{workspace}", { params: { path: { workspace } } }));

export const issueToken = (member: string, body: Schemas["IssueTokenBody"]) =>
  call(api.POST("/v1/members/{member}/tokens", { params: { path: { member } }, body }));

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

/** Files a Task, a Subtask (`parent`), or a question beside the Task it blocks (`blocks`). */
export const fileTask = (body: Schemas["FileTaskBody"]) => call(api.POST("/v1/tasks", { body }));

export const logout = () => call(api.POST("/v1/logout"));
