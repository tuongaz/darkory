import { Link } from "react-router";
import type { Schemas } from "@/api/client";
import { useHealth, useMembers, useProjects, useRunnerSessions, useWorkspaces } from "@/api/queries";
import { projectSettingsPath, useCurrentProject } from "@/app/currentProject";
import { PageHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { Loaded } from "@/components/Refusal";
import { Time } from "@/components/Time";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentMe } from "@/me";
import { SettingsFrame } from "./frame";
import { count } from "./model";
import { SettingsForm, SettingsRow } from "./parts";

const signInNames: Record<Schemas["SignInMode"], string> = {
  printed_link: "Printed links: darkory serve prints them and admins issue them",
  email_link: "Emailed links, on request",
};

/**
 * Settings › Organisation › Install: the facts of the server this Organisation runs on: its
 * release and whether a newer one exists, how humans sign in, whether a Runner is attached and
 * what it runs, and what the Install holds.
 */
export function InstallPage() {
  const me = useCurrentMe();
  const health = useHealth();
  const runner = useRunnerSessions();
  const members = useMembers();
  const projects = useProjects();
  const workspaces = useWorkspaces();
  const current = useCurrentProject();
  const active = (members.data ?? []).filter((m) => !m.deactivated_at);
  return (
    <SettingsFrame crumbs={[{ label: "Install" }]}>
      <div className="max-w-[820px]">
        <PageHeader
          title={me.organisation.name}
          meta={
            <span>
              Organisation since <Time at={me.organisation.created_at} />
            </span>
          }
        />
        <SettingsForm label="Install">
          <SettingsRow label="Version">
            <Loaded query={health} loading={<Skeleton className="h-4 w-24" />}>
              {(h) => (
                <>
                  <code className="font-mono text-xs">{h.version}</code>
                  {h.update_available ? (
                    <Pill tone="claimed">{h.latest_version ? `${h.latest_version} available` : "Update available"}</Pill>
                  ) : h.update_available === false ? (
                    <span className="text-muted-foreground">The newest release</span>
                  ) : (
                    <span className="text-muted-foreground">Not checked for updates</span>
                  )}
                </>
              )}
            </Loaded>
          </SettingsRow>
          <SettingsRow label="Sign-in">
            <Loaded query={health} loading={<Skeleton className="h-4 w-40" />}>
              {(h) => (
                <ul className="flex flex-col gap-1">
                  {h.sign_in_modes.map((m) => (
                    <li key={m}>{signInNames[m] ?? m}</li>
                  ))}
                </ul>
              )}
            </Loaded>
          </SettingsRow>
          <SettingsRow
            label="Runner"
            help={
              runner.data?.runner === false
                ? "Agents work through their own tokens. darkory serve starts one beside the Tracker unless --runner=off."
                : "It starts the sessions of agents with Runner settings; see Agents."
            }
          >
            <Loaded query={runner} loading={<Skeleton className="h-4 w-24" />}>
              {(r) =>
                r.runner ? (
                  <>
                    <Pill tone="done">Attached</Pill>
                    <span className="text-muted-foreground">{count(r.items.length, "session")} running</span>
                  </>
                ) : (
                  <Pill tone="dropped">Not attached</Pill>
                )
              }
            </Loaded>
          </SettingsRow>
          <SettingsRow label="Holds">
            <span>{members.data ? count(active.length, "Member") : "…"}</span>
            <span className="text-muted-foreground">·</span>
            <span>{projects.data ? count(projects.data.length, "Project") : "…"}</span>
            <span className="text-muted-foreground">·</span>
            {current ? (
              <Link to={projectSettingsPath(current, "workspaces")} className="hover:underline">
                {workspaces.data ? count(workspaces.data.length, "Workspace") : "…"}
              </Link>
            ) : (
              <span>{workspaces.data ? count(workspaces.data.length, "Workspace") : "…"}</span>
            )}
          </SettingsRow>
        </SettingsForm>
      </div>
    </SettingsFrame>
  );
}
