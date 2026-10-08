import { BookOpenIcon, HeartPulseIcon, InboxIcon, LinkIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { Task, TaskDetail } from "@/api/client";
import { useDirectory, useTakeable } from "@/api/queries";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { EmptyState } from "@/components/EmptyState";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentMe } from "@/me";
import { liveClaim } from "@/work";
import { awaitingComplete, blocksOf, lapsesOn, staleProposals, takeableCap, takeableNow, type Decision, type Lapse } from "./derive";
import { AnswerButton, ClaimButton, CompleteButton, GroupHeader, KindPill, OpenButton, StandsAt, TaskRow } from "./parts";
import { useAimedAt, useOwnedOpen, useRecentActivity, useStepNames, useTaskDetails } from "./queries";

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * /inbox, across Projects: what needs the signed-in Member, section by section, each hidden when
 * it is empty. Questions aimed at them; Tasks they own waiting on their decision (Parents whose
 * Subtasks have all ended, proposals gone stale); Claims on their Tasks that lapsed; and what they
 * can take now. Every row carries its Project's mark; opening one opens its peek, which switches
 * the app to its Project.
 */
export function InboxPage() {
  const me = useCurrentMe();
  const id = me.member.id;
  const now = useNow();
  const dir = useDirectory();
  const steps = useStepNames();
  const aimed = useAimedAt(id);
  const owned = useOwnedOpen(id);
  const takeable = useTakeable();
  const lapses = useRecentActivity({ kind: ["task.lapsed"] }, (e) => e.kind === "task.lapsed");
  const [allTakeable, setAllTakeable] = useState(false);

  const ownedTasks = useMemo(() => owned.data ?? [], [owned.data]);
  // The records a decision needs: each finished Parent's Subtasks (how its Acceptance ended) and
  // each open Retrospective's proposals.
  const looked = ownedTasks.filter((t) => (t.subtask_counts && t.subtask_counts.open === 0) || t.kind === "retrospective");
  const detailQueries = useTaskDetails(looked.map((t) => t.key));
  const details = new Map<string, TaskDetail>(detailQueries.flatMap((q) => (q.data ? [[q.data.task.id, q.data] as const] : [])));

  const reads = [aimed, owned, takeable];
  const failed = reads.find((q) => q.isError);
  const loading = reads.some((q) => q.isPending);

  // A question I have claimed to answer is in My work, held by me.
  const aimedAtMe = (aimed.data ?? []).filter((t) => liveClaim(t, now)?.holder_id !== id);
  const decisions: Decision[] = [...awaitingComplete(ownedTasks, details), ...staleProposals([...details.values()], dir.skills)];
  const lapsed = lapsesOn(ownedTasks, lapses.entries, now);
  const take = takeableNow(takeable.data ?? [], aimedAtMe);
  const takeShown = allTakeable ? take : take.slice(0, takeableCap);
  const nothing = aimedAtMe.length + decisions.length + lapsed.length + take.length === 0;
  // The page's one primary: the first row's action.
  const primary = aimedAtMe.length > 0 ? "answer" : decisions.some((d) => d.kind === "complete") ? "complete" : "claim";
  const project = (t: Task) => dir.projects.get(t.project_id);
  const openTasks = [...(aimed.data ?? []), ...ownedTasks];

  return (
    <>
      <TopBar crumbs={[{ label: "Inbox" }]} />
      <Content>
        <h1 className="sr-only">Inbox</h1>
        {failed ? (
          <Refusal error={failed.error} className="px-6 py-5" />
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
            No questions for you, no decisions waiting, nothing you can take.
          </EmptyState>
        ) : (
          <>
            {aimedAtMe.length > 0 && (
              <section aria-label="Aimed at you">
                <GroupHeader title="Aimed at you" count={aimedAtMe.length} />
                {aimedAtMe.map((t, i) => {
                  const blocks = blocksOf(t, openTasks);
                  const from = t.filed_by ? dir.members.get(t.filed_by) : undefined;
                  return (
                    <TaskRow
                      key={t.id}
                      task={t}
                      project={project(t)}
                      stands={<StandsAt task={t} steps={steps} me={id} />}
                      marks={
                        blocks[0] && (
                          <Pill tone="secondary">
                            <LinkIcon className="size-3" aria-hidden />
                            blocks {blocks[0].key}
                            {blocks.length > 1 && ` +${blocks.length - 1}`}
                          </Pill>
                        )
                      }
                      by={
                        from && (
                          <>
                            from <MemberAvatar member={from} />
                            <span className="truncate">{from.name}</span>
                          </>
                        )
                      }
                      when={t.created_at}
                      whenWhat="Asked"
                      action={<AnswerButton task={t} primary={primary === "answer" && i === 0} />}
                    />
                  );
                })}
              </section>
            )}
            {decisions.length > 0 && (
              <section aria-label="Your decision">
                <GroupHeader title="Your decision" count={decisions.length} />
                {decisions.map((d, i) => (
                  <DecisionRow key={`${d.kind}-${d.task.id}-${i}`} decision={d} project={project(d.task)} steps={steps} primary={primary === "complete" && i === 0} />
                ))}
              </section>
            )}
            {lapsed.length > 0 && (
              <section aria-label="Lapsed on your Tasks">
                <GroupHeader title="Lapsed on your Tasks" count={lapsed.length} />
                {lapsed.map((l) => (
                  <LapseRow key={l.task.id} lapse={l} project={project(l.task)} steps={steps} />
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
                      action={<ClaimButton task={t} primary={primary === "claim" && i === 0} />}
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

/** A Task of mine waiting on my decision: a Parent to Complete, or a proposal gone stale. */
function DecisionRow({ decision: d, project, steps, primary }: { decision: Decision; project: Parameters<typeof TaskRow>[0]["project"]; steps: ReturnType<typeof useStepNames>; primary: boolean }) {
  if (d.kind === "stale") {
    return (
      <TaskRow
        task={d.task}
        project={project}
        stands={<StandsAt task={d.task} steps={steps} />}
        marks={
          <Pill tone="claimed">
            <BookOpenIcon className="size-3" aria-hidden />
            Proposal stale
          </Pill>
        }
        by={<span className="truncate">{`${d.skill} v${d.basedOn} → now v${d.current}`}</span>}
        when={d.task.waiting_since}
        action={<OpenButton task={d.task} />}
      />
    );
  }
  const mark =
    d.acceptance === "done" ? (
      <Pill tone="done">Acceptance passed</Pill>
    ) : d.acceptance === "dropped" ? (
      <Pill tone="dropped">Acceptance dropped</Pill>
    ) : (
      <Pill tone="secondary">Subtasks ended</Pill>
    );
  return (
    <TaskRow
      task={d.task}
      project={project}
      stands={<StandsAt task={d.task} steps={steps} />}
      marks={mark}
      by={<span className="truncate">awaits your Complete</span>}
      when={d.task.waiting_since}
      // An Acceptance that did not pass is a decision to read first, not a click.
      action={d.acceptance === "dropped" ? <OpenButton task={d.task} /> : <CompleteButton task={d.task} primary={primary} />}
    />
  );
}

/** A Claim on a Task of mine that lapsed and nobody has taken up again. */
function LapseRow({ lapse, project, steps }: { lapse: Lapse; project: Parameters<typeof TaskRow>[0]["project"]; steps: ReturnType<typeof useStepNames> }) {
  const { members } = useDirectory();
  const holder = lapse.holderId ? members.get(lapse.holderId) : undefined;
  return (
    <TaskRow
      task={lapse.task}
      project={project}
      stands={<StandsAt task={lapse.task} steps={steps} />}
      marks={
        <Pill tone="dropped">
          <HeartPulseIcon className="size-3" aria-hidden />
          Lapsed <time dateTime={lapse.at}>{clock.format(new Date(lapse.at))}</time>
        </Pill>
      }
      by={
        holder && (
          <>
            held by <MemberAvatar member={holder} />
            <span className="truncate">{holder.name}</span>
          </>
        )
      }
      when={lapse.at}
      whenWhat="Lapsed"
      action={<OpenButton task={lapse.task} />}
    />
  );
}
