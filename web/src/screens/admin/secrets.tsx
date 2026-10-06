import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { IssuedToken, LoginLink, Member } from "@/api/client";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { Refusal } from "@/components/Refusal";
import { ClockTime } from "@/components/Time";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ShownOnce } from "./parts";
import { issueLoginLink, issueToken } from "./writes";

/**
 * A dialog that shows what /v1 returns once (a token's secret, a login link) and closes with Done
 * (F-D2b). The secret lives only in the state of the component that asked for it.
 */
export function OnceDialog({
  open,
  onDone,
  title,
  children,
  action,
}: {
  open: boolean;
  onDone: () => void;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDone()}>
      <DialogContent showCloseButton={false} className="top-20 translate-y-0 gap-0 p-0 sm:max-w-[480px]" aria-describedby={undefined}>
        <div className="px-5 pt-4">
          <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
        </div>
        <div className="flex flex-col gap-3.5 px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 px-5 pt-1 pb-4">
          {action}
          <Button onClick={onDone}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The token and its secret, as issuing it returned them. */
export function TokenShown({ issued }: { issued: IssuedToken }) {
  return (
    <FormRows>
      <FormRow label="Token">
        <span>{issued.token.name}</span>
      </FormRow>
      <FormRow label="Secret">
        <ShownOnce value={issued.secret} label={`Secret of ${issued.token.name}`} />
      </FormRow>
    </FormRows>
  );
}

/** A login link, as issuing it returned it. */
export function LinkShown({ link }: { link: LoginLink }) {
  return (
    <FormRows>
      <FormRow label="Link" help={<>Works once, until <ClockTime at={link.expires_at} />.</>}>
        <ShownOnce value={link.url} label="Sign-in link" />
      </FormRow>
    </FormRows>
  );
}

/**
 * Issue token (F-D3's primary): a name and an optional Heartbeat timeout, then the secret shown
 * once. Mounted only while open, so a closed dialog forgets the secret.
 */
export function IssueTokenDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const [name, setName] = useState("");
  const [timeout, setTimeoutSeconds] = useState("");
  const issue = useMutation({
    mutationFn: () => issueToken(member.id, name.trim(), timeout ? Number(timeout) : undefined),
  });
  if (issue.data) {
    return (
      <OnceDialog open onDone={onClose} title={`Token for ${member.name}`}>
        <TokenShown issued={issue.data} />
      </OnceDialog>
    );
  }
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Issue token"
      submitLabel="Issue token"
      onSubmit={() => issue.mutate()}
      pending={issue.isPending}
      submitDisabled={!name.trim()}
      error={issue.error}
    >
      <FormRows>
        <FormRow label="Name" htmlFor="token-name">
          <Input id="token-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormRow>
        <FormRow label="Heartbeat timeout" htmlFor="token-timeout" help="For Claims made with this token. Empty: none.">
          <div className="flex items-center gap-2">
            <Input
              id="token-timeout"
              type="number"
              inputMode="numeric"
              min={1}
              max={86400}
              placeholder="Optional"
              value={timeout}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              className="w-32"
            />
            <span className="text-muted-foreground">seconds</span>
          </div>
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}

/** Sign-in link for a human: issue one, then show it once. Mounted only while open. */
export function SignInLinkDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const issue = useMutation({ mutationFn: () => issueLoginLink(member.id) });
  return (
    <OnceDialog
      open
      onDone={onClose}
      title={`Sign-in link for ${member.name}`}
      action={
        !issue.data && (
          <Button variant="outline" onClick={() => issue.mutate()} disabled={issue.isPending}>
            Issue link
          </Button>
        )
      }
    >
      {issue.data ? <LinkShown link={issue.data} /> : <p className="text-muted-foreground">A link signs a browser in as {member.name}, once.</p>}
      <Refusal error={issue.error} />
    </OnceDialog>
  );
}

