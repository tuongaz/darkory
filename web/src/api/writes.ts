import { api, call, type Schemas } from "./client";

// The shell's writes, one per /v1 operation: creating a Project, adding Members to it, filing a
// Task, signing out. Run them through `useMutation`: its success refetches every query
// (queryClient.ts), as the stream would for another tab. Members are named by id: a name may hold
// a dot, which the server would read as a file name. Projects are named by key or id.

export const createProject = (body: Schemas["CreateProjectBody"]) => call(api.POST("/v1/projects", { body }));

export const updateProject = (project: string, body: Schemas["UpdateProjectBody"]) =>
  call(api.PATCH("/v1/projects/{project}", { params: { path: { project } }, body }));

export const addProjectMember = (project: string, member: string) =>
  call(api.PUT("/v1/projects/{project}/members/{member}", { params: { path: { project, member } } }));

export const removeProjectMember = (project: string, member: string) =>
  call(api.DELETE("/v1/projects/{project}/members/{member}", { params: { path: { project, member } } }));

export const createMember = (body: Schemas["CreateMemberBody"]) => call(api.POST("/v1/members", { body }));

/** Files a Task, a Subtask (`parent`), or a question beside the Task it blocks (`blocks`). */
export const fileTask = (body: Schemas["FileTaskBody"]) => call(api.POST("/v1/tasks", { body }));

export const logout = () => call(api.POST("/v1/logout"));
