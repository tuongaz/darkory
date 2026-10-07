import type { Member } from "@/api/client";
import { initials, tintOf } from "@/lib/members";
import { cn } from "@/lib/utils";

export type AvatarSize = "sm" | "md" | "lg";

const sizes: Record<AvatarSize, { box: string; agent: string }> = {
  sm: { box: "size-5 text-[9px]", agent: "rounded-[6px]" },
  md: { box: "size-7 text-[11px]", agent: "rounded-[8px]" },
  lg: { box: "size-10 text-sm", agent: "rounded-[10px]" },
};

/**
 * A Member's mark: round initials for a human, square initials with the violet agent border for
 * an agent, each on a muted tint of its own (by name), so "RT" for retro and "RT" for reviewer-tax
 * differ.
 */
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
  const tint = tintOf(member.name);
  return (
    <span
      role="img"
      aria-label={member.kind === "agent" ? `${member.name} (agent)` : member.name}
      title={member.name}
      data-kind={member.kind}
      data-tint={tint}
      className={cn(
        "avatar-tint inline-grid flex-none place-items-center border font-semibold leading-none select-none",
        `tint-${tint}`,
        s.box,
        member.kind === "agent" ? cn("border-agent-border", s.agent) : "rounded-full",
        className,
      )}
    >
      {initials(member)}
    </span>
  );
}
