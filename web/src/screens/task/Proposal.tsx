import { FileTextIcon, TriangleAlertIcon } from "lucide-react";
import type { SkillProposal, TaskDetail } from "@/api/client";
import { useTasks } from "@/api/queries";
import { SectionHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { ClockTime } from "@/components/Time";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { diffSummary, lineDiff } from "./diff";
import { useMemberName, useSkillName } from "./format";
import { Avatar, TaskLink } from "./parts";
import { useObservations, useSkillVersions } from "./queries";
import { OutcomePill } from "./TaskRecord";
import { Markdown } from "@/components/Markdown";

const states: Record<SkillProposal["state"], { label: string; tone: "waiting" | "done" | "dropped" }> = {
  pending: { label: "Pending review", tone: "waiting" },
  published: { label: "Published", tone: "done" },
  superseded: { label: "Superseded", tone: "dropped" },
};

/**
 * A proposal on a Retrospective, one per Skill, as a diff against the version it was written on,
 * with its state and what advancing the review into Done does.
 */
export function ProposalCard({ detail, proposal }: { detail: TaskDetail; proposal: SkillProposal }) {
  const skill = useSkillName();
  const name = useMemberName();
  const versions = useSkillVersions(proposal.skill_id);
  const base = versions.data?.find((v) => v.version === proposal.based_on_version);
  const current = versions.data?.[0];
  const next = proposal.based_on_version + 1;
  const diff = base ? lineDiff(base.body, proposal.body) : undefined;
  const state = states[proposal.state];
  // The base moved on: publishing would be refused with proposal_stale.
  const stale = proposal.state === "pending" && current && current.version !== proposal.based_on_version;
  const reviewing = skill(detail.task.skill_id) === "skill-review" && detail.task.state === "open";
  return (
    <section aria-label={`Proposal for ${skill(proposal.skill_id) ?? "a Skill"}`} className="flex flex-col gap-3 rounded-md border px-4 py-3">
      <header className="flex flex-wrap items-center gap-2">
        <FileTextIcon className="size-4 text-muted-foreground" aria-hidden />
        <b className="font-semibold">Proposal</b>
        <span className="text-muted-foreground">
          {skill(proposal.skill_id)} version {proposal.state === "published" ? (proposal.published_version ?? next) : next}
        </span>
        <Pill tone={state.tone}>{state.label}</Pill>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Avatar id={proposal.author_id} />
          {name(proposal.author_id)} · <ClockTime at={proposal.created_at} />
        </span>
      </header>
      <p className="text-xs text-muted-foreground">
        Against version {proposal.based_on_version}
        {diff && ` · ${diffSummary(diff)}`}
      </p>
      {versions.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : diff ? (
        <pre aria-label="Changes" className="overflow-x-auto rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre-wrap">
          {diff.map((l, i) => (
            <span
              key={i}
              data-op={l.op}
              className={cn("block", l.op === "add" && "bg-state-done-bg text-state-done", l.op === "del" && "bg-state-blocked-bg text-state-blocked line-through")}
            >
              {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
              {l.text}
            </span>
          ))}
        </pre>
      ) : (
        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre-wrap">{proposal.body}</pre>
      )}
      {stale ? (
        <p role="alert" className="flex items-center gap-2 text-xs text-state-claimed">
          <TriangleAlertIcon className="size-3.5" aria-hidden />
          Version {current.version} is current now. Publishing is refused; propose again against it.
        </p>
      ) : (
        proposal.state === "pending" && reviewing && <p className="text-xs text-muted-foreground">Advancing this review into Done publishes version {next}</p>
      )}
    </section>
  );
}

/** The Observations a Retrospective reads: its Parent's, unreviewed or reviewed by it. */
export function RetrospectiveObservations({ detail }: { detail: TaskDetail }) {
  const { task, parent } = detail;
  const all = useObservations(parent?.key);
  const name = useMemberName();
  const skill = useSkillName();
  // The Subtasks the Observations were recorded on, beside the Parent itself.
  const siblings = useTasks({ parent: parent?.key ?? "" }, { enabled: !!parent }).data ?? [];
  if (!parent) return null;
  const on = new Map<string, { key: string; title: string }>([[parent.id, parent], ...siblings.map((t) => [t.id, t] as [string, { key: string; title: string }])]);
  const items = (all.data ?? []).filter((o) => !o.reviewed_by_task_id || o.reviewed_by_task_id === task.id);
  return (
    <section aria-label={`Observations on ${parent.key}`} className="flex flex-col gap-2">
      <SectionHeader title={`Observations on ${parent.key}`} count={all.data ? items.length : undefined} />
      {all.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">None yet</p>
      ) : (
        items.map((o) => (
          <article key={o.id} className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
            <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <OutcomePill outcome={o.outcome} />
              <Avatar id={o.author_id} />
              <span>{name(o.author_id)}</span>
              {on.get(o.task_id) && <TaskLink task={on.get(o.task_id)!} />}
              {skill(o.skill_id) && <span>under {skill(o.skill_id)}</span>}
              <ClockTime at={o.created_at} />
            </header>
            <Markdown text={o.body} />
          </article>
        ))
      )}
    </section>
  );
}
