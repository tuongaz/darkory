import { useState } from "react";
import { fileURL, type Member } from "@/api/client";
import { initials, tintOf } from "@/lib/members";
import { cn } from "@/lib/utils";
import type { Working } from "@/lib/work";
import { useAvatarFile } from "./avatars";

export type AvatarSize = "sm" | "md" | "lg";

const sizes: Record<AvatarSize, string> = {
  sm: "size-5 text-[9px]",
  md: "size-7 text-[11px]",
  lg: "size-10 text-sm",
};

const workingWords: Record<Working, string> = {
  running: "working",
  waiting: "working, its session waiting",
  stalled: "working, its session stalled",
  ending: "its session ending",
  held: "working",
};

/**
 * A Member's mark: initials on a muted tint of its own (by name, so "RT" for retro and "RT" for
 * reviewer-tax differ), round, in a ring: a plain line for a human, the AI gradient for an agent
 * (`.avatar-tint` in globals.css).
 *
 * `working` is for a standalone mark (the Agents page, a canvas or graph node), which says itself
 * that its Member works, where a row's glyph would: an agent's ring turns while its session runs
 * and stops amber (`waiting`), red (`stalled`) or grey (`ending`); `held` is a human's live Claim,
 * a still ring. Reduced motion stops the turning.
 *
 * A Member with an Avatar shows it inside the same ring, cut round; the initials
 * stand in when the image cannot load. A brief shape of a Member (a holder, a taker) finds its
 * Avatar by id (`avatars.ts`).
 */
export function MemberAvatar({
  member,
  size = "sm",
  working,
  className,
}: {
  member: Pick<Member, "name" | "kind"> & { id?: string; avatar_file_id?: string };
  size?: AvatarSize;
  working?: Working;
  className?: string;
}) {
  const tint = tintOf(member.name);
  const file = useAvatarFile(member);
  const [broken, setBroken] = useState<string>();
  const image = file && broken !== file ? file : undefined;
  const name = member.kind === "agent" ? `${member.name} (agent)` : member.name;
  return (
    <span
      role="img"
      aria-label={working ? `${name}, ${workingWords[working]}` : name}
      title={member.name}
      data-kind={member.kind}
      data-tint={tint}
      data-working={working}
      data-avatar={image ? "image" : undefined}
      className={cn(
        "avatar-tint inline-grid flex-none place-items-center rounded-full font-semibold leading-none select-none",
        `tint-${tint}`,
        sizes[size],
        className,
      )}
    >
      {image ? (
        <img src={fileURL(image)} alt="" draggable={false} onError={() => setBroken(image)} className="size-full rounded-full object-cover" />
      ) : (
        initials(member)
      )}
    </span>
  );
}
