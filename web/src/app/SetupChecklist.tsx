import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useMembers, useProjects } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { useCurrentProject } from "./currentProject";
import { sendIntent } from "./intents";
import { Content, TopBar } from "./TopBar";

/**
 * The three steps that set up an Install, shown in the Inbox until the Organisation has a Task:
 * with none, the Inbox would be empty. `darkory init` always makes MAIN, with or without agents, so
 * on a fresh Install step 1 is done.
 */
export function SetupChecklist() {
  const me = useCurrentMe();
  const projects = useProjects();
  const members = useMembers();
  const project = useCurrentProject();
  const hasProject = (projects.data?.length ?? 0) > 0;
  const hasMembers = (members.data?.length ?? 0) > 1;
  const admin = me.member.admin;
  const next = !hasProject ? 1 : !hasMembers ? 2 : 3;
  return (
    <>
      <TopBar crumbs={[{ label: "Inbox" }]} />
      <Content pad>
        <section
          aria-labelledby="setup-heading"
          className="mx-auto mt-6 flex max-w-[640px] flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground"
        >
          <div>
            <h1 id="setup-heading" className="text-[15px] font-semibold">
              Set up {me.organisation.name}
            </h1>
            <p className="text-muted-foreground">Three steps, then agents can pull work.</p>
          </div>
          <ol className="flex flex-col">
            <Step n={1} done={hasProject} title="Create a Project" help="Its key starts every Task key: MAIN-1. It comes with a Workflow.">
              {admin && (
                <Button variant={next === 1 ? "default" : "outline"} onClick={() => sendIntent({ kind: "new-project" })}>
                  Create Project
                </Button>
              )}
            </Step>
            <Step n={2} done={hasMembers} title="Add a Member" help="Humans sign in by link; agents get a token.">
              {admin && (
                <StepButton enabled={hasProject} primary={next === 2} to="/settings/organisation/members?new=1">
                  Add Member
                </StepButton>
              )}
            </Step>
            <Step n={3} done={false} title="File a Task" help="It waits at its Project's first work Step for a Member with that Skill.">
              <Button
                variant={next === 3 ? "default" : "outline"}
                disabled={next !== 3}
                onClick={() => sendIntent({ kind: "file-task", project: project?.key })}
              >
                File Task
              </Button>
            </Step>
          </ol>
          {!admin && next < 3 && <p className="text-xs text-muted-foreground">An admin creates Projects and Members.</p>}
        </section>
      </Content>
    </>
  );
}

function Step({ n, done, title, help, children }: { n: number; done: boolean; title: string; help: string; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-t py-3.5 first:border-t-0">
      <span
        aria-label={done ? `Step ${n}, done` : `Step ${n}`}
        className={cn(
          "grid size-6 place-items-center rounded-full border text-2xs font-semibold text-muted-foreground",
          done && "border-state-done bg-state-done text-on-solid",
        )}
      >
        {done ? <CheckIcon className="size-3" strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0">
        <b className="block font-semibold">{title}</b>
        <small className="text-xs text-muted-foreground">{help}</small>
      </div>
      {children}
    </li>
  );
}

/** A step's link-button, dimmed until the step before it is done. */
function StepButton({ enabled, primary, to, children }: { enabled: boolean; primary: boolean; to: string; children: ReactNode }) {
  if (!enabled) {
    return (
      <Button variant="outline" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant={primary ? "default" : "outline"}>
      <Link to={to}>{children}</Link>
    </Button>
  );
}
