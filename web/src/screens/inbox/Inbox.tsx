import { InboxIcon, LinkIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { Project, Task } from "@/api/client";
import { useDirectory, useTakeable } from "@/api/queries";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentMe } from "@/me";
import { ActButton } from "@/screens/workflow/panels/NeedCard";
import { consequence, type NeedItem } from "@/screens/workflow/panels/needs";
import { ageText } from "@/lib/time";
import { useNeeds } from "@/screens/workflow/panels/useNeeds";
import { PullRequestChip } from "@/components/PullRequestChip";
import { awaitingMerge, takeableCap } from "./derive";
import { AnswerButton, ClaimButton, GroupHeader, KindPill, MergeAct, StandsAt, TaskRow } from "./parts";
import { useAwaitingMerge, useStepNames } from "./queries";
import { liveClaim } from "@/work";

/**
 * /inbox, across Projects: what needs the signed-in Member, then what they can take. Needs you
 * lists, in the order the Workflow's Needs you uses (what unblocks most first, then what only
 * they can move, then the rest, oldest first) and in its words: questions aimed at them, Parents
 * whose Subtasks have all ended, proposals waiting on them, Tasks they own that no Member could
 * take, and the holds and paused-agent waits only they can move. A lapse another Member can take
 * up clears itself and is not listed. Every row carries its Project's mark; opening one opens its
 * peek, which switches the app to its Project.
 */
export function InboxPage() {
  const me = useCurrentMe();
  const id = me.member.id;
  const dir = useDirectory();
  const steps = useStepNames();
  const needs = useNeeds();
  const now = useNow();
  const takeable = useTakeable();
  const landing = useAwaitingMerge(id);
  const [allTakeable, setAllTakeable] = useState(false);

  const failed = [takeable, landing].find((q) => q.isError)?.error ?? needs.error;
  const loading = takeable.isPending || landing.isPending || needs.loading;

  // Across Projects, a hold or a paused agent's wait is listed only where nobody else could move it;
  // a question I have claimed to answer is in My work, held by me.
  const items = needs.items.filter((i) => ((i.act !== "move" && i.act !== "resume") || i.onlyMe) && !(i.act === "answer" && liveClaim(i.task, now)?.holder_id === id));
  const merges = awaitingMerge(landing.data ?? [], id);
  const listed = new Set(items.map((i) => i.task.id));
  const take = (takeable.data ?? []).filter((t) => !listed.has(t.id));
  const takeShown = allTakeable ? take : take.slice(0, takeableCap);
  const needCount = items.length + merges.length;
  const nothing = needCount + take.length === 0;
  const project = (t: Task) => dir.projects.get(t.project_id);

  return (
    <>
      <TopBar crumbs={[{ label: "Inbox" }]} />
      <Content>
        <h1 className="sr-only">Inbox</h1>
        {failed ? (
          <Refusal error={failed} className="px-6 py-5" />
        ) : loading ? (
          <div className="flex flex-col gap-2 px-6 py-5" aria-busy>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : nothing ? (
          <EmptyState
            icon={<InboxIcon />}
            title="Nothing needs you"
            action={
              <Button asChild variant="outline">
                <Link to="/my-work">My work</Link>
              </Button>
            }
          >
            No questions for you, no decisions or merges waiting, nothing you can take.
          </EmptyState>
        ) : (
          <>
            {needCount > 0 && (
              <section aria-label="Needs you">
                <GroupHeader title="Needs you" count={needCount} />
                {items.map((item, i) => (
                  <NeedRow key={item.task.id} item={item} project={project(item.task)} steps={steps} me={id} primary={i === 0} />
                ))}
                {merges.map((m, i) => (
                  <TaskRow
                    key={m.task.id}
                    task={m.task}
                    project={project(m.task)}
                    marks={<PullRequestChip pr={m.pr} className="relative z-10" />}
                    by="Awaits your merge"
                    when={m.task.ended_at}
                    whenWhat="Done"
                    action={<MergeAct task={m.task} primary={items.length === 0 && i === 0} />}
                  />
                ))}
              </section>
            )}
            {take.length > 0 && (
              <section aria-label="Takeable by you">
                <GroupHeader
                  title="Takeable by you"
                  count={take.length}
                  actions={
                    take.length > takeableCap && (
                      <Button variant="link" size="xs" className="h-auto px-0 text-xs font-normal text-muted-foreground" onClick={() => setAllTakeable((on) => !on)}>
                        {allTakeable ? "Show fewer" : `Show all ${take.length}`}
                      </Button>
                    )
                  }
                />
                {takeShown.map((t, i) => {
                  const skill = t.skill_id ? dir.skills.get(t.skill_id)?.name : undefined;
                  return (
                    <TaskRow
                      key={t.id}
                      task={t}
                      project={project(t)}
                      stands={<StandsAt task={t} steps={steps} me={id} />}
                      marks={<KindPill task={t} />}
                      by={skill && <Pill tone="outline">{skill}</Pill>}
                      when={t.waiting_since}
                      whenWhat="Waiting since"
                      action={<ClaimButton task={t} primary={needCount === 0 && i === 0} />}
                    />
                  );
                })}
              </section>
            )}
          </>
        )}
      </Content>
    </>
  );
}

const ageWords: Record<NeedItem["ageLabel"], string> = { asked: "Asked", held: "Held since", waiting: "Waiting since", ready: "Ready since", lapsed: "Lapsed" };

/**
 * One decision as the Inbox lists it, in Needs you's words: what acting on it does ("unblocks
 * WEB-3", "lands 2 Subtasks"), why it is with me ("Question from builder", "Held in Backlog"), how
 * old it is, and its one act. A question's Answer claims it and opens its peek to write the answer:
 * a row has no room for the box a card carries.
 */
function NeedRow({ item, project, steps, me, primary }: { item: NeedItem; project: Project | undefined; steps: ReturnType<typeof useStepNames>; me: string; primary: boolean }) {
  const now = useNow();
  return (
    <TaskRow
      task={item.task}
      project={project}
      stands={<StandsAt task={item.task} steps={steps} me={me} />}
      marks={
        <span className="inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap text-state-waiting">
          {item.unblocks.length > 0 && <LinkIcon className="size-3" aria-hidden />}
          {consequence(item)}
        </span>
      }
      by={
        <span className="truncate" title={`${ageWords[item.ageLabel]} ${ageText(now - Date.parse(item.since))} ago`}>
          {item.why}
        </span>
      }
      when={item.since}
      whenWhat={ageWords[item.ageLabel]}
      action={item.act === "answer" ? <AnswerButton task={item.task} primary={primary} /> : <ActButton item={item} primary={primary} />}
    />
  );
}
