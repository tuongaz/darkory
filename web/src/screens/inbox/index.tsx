import { useRouteProject } from "@/app/currentProject";
import { projectCrumb } from "@/app/crumbs";
import { PlaceholderPage } from "@/app/Placeholder";

// M4d builds this folder: the Inbox and My work across Projects, and a Project's Agents and
// Activity. These stand in until then.

const owner = "M4d (Inbox, My work, Agents, Activity)";

/** /inbox, once the Organisation has a Task (the Install checklist before). */
export function InboxPage() {
  return <PlaceholderPage title="Inbox" owner={owner} />;
}

/** /my-work: what the signed-in Member holds, owns and filed, across Projects. */
export function MyWorkPage() {
  return <PlaceholderPage title="My work" owner={owner} />;
}

/** /projects/:key/agents: the Project's agents and their sessions; `?agent=<name>` opens one. */
export function AgentsPage() {
  const project = useRouteProject();
  return <PlaceholderPage title="Agents" owner={owner} crumbs={[projectCrumb(project), { label: "Agents" }]} />;
}

/** /projects/:key/activity: the Project's Activity. */
export function ActivityPage() {
  const project = useRouteProject();
  return <PlaceholderPage title="Activity" owner={owner} crumbs={[projectCrumb(project), { label: "Activity" }]} />;
}
