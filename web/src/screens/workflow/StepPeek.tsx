import { ArrowRightIcon, SettingsIcon, TriangleAlertIcon } from "lucide-react";
import { Link, useLocation } from "react-router";
import type { Project } from "@/api/client";
import { useMembers, useRunnerSessions, useTasks } from "@/api/queries";
import { workflowsSettingsPath } from "@/app/currentProject";
import { peekParam } from "@/app/peek";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { SectionHeader } from "@/components/PageHeader";
import { Peek } from "@/components/Peek";
import { Pill } from "@/components/Pill";
import { Property, PropertiesRail } from "@/components/PropertiesRail";
import { Loaded } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { WorkGlyph } from "@/components/WorkGlyph";
import { outgoing, targetName, unstaffed, waitingAt, type Step, type Workflow } from "@/components/workflow/model";
import { spanText } from "@/lib/time";
import { NoWayOut } from "@/components/workflow/nodes";
import { glyphLabel } from "@/lib/work";
import { useCurrentMe } from "@/me";
import { taskWorkGlyph } from "@/work";

/** The search parameter that opens a Step's peek over the live canvas: its id. */
export const stepParam = "step";

/**
 * A Step opened from the live canvas: the Tasks at it now (each opens its own peek), who takes
 * them, the median time a Task spends there, and the outcomes out of it; for an admin, Edit in
 * Settings, which opens the same Step on the editing canvas.
 */
export function StepPeek({ project, workflow, step, onClose }: { project: Project; workflow: Workflow; step: Step; onClose: () => void }) {
  const admin = useCurrentMe().member.admin;
  const out = outgoing(workflow, step.id);
  return (
    <Peek
      open
      onOpenChange={(o) => !o && onClose()}
      label={`Step ${step.name}`}
      heading={
        <>
          <span className="truncate font-semibold">{step.name}</span>
          {step.skill ? <Pill tone="outline">{step.skill.name}</Pill> : <Pill>Hold</Pill>}
        </>
      }
      actions={
        admin && (
          <Button asChild variant="outline" size="xs">
            <Link to={workflowsSettingsPath(project, step.workflow_id, { [stepParam]: step.id })}>
              <SettingsIcon />
              Edit in Settings
            </Link>
          </Button>
        )
      }
    >
      <PropertiesRail>
        <Property label="Skill">
          {step.skill ? step.skill.name : <span className="text-muted-foreground">None: a hold, its Tasks moved on by hand</span>}
        </Property>
        <Property label="Tasks">
          {step.tasks === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            `${waitingAt(step)} waiting · ${step.working} working`
          )}
        </Property>
        <Property label="Median time">
          {step.medianMs !== undefined ? (
            <span title="The median time Tasks that left it in the last 30 days spent here">{spanText(step.medianMs)}</span>
          ) : (
            <span className="text-muted-foreground">No Task has left it in 30 days</span>
          )}
        </Property>
      </PropertiesRail>

      <section className="flex flex-col gap-2">
        <SectionHeader title="Takers" count={step.skill ? step.takers.length : undefined} />
        {!step.skill ? (
          <p className="text-muted-foreground">Nobody is offered a Task at a hold; a human moves it on.</p>
        ) : unstaffed(step) ? (
          <p className="flex items-center gap-1.5 font-medium text-state-claimed">
            <TriangleAlertIcon aria-hidden className="size-3.5" />
            No Member of {project.name} has {step.skill.name}: its Tasks wait for nobody.
          </p>
        ) : (
          <ul aria-label={`Takers at ${step.name}`} className="flex flex-col gap-1">
            {step.takers.map((t) => (
              <li key={t.id} className="flex h-7 min-w-0 items-center gap-2">
                <MemberAvatar member={t} working={t.working} />
                <span className="truncate">{t.name}</span>
                {t.kind === "agent" && <Pill tone="agent">Agent</Pill>}
                {t.working && <span className="ml-auto text-xs text-muted-foreground">Working here</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <StepTasks project={project} step={step} />

      <section className="flex flex-col gap-2">
        <SectionHeader title="Outcomes" count={out.length} />
        {out.length === 0 ? (
          step.skill ? (
            <NoWayOut />
          ) : (
            <p className="text-muted-foreground">No Connector out: a human moves its Tasks on.</p>
          )
        ) : (
          <ul aria-label={`Outcomes out of ${step.name}`} className="flex flex-col gap-1">
            {out.map((c) => (
              <li key={c.id} className="flex h-7 min-w-0 items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <ArrowRightIcon aria-hidden className="size-3 flex-none text-muted-foreground" />
                <span className="truncate text-muted-foreground">{targetName(workflow, c.to)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Peek>
  );
}

/** The open Tasks at the Step now, in the Project's order; each opens its own peek in place of this one. */
function StepTasks({ project, step }: { project: Project; step: Step }) {
  const tasks = useTasks({ project: project.key, state: "open", step: step.id });
  const members = useMembers();
  const sessions = useRunnerSessions();
  const now = useNow();
  const location = useLocation();
  const link = (key: string) => {
    const params = new URLSearchParams(location.search);
    params.delete(stepParam);
    params.set(peekParam, key);
    return { pathname: location.pathname, search: `?${params}` };
  };
  const kindOf = (id: string) => members.data?.find((m) => m.id === id)?.kind;
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader title="Tasks here now" count={tasks.data?.length} />
      <Loaded query={tasks}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-muted-foreground">No Task is at {step.name}.</p>
          ) : (
            <ul aria-label={`Tasks at ${step.name}`} className="-mx-2 flex flex-col">
              {list.map((t) => {
                const glyph = taskWorkGlyph(t, now, kindOf, sessions.data?.items.find((s) => s.task_id === t.id)?.state);
                return (
                  <li key={t.id}>
                    <Link
                      to={link(t.key)}
                      aria-label={`${t.key} ${t.title}, ${glyphLabel(glyph)}`}
                      className="flex h-8 min-w-0 items-center gap-2 rounded-md px-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <WorkGlyph glyph={glyph} />
                      <Key>{t.key}</Key>
                      <span className="min-w-0 truncate">{t.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loaded>
    </section>
  );
}
