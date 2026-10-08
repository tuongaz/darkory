// The pieces a Task row, a Task card and a Task's page share: its Labels, its marks, its Parent,
// what it blocks, its Evidence count, its Owner and holder.
import { LinkIcon, PaperclipIcon } from "lucide-react";
import type { Label, Member, Task, TaskBrief } from "@/api/client";
import { HeartbeatMeter } from "@/components/HeartbeatMeter";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { shortWhen } from "@/lib/time";
import { cn } from "@/lib/utils";
import { liveClaim } from "@/work";
import type { Mark } from "./derive";

/** A Label: its colour as a dot, then its name. The colour is the record's, drawn through the CSSOM. */
export function LabelPill({ label, className }: { label: Pick<Label, "name" | "color">; className?: string }) {
  return (
    <span
      data-label={label.name}
      className={cn("inline-flex h-5 max-w-36 min-w-0 flex-none items-center gap-1.5 rounded-full border px-2 text-2xs whitespace-nowrap text-foreground", className)}
    >
      <span aria-hidden className="size-2 flex-none rounded-full" style={{ backgroundColor: label.color }} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** A Task's Labels, by name, those it names that still exist. */
export function LabelPills({ ids, labels, className }: { ids: string[] | undefined; labels: Map<string, Label>; className?: string }) {
  const shown = (ids ?? []).flatMap((id) => labels.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
  if (shown.length === 0) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1 overflow-hidden", className)} aria-label={`Labels: ${shown.map((l) => l.name).join(", ")}`}>
      {shown.map((l) => (
        <LabelPill key={l.id} label={l} />
      ))}
    </span>
  );
}

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

/** The Parent a Subtask belongs to: its key and title on one line, the whole title on hover. */
export function ParentRef({ parent, className }: { parent: Pick<Task, "key" | "title"> | undefined; className?: string }) {
  if (!parent) return null;
  return (
    <span title={`${parent.key} ${parent.title}`} className={cn("flex min-w-0 items-center gap-1 text-[11.5px] text-muted-foreground", className)}>
      <Key className="text-[11px]">{parent.key}</Key>
      <span className="truncate">{parent.title}</span>
    </span>
  );
}

/** "📎 3": how much Evidence is attached. */
export function EvidenceCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums" title={`${count} Evidence attached`} aria-label={`${count} Evidence`}>
      <PaperclipIcon className="size-3" aria-hidden />
      {count}
    </span>
  );
}

/** "lapses in 15 min · claude-opus-5-5": a held Task's countdown to the lapse and the model its holder named. */
export function HeartbeatLine({ task, now }: { task: Task; now: number }) {
  const claim = liveClaim(task, now);
  if (!claim?.expires_at) return null;
  return (
    <>
      <HeartbeatMeter claim={claim} variant="compact" />
      {claim.model_label && (
        <span className="min-w-0 truncate" title={claim.model_label}>
          · {claim.model_label}
        </span>
      )}
    </>
  );
}

/**
 * Who a Task is with: its holder's mark (the glyph already says how they work), or the Member it
 * is aimed at; then its Owner, small and behind, when the Owner is someone else.
 */
export function People({ holder, aimed, owner }: { holder?: Member; aimed?: Member; owner?: Member }) {
  const face = holder ?? aimed;
  return (
    <span className="flex items-center -space-x-1">
      {face && (
        <span title={holder ? `Held by ${face.name}` : `Aimed at ${face.name}`} className="relative z-10 inline-flex">
          <MemberAvatar member={face} />
        </span>
      )}
      {owner && owner.id !== face?.id && (
        <span title={`Owner ${owner.name}`} className={cn("inline-flex", face && "opacity-70")}>
          <MemberAvatar member={owner} />
        </span>
      )}
    </span>
  );
}
