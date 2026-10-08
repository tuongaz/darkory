import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { InfoTip } from "./InfoTip";
import { cn } from "@/lib/utils";
import { Refusal } from "./Refusal";

const widths = { sm: "sm:max-w-[480px]", md: "sm:max-w-[560px]", lg: "sm:max-w-[600px]" };

/**
 * A dialog that asks for a few fields and does one thing (kit `.dialog`): a title and an optional
 * line under it, the fields, then a footer with an optional hint on the left ("Ends your Claim on
 * WEB-14"), Cancel and the one primary. Submitting runs `onSubmit`; a refusal shows above the
 * footer. The caller closes it on success.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  hint,
  submitLabel,
  onSubmit,
  pending,
  submitDisabled,
  error,
  size = "sm",
  destructive,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  hint?: ReactNode;
  submitLabel: string;
  onSubmit: () => void;
  pending?: boolean;
  submitDisabled?: boolean;
  error?: unknown;
  size?: keyof typeof widths;
  /** The primary ends something for good (Drop): drawn in the destructive colour. */
  destructive?: boolean;
  children: ReactNode;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className={cn("top-20 translate-y-0 gap-0 p-0", widths[size])}
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <form onSubmit={submit} className="flex min-w-0 flex-col">
          <div className="flex flex-col gap-1 px-5 pt-4">
            <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
            {description && <DialogDescription className="text-muted-foreground">{description}</DialogDescription>}
          </div>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            {children}
            <Refusal error={error} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 px-5 pt-3 pb-4">
            {hint && <span className="mr-auto text-xs text-muted-foreground">{hint}</span>}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending || submitDisabled}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The fields of a FormDialog or a settings page: one label column, one control column of 320px controls; one column on a phone. */
export function FormRows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 items-center gap-x-4 gap-y-3 sm:grid-cols-[minmax(72px,max-content)_minmax(0,320px)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * One field of FormRows. `htmlFor` ties the label to its control; `info` explains the field from
 * an ⓘ beside the label; `help` is a line under the control, kept for what the field says now (an
 * error, a status), never for explaining it.
 */
export function FormRow({ label, htmlFor, info, help, children }: { label: string; htmlFor?: string; info?: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    <>
      <span className="flex items-center gap-1">
        <Label htmlFor={htmlFor} className="text-[12.5px] font-medium">
          {label}
        </Label>
        {info && <InfoTip label={label}>{info}</InfoTip>}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5 justify-self-stretch">
        {children}
        {help && <p className="text-xs text-muted-foreground">{help}</p>}
      </div>
    </>
  );
}
