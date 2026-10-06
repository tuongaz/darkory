import type { Member } from "@/api/client";
import { initials } from "@/lib/members";
import { cn } from "@/lib/utils";

export type AvatarSize = "sm" | "md" | "lg";

const sizes: Record<AvatarSize, { box: string; agent: string }> = {
  sm: { box: "size-5 text-[9px]", agent: "rounded-[6px]" },
  md: { box: "size-7 text-[11px]", agent: "rounded-[8px]" },
  lg: { box: "size-10 text-sm", agent: "rounded-[10px]" },
};

/** A Member's mark: round initials for a human, square violet initials for an agent. */
export function MemberAvatar({
  member,
  size = "sm",
  className,
}: {
  member: Pick<Member, "name" | "kind">;
  size?: AvatarSize;
  className?: string;
}) {
  const s = sizes[size];
  return (
    <span
      role="img"
      aria-label={member.kind === "agent" ? `${member.name} (agent)` : member.name}
      title={member.name}
      data-kind={member.kind}
      className={cn(
        "inline-grid flex-none place-items-center border font-semibold leading-none select-none",
        s.box,
        member.kind === "agent"
          ? cn("border-agent-border bg-agent-bg text-agent", s.agent)
          : "rounded-full border-border bg-secondary text-secondary-foreground",
        className,
      )}
    >
      {initials(member)}
    </span>
  );
}
