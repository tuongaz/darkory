// The pieces a Task row and a Task card share: its marks, its Feature, who can take it, who holds it.
import { LinkIcon } from "lucide-react";
import type { Feature, Member, Task, TaskBrief } from "@/api/client";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { cn } from "@/lib/utils";
import { liveClaim } from "@/work";
import { shortWhen, type Mark } from "./derive";
import type { BoardModel } from "./model";

export function MarkPill({ mark, now }: { mark: Mark; now: number }) {
  switch (mark.kind) {
    case "blocked":
      return <Pill tone="blocked">Blocked by {mark.by}</Pill>;
    case "lapsed":
      return (
        <Pill tone="dropped">
          <span title={new Date(mark.at).toLocaleString()}>Lapsed {shortWhen(mark.at, now)}</span>
        </Pill>
      );
    case "task-kind":
      return <Pill tone="secondary">{mark.label}</Pill>;
  }
}

/** "blocks WEB-3": a question or Escalation, beside what it holds up. */
export function BlocksPill({ blocks }: { blocks: TaskBrief[] }) {
  if (blocks.length === 0) return null;
  return (
    <Pill tone="secondary">
      <LinkIcon aria-hidden />
      blocks {blocks.map((b) => b.key).join(", ")}
    </Pill>
  );
}

/** The Feature a Task belongs to: its key and title. */
export function FeatureRef({ feature, className }: { feature: Feature | undefined; className?: string }) {
  if (!feature) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground", className)}>
      <Key className="text-[11px]">{feature.key}</Key>
      <span className="truncate">{feature.title}</span>
    </span>
  );
}

/** The Skill a Task needs, as an outline pill. */
export function SkillPill({ task, model }: { task: Task; model: Pick<BoardModel, "skills"> }) {
  const skill = task.skill_id ? model.skills.get(task.skill_id) : undefined;
  if (!skill) return null;
  return <Pill tone="outline">{skill.name}</Pill>;
}

/** "15 min · claude-opus-5-5": a held card's countdown to the lapse and the model the holder named. */
export function HeartbeatLine({ task, now }: { task: Task; now: number }) {
  const claim = liveClaim(task, now);
  if (!claim?.expires_at) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <HeartbeatMeter claim={claim} variant="compact" />
      {claim.model_label && (
        <>
          <span aria-hidden>·</span>
          <span className="truncate">{claim.model_label}</span>
        </>
      )}
    </div>
  );
}

/** "aimed at" and the Member's avatar, for a Task aimed at one Member by name. */
export function AimedAt({ member, withName }: { member: Member; withName?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
      <span className="text-[11.5px] whitespace-nowrap">aimed at</span>
      <MemberAvatar member={member} />
      {withName && <span className="truncate">{member.name}</span>}
    </span>
  );
}
