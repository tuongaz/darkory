import { BookOpenIcon, InboxIcon, LinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Feature, Member, Task, Team } from "@/api/client";
import { useDirectory, useOpenTasks } from "@/api/queries";
import { usePeekLink } from "@/app/peek";
import { Content, TopBar } from "@/app/TopBar";
import { useNow } from "@/clock";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Refusal } from "@/components/Refusal";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { liveClaim } from "@/work";
import { blocksOf, featureBar, skillOf, featuresIOwn, myProposals, retrospectivesIn, takeableNow, type OwnedFeature } from "./derive";
import { AnswerButton, ClaimButton, FeatureCell, GroupHeader, KindPill, NoneLine, RowLink, ShortTime, StatusCell } from "./parts";
import { useAimedAt, useFeatureMap, useHeldBy, useOwnedFeatures, useStatuses, useTakeable, useTaskDetails, type StatusView } from "./queries";

// Kit `.irow`: Status · key · title · marks · Feature · from / Skill · time · action, on one 36px
// line. On a phone a row keeps the Status glyph, the title and the action.
const taskGrid =
  "relative grid h-9 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-b pr-4 pl-6 hover:bg-accent md:grid-cols-[128px_52px_minmax(0,1fr)_auto_190px_150px_44px_72px]";
const wide = "hidden md:flex";

/** /inbox: what needs me first, section by section, each hidden when it is empty. */
export function InboxPage() {
  const me = useCurrentMe();
  const id = me.member.id;
  const aimed = useAimedAt(id);
  const held = useHeldBy(id);
  const takeable = useTakeable();
  const owned = useOwnedFeatures(id);
  const open = useOpenTasks();
  const features = useFeatureMap();
  const statuses = useStatuses();
  const { members, skills, teams } = useDirectory();

  const teamIds = new Set(me.teams.map((t) => t.id));
  const retrospectives = retrospectivesIn(open.data ?? [], features, teamIds);
  const details = useTaskDetails(retrospectives.map((t) => t.key));
  const proposals = myProposals(details.flatMap((d) => (d.data ? [d.data] : [])), id);

  const reads = [aimed, held, takeable, owned, open];
  const failed = reads.find((q) => q.isError);
  const loading = reads.some((q) => q.isPending);

  const now = useNow();
  // A question I have claimed to answer is held by me, and listed there.
  const aimedAtMe = (aimed.data ?? []).filter((t) => liveClaim(t, now)?.holder_id !== id);
  const heldByMe = held.data ?? [];
  const { shown: takeNow, total: takeTotal } = takeableNow(takeable.data ?? [], aimedAtMe);
  const mine = featuresIOwn(owned.data ?? [], open.data ?? []);
  // The page's one primary: the first row's action.
  const primary = aimedAtMe.length > 0 ? "answer" : "claim";

  return (
    <>
      <TopBar crumbs={[{ label: "Inbox" }]} />
      <Content>
        <h1 className="sr-only">Inbox</h1>
        {failed ? (
          <Refusal error={failed.error} className="px-6 py-5" />
        ) : loading ? (
          <div className="flex flex-col gap-2 px-6 py-5">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : (
          <>
            {aimedAtMe.length === 0 && heldByMe.length === 0 && <NoneLine icon={<InboxIcon />}>No questions for you · You hold nothing</NoneLine>}
            {aimedAtMe.length > 0 && (
              <section aria-label="Aimed at me">
                <GroupHeader title="Aimed at me" count={aimedAtMe.length} />
                {aimedAtMe.map((t, i) => (
                  <AimedRow
                    key={t.id}
                    task={t}
                    status={statuses.get(t.status_id)}
                    feature={features.get(t.feature_id)}
                    from={members.get(t.filed_by)}
                    blocks={blocksOf(t, open.data ?? [])}
                    primary={i === 0}
                  />
                ))}
              </section>
            )}
            {heldByMe.length > 0 && (
              <section aria-label="Held by me">
                <GroupHeader title="Held by me" count={heldByMe.length} />
                {heldByMe.map((t) => (
                  <HeldRow key={t.id} task={t} status={statuses.get(t.status_id)} feature={features.get(t.feature_id)} skill={skillOf(t, skills)} />
                ))}
              </section>
            )}
            {takeNow.length > 0 && (
              <section aria-label="Takeable now">
                <GroupHeader
                  title="Takeable now"
                  count={takeTotal}
                  actions={
                    takeTotal > takeNow.length && (
                      <Link to="/my-work" className="text-xs font-normal text-muted-foreground hover:text-foreground hover:underline">
                        {takeTotal - takeNow.length} more in My work
                      </Link>
                    )
                  }
                />
                {takeNow.map((t, i) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    status={statuses.get(t.status_id)}
                    marks={<KindPill task={t} />}
                    feature={features.get(t.feature_id)}
                    by={skillOf(t, skills) && <Pill tone="outline">{skillOf(t, skills)}</Pill>}
                    when={t.waiting_since}
                    action={<ClaimButton task={t} primary={primary === "claim" && i === 0} />}
                  />
                ))}
              </section>
            )}
            {mine.length > 0 && (
              <section aria-label="Features I own">
                <GroupHeader title="Features I own" count={mine.length} />
                {mine.map((o) => (
                  <OwnedRow key={o.feature.id} owned={o} members={members} teams={teams} statuses={statuses} />
                ))}
              </section>
            )}
            {proposals.length > 0 && (
              <section aria-label="My proposals">
                <GroupHeader title="My proposals" count={proposals.length} />
                {proposals.map(({ task: t, proposal }) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    status={statuses.get(t.status_id)}
                    marks={
                      <Pill tone="secondary">
                        <BookOpenIcon className="size-3" aria-hidden />
                        Proposal · {skills.get(proposal!.skill_id)?.name ?? "Skill"} v{proposal!.based_on_version + 1}
                      </Pill>
                    }
                    feature={features.get(t.feature_id)}
                    by={skillOf(t, skills) && <Pill tone="outline">{skillOf(t, skills)}</Pill>}
                    when={proposal!.created_at}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </Content>
    </>
  );
}

/** One Task as the Inbox lists it, on one line; the title opens its peek, where its text is. */
export function TaskRow({
  task,
  status,
  marks,
  feature,
  by,
  when,
  action,
}: {
  task: Task;
  status: StatusView | undefined;
  marks?: ReactNode;
  feature: Feature | undefined;
  by?: ReactNode;
  when?: string;
  action?: ReactNode;
}) {
  const peek = usePeekLink();
  return (
    <div className={taskGrid}>
      <StatusCell status={status} className="[&>span:last-child]:hidden md:[&>span:last-child]:inline" />
      <Key className="hidden md:block">{task.key}</Key>
      <span className="flex min-w-0">
        <RowLink to={peek(task.key)}>{task.title}</RowLink>
      </span>
      <span className={cn(wide, "items-center gap-1.5")}>{marks}</span>
      <FeatureCell className={wide} feature={feature} />
      <span className={cn(wide, "min-w-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground")}>{by}</span>
      <ShortTime className="hidden text-right md:block" at={when} />
      <span className="flex justify-end">{action}</span>
    </div>
  );
}

/** A question or Escalation aimed at me: what it blocks and who asked; Answer claims and opens it. */
function AimedRow({
  task,
  status,
  feature,
  from,
  blocks,
  primary,
}: {
  task: Task;
  status: StatusView | undefined;
  feature: Feature | undefined;
  from: Member | undefined;
  blocks: Task[];
  primary: boolean;
}) {
  return (
    <TaskRow
      task={task}
      status={status}
      marks={
        blocks[0] && (
          <Pill tone="secondary">
            <LinkIcon className="size-3" aria-hidden />
            blocks {blocks[0].key}
            {blocks.length > 1 && ` +${blocks.length - 1}`}
          </Pill>
        )
      }
      feature={feature}
      by={
        from && (
          <>
            from <MemberAvatar member={from} />
            <span className="truncate">{from.name}</span>
          </>
        )
      }
      when={task.created_at}
      action={<AnswerButton task={task} primary={primary} />}
    />
  );
}

/** A Task I hold: a browser Claim has no expiry; a Claim with a timeout shows its Heartbeat. */
export function HeldRow({ task, status, feature, skill }: { task: Task; status: StatusView | undefined; feature: Feature | undefined; skill?: string }) {
  const now = useNow();
  const claim = liveClaim(task, now);
  return (
    <TaskRow
      task={task}
      status={status}
      marks={
        claim &&
        (claim.expires_at ? <HeartbeatMeter claim={claim} variant="compact" className="text-xs" /> : <Pill tone="outline">No expiry</Pill>)
      }
      feature={feature}
      by={skill && <Pill tone="outline">{skill}</Pill>}
      when={claim?.started_at}
    />
  );
}

// Kit `.frow`: Rank (with the Team, as two Teams each have a #1) · key · title · bar · counts ·
// what it waits on.
const featureGrid =
  "relative grid h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-b pr-4 pl-6 hover:bg-accent md:grid-cols-[128px_52px_minmax(0,1fr)_90px_170px_minmax(0,370px)]";

/** A Feature I own: how far along it is, and the one thing it waits on. */
function OwnedRow({
  owned,
  members,
  teams,
  statuses,
}: {
  owned: OwnedFeature;
  members: Map<string, Member>;
  teams: Map<string, Team>;
  statuses: Map<string, StatusView>;
}) {
  const { feature: f, blocked, breakdown, retrospective } = owned;
  const team = teams.get(f.team_id);
  const now = useNow();
  const bar = featureBar(f);
  const c = f.task_counts;
  const counts = [`${c.done} done`, `${c.open} open`, ...(c.dropped ? [`${c.dropped} dropped`] : [])].join(" · ");
  const holder = breakdown && liveClaim(breakdown, now);
  return (
    <div className={featureGrid}>
      <span className="hidden truncate text-muted-foreground tabular-nums md:block" title={`Rank #${f.rank} in ${team?.name ?? "its Team"}`}>
        {team?.name} #{f.rank}
      </span>
      <Key className="hidden md:block">{f.key}</Key>
      <span className="flex min-w-0 items-center gap-2">
        <RowLink to={`/features/${f.key}`}>{f.title}</RowLink>
        {f.state === "shipped" && <Pill tone="done">Shipped</Pill>}
        {f.state === "dropped" && <Pill tone="dropped">Dropped</Pill>}
      </span>
      <span
        role="img"
        aria-label={counts}
        className="hidden h-1.5 w-[90px] overflow-hidden rounded-[3px] bg-muted md:flex [&>i]:block [&>i]:h-full"
      >
        <i className="bg-state-done" style={{ width: `${bar.done * 100}%` }} />
        <i className="bg-state-claimed" style={{ width: `${bar.held * 100}%` }} />
        <i className="bg-muted-foreground/35" style={{ width: `${bar.waiting * 100}%` }} />
      </span>
      <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums md:text-sm">{counts}</span>
      <span className={cn(wide, "min-w-0 items-center gap-1.5 whitespace-nowrap")}>
        {blocked > 0 && <Pill tone="blocked">{blocked} blocked</Pill>}
        {breakdown && (
          <>
            <span className="text-muted-foreground">Break down</span>
            <Key>{breakdown.key}</Key>
            {holder ? (
              <>
                <span className="text-muted-foreground">held by</span>
                {members.get(holder.holder_id) && <MemberAvatar member={members.get(holder.holder_id)!} />}
                <span className="truncate">{members.get(holder.holder_id)?.name}</span>
                <HeartbeatMeter claim={holder} variant="compact" className="text-xs" />
              </>
            ) : (
              <Pill tone="waiting">Waiting</Pill>
            )}
          </>
        )}
        {retrospective && (
          <>
            <span className="text-muted-foreground">Retrospective</span>
            <Key>{retrospective.key}</Key>
            <StatusCell status={statuses.get(retrospective.status_id)} />
          </>
        )}
      </span>
    </div>
  );
}
