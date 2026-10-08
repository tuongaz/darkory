import { api, call, type Schemas } from "@/api/client";

// The Workflow screens' writes, one per /v1 operation. The shell's (`@/api/writes`) cover the
// Project's Members and creating a Member; these cover the Workflow itself and what its panel
// does for a Step's Skill: Skills, granting one, an agent's Runner settings and its first token.
// Members and Skills are named by id.

/** Replaces the Project's whole Workflow (admin); answers with it as `GET` does. */
export const setWorkflow = (project: string, body: Schemas["SetWorkflowBody"]) =>
  call(api.PUT("/v1/projects/{project}/workflow", { params: { path: { project } }, body }));

export const createSkill = (body: Schemas["CreateSkillBody"]) => call(api.POST("/v1/skills", { body }));

export const grantSkill = (member: string, skill: string) =>
  call(api.PUT("/v1/members/{member}/skills/{skill}", { params: { path: { member, skill } } }));

export const setAgentSettings = (member: string, body: Schemas["SetAgentSettingsBody"]) =>
  call(api.PATCH("/v1/members/{member}/agent", { params: { path: { member } }, body }));

export const issueToken = (member: string, body: Schemas["IssueTokenBody"]) =>
  call(api.POST("/v1/members/{member}/tokens", { params: { path: { member } }, body }));
