import type { Feature, Task } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { usePeekLink } from "@/app/peek";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentMe } from "@/me";
import { sinceText, skillOf } from "./derive";
import { HeldRow } from "./Inbox";
import { ClaimButton, FeatureCell, GroupHeader, NoneLine, RowLink, StatusCell } from "./parts";
import { useFeatureMap, useHeldBy, useStatuses, useTakeable, type StatusView } from "./queries";

// Kit `.mrow`: Status · key · title · Feature · Rank · Skill · Waiting · Claim.
const queueGrid =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-b pr-4 pl-6 md:grid-cols-[128px_52px_minmax(0,1fr)_200px_56px_110px_72px_72px]";
const wide = "hidden md:block";

/** /my-work: what I hold, then everything I can take now, in the order `next` would offer it. */
export function MyWorkPage() {
  const me = useCurrentMe();
  const held = useHeldBy(me.member.id);
  const takeable = useTakeable();
  const features = useFeatureMap();
  const statuses = useStatuses();
  const { skills } = useDirectory();
  const failed = [held, takeable].find((q) => q.isError);
  const holding = held.data ?? [];
  const queue = takeable.data ?? [];

  return (
    <>
      <TopBar crumbs={[{ label: "My work" }]} />
      <Content>
        <h1 className="sr-only">My work</h1>
        {failed ? (
          <Refusal error={failed.error} className="px-6 py-5" />
        ) : held.isPending || takeable.isPending ? (
          <div className="flex flex-col gap-2 px-6 py-5">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : (
          <>
            <section aria-label="Held by me">
              <GroupHeader title="Held by me" count={holding.length} />
              {holding.length === 0 && <NoneLine>You hold no Claims.</NoneLine>}
              {holding.map((t) => (
                <HeldRow key={t.id} task={t} status={statuses.get(t.status_id)} feature={features.get(t.feature_id)} skill={skillOf(t, skills)} />
              ))}
            </section>
            <section aria-label="Takeable now">
              <GroupHeader title="Takeable now" count={queue.length} />
              {queue.length === 0 ? (
                <NoneLine>Nothing takeable.</NoneLine>
              ) : (
                <div role="table" aria-label="Takeable now">
                  <div role="row" className={`${queueGrid} h-8 bg-muted text-xs font-medium text-muted-foreground`}>
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Task</span>
                    <span role="columnheader" className={wide} aria-hidden />
                    <span role="columnheader" className={wide}>
                      Feature
                    </span>
                    <span role="columnheader" className={wide}>
                      Rank
                    </span>
                    <span role="columnheader" className={wide}>
                      Skill
                    </span>
                    <span role="columnheader" className={`${wide} text-right`}>
                      Waiting
                    </span>
                    <span role="columnheader" aria-hidden />
                  </div>
                  {queue.map((t, i) => (
                    <QueueRow
                      key={t.id}
                      task={t}
                      status={statuses.get(t.status_id)}
                      feature={features.get(t.feature_id)}
                      skill={skillOf(t, skills)}
                      primary={i === 0}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </Content>
    </>
  );
}

function QueueRow({
  task,
  status,
  feature,
  skill,
  primary,
}: {
  task: Task;
  status: StatusView | undefined;
  feature: Feature | undefined;
  skill?: string;
  primary: boolean;
}) {
  const peek = usePeekLink();
  const now = useNow();
  return (
    <div role="row" className={`${queueGrid} relative min-h-10 hover:bg-accent`}>
      <span role="cell" className="flex">
        <StatusCell status={status} className="[&>span:last-child]:hidden md:[&>span:last-child]:inline" />
      </span>
      <span role="cell" className={wide}>
        <Key>{task.key}</Key>
      </span>
      <span role="cell" className="flex min-w-0">
        <RowLink to={peek(task.key)}>{task.title}</RowLink>
      </span>
      <span role="cell" className={wide}>
        <FeatureCell feature={feature} />
      </span>
      <span role="cell" className={`${wide} text-muted-foreground tabular-nums`}>
        {feature && `#${feature.rank}`}
      </span>
      <span role="cell" className={wide}>
        {skill && <Pill tone="outline">{skill}</Pill>}
      </span>
      <span role="cell" className={`${wide} text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums`}>
        {sinceText(now - new Date(task.waiting_since).getTime())}
      </span>
      <span role="cell" className="flex justify-end">
        <ClaimButton task={task} primary={primary} />
      </span>
    </div>
  );
}
