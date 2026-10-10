import type { Task } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentMe } from "@/me";
import { liveClaim } from "@/work";
import { ownedParents, progressText } from "./derive";
import { AnswerButton, GroupHeader, KindPill, NoneLine, StandsAt, TaskRow } from "./parts";
import { useAimedAt, useHeldBy, useOwnedOpen, useStepNames } from "./queries";

/**
 * /my-work, across Projects: what the signed-in Member holds, what is aimed at them, and the
 * Parents they own with how far along each is. Every row carries its Project's mark.
 */
export function MyWorkPage() {
  const me = useCurrentMe();
  const id = me.member.id;
  const now = useNow();
  const dir = useDirectory();
  const steps = useStepNames();
  const held = useHeldBy(id);
  const aimed = useAimedAt(id);
  const owned = useOwnedOpen(id);
  const reads = [held, aimed, owned];
  const failed = reads.find((q) => q.isError);
  const holding = (held.data ?? []).filter((t) => liveClaim(t, now)?.holder_id === id);
  const heldIds = new Set(holding.map((t) => t.id));
  const aimedAtMe = (aimed.data ?? []).filter((t) => !heldIds.has(t.id));
  const parents = ownedParents(owned.data ?? []);
  const project = (t: Task) => dir.projects.get(t.project_id);

  return (
    <>
      <TopBar crumbs={[{ label: "My work" }]} />
      <Content>
        <h1 className="sr-only">My work</h1>
        {failed ? (
          <Refusal error={failed.error} className="px-6 py-5" />
        ) : reads.some((q) => q.isPending) ? (
          <div className="flex flex-col gap-2 px-6 py-5" aria-busy>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : (
          <>
            <section aria-label="Held by you">
              <GroupHeader title="Held by you" count={holding.length} />
              {holding.length === 0 && <NoneLine>You hold nothing</NoneLine>}
              {holding.map((t) => {
                const claim = liveClaim(t, now);
                const skill = claim?.skill_id ? dir.skills.get(claim.skill_id)?.name : undefined;
                return (
                  <TaskRow
                    key={t.id}
                    task={t}
                    project={project(t)}
                    stands={<StandsAt task={t} steps={steps} me={id} />}
                    // A Claim with no expiry is said once, by when it was claimed.
                    marks={claim?.expires_at && <HeartbeatMeter claim={claim} variant="compact" className="text-xs" />}
                    by={skill && <Pill tone="outline">{skill}</Pill>}
                    when={claim?.started_at}
                    whenWhat="Claimed"
                  />
                );
              })}
            </section>
            <section aria-label="Aimed at you">
              <GroupHeader title="Aimed at you" count={aimedAtMe.length} />
              {aimedAtMe.length === 0 && <NoneLine>No questions for you</NoneLine>}
              {aimedAtMe.map((t, i) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  project={project(t)}
                  stands={<StandsAt task={t} steps={steps} me={id} />}
                  marks={<KindPill task={t} />}
                  by={t.filed_by && <span className="truncate">from {dir.members.get(t.filed_by)?.name ?? "a Member"}</span>}
                  when={t.created_at}
                  whenWhat="Asked"
                  action={<AnswerButton task={t} primary={holding.length === 0 && i === 0} />}
                />
              ))}
            </section>
            <section aria-label="You own">
              <GroupHeader title="You own" count={parents.length} />
              {parents.length === 0 && <NoneLine>You own no open Parent</NoneLine>}
              {parents.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  project={project(t)}
                  stands={<ProgressBar task={t} />}
                  marks={t.subtask_counts && t.subtask_counts.working > 0 && <Pill tone="claimed">{t.subtask_counts.working} working</Pill>}
                  by={t.subtask_counts && <span className="truncate tabular-nums">{progressText(t.subtask_counts)}</span>}
                  when={t.created_at}
                  whenWhat="Filed"
                />
              ))}
            </section>
          </>
        )}
      </Content>
    </>
  );
}

/** A Parent's Subtasks as a bar: done, worked, open and not worked, out of all of them; beside it the row says the numbers in words. */
function ProgressBar({ task }: { task: Task }) {
  const c = task.subtask_counts;
  if (!c) return null;
  const total = c.open + c.done + c.dropped;
  const share = (n: number) => `${total === 0 ? 0 : (n / total) * 100}%`;
  return (
    <span className="flex items-center gap-2">
      <span role="img" aria-label={progressText(c)} className="flex h-1.5 w-[72px] overflow-hidden rounded-[3px] bg-muted [&>i]:block [&>i]:h-full">
        <i className="bg-state-done" style={{ width: share(c.done) }} />
        <i className="bg-state-claimed" style={{ width: share(c.working) }} />
        <i className="bg-muted-foreground/35" style={{ width: share(c.open - c.working) }} />
      </span>
      {/* A phone has no room for the words beside it; there the bar keeps its numbers. */}
      <span className="tabular-nums md:hidden">{`${c.done}/${total}`}</span>
    </span>
  );
}
