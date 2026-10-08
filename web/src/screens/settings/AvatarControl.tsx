import { useMutation } from "@tanstack/react-query";
import { CameraIcon } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { toast } from "sonner";
import type { Member } from "@/api/client";
import { avatarProblem, avatarTypes, uploadFile } from "@/api/files";
import { updateMember } from "@/api/writes";
import { FileUpload } from "@/components/FileUpload";
import { FormDialog } from "@/components/FormDialog";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { tintOf } from "@/lib/members";
import { cn } from "@/lib/utils";

type Picked = { file: File; url: string };

/**
 * The mark at the head of a Member's settings, and how their Avatar is changed: click it (or
 * Upload beside it) to choose an image, see it in the Member's ring, and save it; Remove goes back
 * to initials. The server cuts the middle square and scales it to 256 pixels, which the round
 * preview shows. Only the editable see the controls: an admin, or a human on their own page. The
 * mark opens no hover card: the page is the Member's own.
 */
export function AvatarControl({ member, editable }: { member: Member; editable: boolean }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [problem, setProblem] = useState<string>();
  const remove = useMutation({
    mutationFn: () => updateMember(member.id, { avatar_file_id: "" }),
    onSuccess: () => toast(`Avatar of ${member.name} removed`),
  });
  if (!editable) return <MemberAvatar member={member} size="lg" card={false} />;
  const has = !!member.avatar_file_id;
  const pick = (file: File) => {
    const p = avatarProblem(file);
    setProblem(p);
    if (!p) setPicked({ file, url: URL.createObjectURL(file) });
  };
  const close = () => {
    if (picked) URL.revokeObjectURL(picked.url);
    setPicked(null);
  };
  return (
    <FileUpload accept={avatarTypes.join(",")} label={`Avatar image for ${member.name}`} onPick={pick}>
      {(open) => (
        <div className="flex flex-none flex-col items-center gap-1">
          {has ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <AvatarButton member={member} label={`Change the Avatar of ${member.name}`} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={open}>Upload new Avatar</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => remove.mutate()}>
                  Remove Avatar
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <AvatarButton member={member} label={`Upload an Avatar for ${member.name}`} onClick={open} />
              <Button variant="ghost" size="xs" className="h-5 px-1 text-[11px] text-muted-foreground" onClick={open}>
                Upload
              </Button>
            </>
          )}
          {problem && (
            <p role="alert" className="max-w-[120px] text-center text-[11px] leading-tight text-state-blocked">
              {problem}
            </p>
          )}
          <Refusal error={remove.error} className="max-w-[160px]" />
          {picked && <PreviewDialog member={member} picked={picked} onClose={close} />}
        </div>
      )}
    </FileUpload>
  );
}

function AvatarButton({ member, label, ...props }: { member: Member; label: string } & ComponentProps<"button">) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="group relative rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      {...props}
    >
      <MemberAvatar member={member} size="lg" card={false} />
      <span
        aria-hidden
        className="absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <CameraIcon className="size-4" />
      </span>
    </button>
  );
}

/** The picked image in the Member's ring at the sizes it is drawn, before it is sent. */
function PreviewDialog({ member, picked, onClose }: { member: Member; picked: Picked; onClose: () => void }) {
  const save = useMutation({
    mutationFn: async () => {
      const f = await uploadFile(picked.file, { purpose: "avatar" });
      return updateMember(member.id, { avatar_file_id: f.id });
    },
    onSuccess: () => {
      toast(`Avatar of ${member.name} saved`);
      onClose();
    },
  });
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`New Avatar for ${member.name}`}
      submitLabel="Save Avatar"
      onSubmit={() => save.mutate()}
      pending={save.isPending}
      error={save.error}
    >
      <div className="flex items-center gap-6 py-3">
        <Preview member={member} url={picked.url} size="xl" className="size-24" />
        <div className="flex items-center gap-3">
          <Preview member={member} url={picked.url} size="lg" className="size-10" />
          <Preview member={member} url={picked.url} size="md" className="size-7" />
          <Preview member={member} url={picked.url} size="sm" className="size-5" />
        </div>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{picked.file.name}</span>
      </div>
    </FormDialog>
  );
}

/** The picked image as the mark draws an Avatar: round, in the Member's ring. */
function Preview({ member, url, size, className }: { member: Member; url: string; size: "sm" | "md" | "lg" | "xl"; className: string }) {
  return (
    <span
      data-kind={member.kind}
      data-size={size}
      className={cn("avatar-tint inline-grid flex-none place-items-center rounded-full", `tint-${tintOf(member.name)}`, className)}
    >
      <img src={url} alt="" className="size-full rounded-full object-cover" />
    </span>
  );
}
