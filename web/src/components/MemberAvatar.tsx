import { forwardRef, useContext, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { fileURL, type Member } from "@/api/client";
import { MemberCard } from "@/components/MemberCard";
import { MemberCards } from "@/components/memberCards";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { initials, tintOf } from "@/lib/members";
import { cn } from "@/lib/utils";
import { workingWords, type Working } from "@/lib/work";
import { useAvatarFile } from "./avatars";

export type AvatarSize = "sm" | "md" | "lg";

const sizes: Record<AvatarSize, string> = {
  sm: "size-5 text-[9px]",
  md: "size-7 text-[11px]",
  lg: "size-10 text-sm",
};

type MarkMember = Pick<Member, "name" | "kind"> & { id?: string; avatar_file_id?: string };

/**
 * A Member's mark: initials on a muted tint of its own (by name, so "RT" for retro and "RT" for
 * reviewer-tax differ), round, in a ring: a plain line for a human, a thick ring in the AI
 * gradient for an agent, thicker as the mark grows (`.avatar-tint` in globals.css). The ring is
 * drawn inside the size's box, so an agent's mark takes no more room than a human's.
 *
 * `working` is for a standalone mark (the Agents page, a canvas or graph node), which says itself
 * that its Member works, where a row's glyph would: an agent's ring turns while its session runs
 * and stops amber (`waiting`), red (`stalled`) or grey (`ending`); `held` is a human's live Claim,
 * a still ring. Reduced motion stops the turning.
 *
 * A Member with an Avatar shows it inside the same ring, cut round; the initials
 * stand in when the image cannot load. A brief shape of a Member (a holder, a taker) finds its
 * Avatar by id (`avatars.ts`).
 *
 * A mark whose Member has an `id` opens the Member's hover card (`MemberCard`) on hover after
 * 300 ms, on keyboard focus, and on a tap. Standing alone it is a tab stop; inside a button or a
 * link it opens on hover only, leaving the focus and the tap to what it sits in; inside a menu
 * option or a picker row, where hover means choose, it opens nothing. `card={false}` turns it off
 * (a picker's icon, the Member's own page).
 */
export function MemberAvatar({
  member,
  size = "sm",
  working,
  className,
  card = true,
}: {
  member: MarkMember;
  size?: AvatarSize;
  working?: Working;
  className?: string;
  card?: boolean;
}) {
  const cards = useContext(MemberCards);
  if (card && cards && member.id) return <CardMark member={member} id={member.id} size={size} working={working} className={className} />;
  return <Mark member={member} size={size} working={working} className={className} title={member.name} />;
}

type MarkProps = { member: MarkMember; size: AvatarSize; working?: Working } & Omit<ComponentProps<"span">, "children">;

const Mark = forwardRef<HTMLSpanElement, MarkProps>(function Mark({ member, size, working, className, ...rest }, ref) {
  const tint = tintOf(member.name);
  const file = useAvatarFile(member);
  const [broken, setBroken] = useState<string>();
  const image = file && broken !== file ? file : undefined;
  const name = member.kind === "agent" ? `${member.name} (agent)` : member.name;
  return (
    <span
      ref={ref}
      role="img"
      aria-label={working ? `${name}, ${workingWords[working]}` : name}
      data-kind={member.kind}
      data-size={size}
      data-tint={tint}
      data-working={working}
      data-avatar={image ? "image" : undefined}
      {...rest}
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
});

/** Where a mark sits: alone, inside a control (a button, a link), or inside a choice (a menu option, a picker row). */
type Place = "alone" | "control" | "choice";

const choice = '[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[cmdk-item]';
const control = 'a[href],button,[role="button"],[role="link"],[role="tab"],[role="row"][tabindex],[data-task]';

function CardMark({ member, id, size, working, className }: { member: MarkMember; id: string; size: AvatarSize; working?: Working; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place>("alone");
  const touch = useRef(false);

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    setPlace(parent.closest(choice) ? "choice" : parent.closest(control) ? "control" : "alone");
  }, []);

  const alone = place === "alone";
  return (
    <HoverCard open={place !== "choice" && open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <Mark
          ref={ref}
          member={member}
          size={size}
          working={working}
          data-card=""
          tabIndex={alone ? 0 : undefined}
          onPointerDown={(e) => {
            touch.current = e.pointerType === "touch";
          }}
          onClick={(e) => {
            // Radix's hover card leaves touch out; a tap on a mark standing alone opens it instead.
            if (!alone || !touch.current) return;
            e.preventDefault();
            setOpen((o) => !o);
          }}
          className={cn(alone && "cursor-default outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring", className)}
        />
      </HoverCardTrigger>
      {place !== "choice" && (
        <HoverCardContent side="bottom" align="start" className="w-80" aria-label={`${member.name}'s card`}>
          <MemberCard id={id} />
        </HoverCardContent>
      )}
    </HoverCard>
  );
}
