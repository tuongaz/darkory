import type { Project } from "@/api/client";
import { ProjectMark } from "@/components/ProjectMark";
import { projectPath } from "./currentProject";
import type { Crumb } from "./TopBar";

/**
 * The crumb a Project's pages lead with: its mark and name, linking to its Tasks unless `link` is
 * false (on the Tasks page itself).
 */
export function projectCrumb(project: Project, link = true): Crumb {
  return { label: project.name, icon: <ProjectMark project={project} />, to: link ? projectPath(project, "tasks") : undefined };
}
