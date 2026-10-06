import {
  BanIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  EyeIcon,
  FileDiffIcon,
  LinkIcon,
  PaperclipIcon,
  RotateCcwIcon,
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
import { StatusGlyph } from "@/components/StatusGlyph";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import type { TaskAction } from "./actions";
import { statusGlyph, useMemberName, type StatusLike } from "./format";

export function StatusLabel({ status, statuses }: { status: StatusLike; statuses: StatusLike[] | undefined }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <StatusGlyph glyph={statusGlyph(status, statuses)} label={status.name} />
      <span className="truncate">{status.name}</span>
    </span>
  );
}

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

/** What a Task needs: its Skill, or the Member it is aimed at. `short` reads "aimed at you" without the avatar. */
export function Needs({ task, short }: { task: Pick<Task, "skill_id" | "aimed_at_id">; short?: boolean }) {
  const me = useCurrentMe();
  const name = useMemberName();
  if (task.aimed_at_id) {
    if (short) {
      return <span className="truncate text-muted-foreground">aimed at {task.aimed_at_id === me.member.id ? "you" : name(task.aimed_at_id)}</span>;
    }
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="text-muted-foreground">aimed at</span>
        <MemberName id={task.aimed_at_id} />
      </span>
    );
  }
  return <SkillPill id={task.skill_id} />;
}

/**
 * Another Task, by key and title, opening its peek over the page in view. The title truncates,
 * or with `wrap` runs on to more lines (the 300px rail).
 */
export function TaskLink({
  task,
  children,
  wrap,
  className,
}: {
  task: Pick<Task, "key" | "title">;
  children?: ReactNode;
  wrap?: boolean;
  className?: string;
}) {
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
  complete: { label: "Complete", icon: CheckIcon },
  "hand-over": { label: "Hand over", icon: RotateCcwIcon },
  release: { label: "Release", icon: RotateCcwIcon },
  observe: { label: "Record Observation", icon: EyeIcon },
  "attach-evidence": { label: "Attach Evidence", icon: PaperclipIcon },
  "add-blocker": { label: "Add blocker", icon: LinkIcon },
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

export type ChoiceOption = { value: string; label: ReactNode };

/**
 * One choice among a few, as a dialog's field (a Skill, a Status): a field-shaped button that
 * opens a menu of the options. It stands in for the Select primitive, whose Radix viewport adds a
 * <style> element the Install's Content-Security-Policy refuses.
 */
export function Choice({
  id,
  value,
  onChange,
  options,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: ChoiceOption[];
  placeholder: string;
}) {
  const chosen = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          id={id}
          type="button"
          className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
            {chosen ? chosen.label : <span className="text-muted-foreground">{placeholder}</span>}
          </span>
          <ChevronsUpDownIcon className="size-4 flex-none text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-(--radix-dropdown-menu-trigger-width) overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A Status glyph beside a name that already says it: hidden from screen readers. */
export function GlyphOf({ status, statuses }: { status: StatusLike; statuses: StatusLike[] | undefined }) {
  return (
    <span aria-hidden className="inline-flex">
      <StatusGlyph glyph={statusGlyph(status, statuses)} />
    </span>
  );
}
