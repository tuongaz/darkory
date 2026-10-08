import {
  ArrowRightIcon,
  BanIcon,
  CheckIcon,
  CircleHelpIcon,
  EyeIcon,
  FileDiffIcon,
  HashIcon,
  LinkIcon,
  ListPlusIcon,
  PaperclipIcon,
  RotateCcwIcon,
  UserRoundCogIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { Member, Task } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { usePeekLink } from "@/app/peek";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import type { TaskAction } from "./actions";

/** A Member as avatar and name; "· you" after the signed-in Member. */
export function MemberName({ id, you = true, className }: { id: string | undefined; you?: boolean; className?: string }) {
  const { members } = useDirectory();
  const me = useCurrentMe();
  const m: Member | undefined = id ? members.get(id) : undefined;
  if (!m) return <span className={cn("text-muted-foreground", className)}>Unknown</span>;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <MemberAvatar member={m} />
      <span className="truncate">{m.name}</span>
      {you && m.id === me.member.id && <span className="whitespace-nowrap text-muted-foreground">· you</span>}
    </span>
  );
}

/** A Member's avatar alone, or the empty slot for an unknown one. */
export function Avatar({ id }: { id: string | undefined }) {
  const { members } = useDirectory();
  const m = id ? members.get(id) : undefined;
  return m ? <MemberAvatar member={m} /> : <span className="size-5" />;
}

export function SkillPill({ id }: { id: string | undefined }) {
  const { skills } = useDirectory();
  const name = id ? skills.get(id)?.name : undefined;
  return name ? <Pill tone="outline">{name}</Pill> : null;
}

/**
 * Another Task, by key and title, opening its peek over the page in view. The title truncates,
 * or with `wrap` runs on to more lines (the 320px rail).
 */
export function TaskLink({ task, children, wrap, className }: { task: Pick<Task, "key" | "title">; children?: ReactNode; wrap?: boolean; className?: string }) {
  const peek = usePeekLink();
  return (
    <Link to={peek(task.key)} className={cn("inline-flex max-w-full min-w-0 items-baseline gap-1.5 hover:underline", className)}>
      {children ?? (
        <>
          <Key>{task.key}</Key>
          <span className={wrap ? "min-w-0 [overflow-wrap:anywhere]" : "truncate"}>{task.title}</span>
        </>
      )}
    </Link>
  );
}

const labels: Record<TaskAction, { label: string; icon: LucideIcon }> = {
  claim: { label: "Claim", icon: CheckIcon },
  advance: { label: "Advance", icon: ArrowRightIcon },
  complete: { label: "Complete", icon: CheckIcon },
  release: { label: "Release", icon: RotateCcwIcon },
  move: { label: "Move to a Step", icon: ArrowRightIcon },
  rank: { label: "Rank", icon: HashIcon },
  "pass-ownership": { label: "Pass ownership", icon: UserRoundCogIcon },
  "add-blocker": { label: "Add blocker", icon: LinkIcon },
  "attach-evidence": { label: "Attach Evidence", icon: PaperclipIcon },
  observe: { label: "Record Observation", icon: EyeIcon },
  "file-subtask": { label: "File Subtask", icon: ListPlusIcon },
  "ask-question": { label: "Ask a question", icon: CircleHelpIcon },
  propose: { label: "Propose a Skill version", icon: FileDiffIcon },
  "take-back": { label: "Take back", icon: RotateCcwIcon },
  drop: { label: "Drop Task", icon: BanIcon },
};

/** A Task action as a menu item; with `reason` it is dimmed, the pill saying why. */
export function ActionItem({ action, reason, onSelect }: { action: TaskAction; reason?: string; onSelect: () => void }) {
  const { label, icon: Icon } = labels[action];
  return (
    <DropdownMenuItem disabled={!!reason} onSelect={onSelect} variant={action === "drop" && !reason ? "destructive" : "default"}>
      <Icon />
      {label}
      {reason && (
        <Pill tone="secondary" className="ml-auto">
          {reason}
        </Pill>
      )}
    </DropdownMenuItem>
  );
}
