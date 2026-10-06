import { AlertTriangleIcon, CheckIcon, CopyIcon, MoreHorizontalIcon, XIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { Member } from "@/api/client";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * A record page's settings (kit `.sform`): one label column, one control column, a row per
 * setting. Controls keep fixed widths (320px); on a phone the label goes above.
 */
export function SettingsForm({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-1 border-t sm:grid-cols-[140px_minmax(0,1fr)]">
      {children}
    </div>
  );
}

/** One setting: its label, then its controls; `help` is a line under them. */
export function SettingsRow({
  label,
  count,
  htmlFor,
  help,
  children,
}: {
  label: string;
  count?: number;
  htmlFor?: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <>
      <Label
        htmlFor={htmlFor}
        className="flex items-start gap-1 pt-3 text-[12.5px] font-medium text-muted-foreground sm:border-b sm:pt-[17px]"
      >
        {label}
        {count !== undefined && <span className="font-normal tabular-nums">{count}</span>}
      </Label>
      <div className="flex min-h-[52px] min-w-0 flex-wrap items-center gap-2 border-b py-2.5">
        {children}
        {help && <div className="basis-full text-xs text-muted-foreground">{help}</div>}
      </div>
    </>
  );
}

/** A 320px control slot of a settings row. */
export const w320 = "w-full sm:w-80 flex-none";

/** A record inside a settings row (kit `.srec`): a token, a Session. */
export function RecordRow({ icon, children, action, label }: { icon: ReactNode; children: ReactNode; action?: ReactNode; label: string }) {
  return (
    <div
      role="listitem"
      aria-label={label}
      className="flex min-h-9 w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border py-1 pr-1.5 pl-2.5 [&>svg]:size-3.5 [&>svg]:text-muted-foreground"
    >
      {icon}
      {children}
      {action && <span className="ml-auto flex-none">{action}</span>}
    </div>
  );
}

/** A Team or a Skill held, with × to take it away (kit `.chip`). */
export function Chip({ children, onRemove, removeLabel, disabled }: { children: ReactNode; onRemove: () => void; removeLabel: string; disabled?: boolean }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border bg-background pr-1 pl-2 text-xs whitespace-nowrap">
      {children}
      <button
        type="button"
        aria-label={removeLabel}
        disabled={disabled}
        onClick={onRemove}
        className="grid size-4 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

export type PickerItem = { id: string; label: string; icon?: ReactNode; hint?: ReactNode };

/**
 * A button that opens a searchable list anchored under it (Add to Team, Grant Skill, Add Member).
 * Choosing an item runs `onPick` and closes the list.
 */
export function Picker({
  trigger,
  placeholder,
  heading,
  items,
  empty,
  onPick,
  align = "start",
}: {
  trigger: ReactNode;
  placeholder: string;
  heading: string;
  items: PickerItem[];
  empty: string;
  onPick: (id: string) => void;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} className="w-[300px] p-0">
        <Command>
          <CommandInput placeholder={placeholder} aria-label={placeholder} />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-muted-foreground">{empty}</CommandEmpty>
            {items.length > 0 && (
              <CommandGroup
                heading={
                  <span className="flex items-center gap-1.5">
                    {heading}
                    <span className="font-normal tabular-nums">{items.length}</span>
                  </span>
                }
              >
                {items.map((it) => (
                  <CommandItem
                    key={it.id}
                    value={`${it.label} ${it.id}`}
                    onSelect={() => {
                      setOpen(false);
                      onPick(it.id);
                    }}
                  >
                    {it.icon}
                    <span className="truncate">{it.label}</span>
                    {it.hint && <span className="ml-auto truncate text-xs text-muted-foreground">{it.hint}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** A row's or a page's ⋯ menu: the rare actions. Pass `DropdownMenuItem`s. */
export function MoreMenu({ label, children, size = "icon" }: { label: string; children: ReactNode; size?: "icon" | "icon-xs" }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={size === "icon" ? "outline" : "ghost"}
          size={size}
          aria-label={label}
          className={cn(size === "icon-xs" && "text-muted-foreground")}
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Asks before a destructive act and says what it does (kit `.dialog` with `.cfacts`): a title, the
 * facts of what it stops, Cancel and the act.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  onConfirm,
  pending,
  error,
  destructive = true,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: unknown;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-36 translate-y-0 gap-0 p-0 sm:max-w-[440px]">
        <div className="px-5 pt-4">
          <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
        </div>
        <DialogDescription asChild>
          <div className="flex flex-col gap-3 px-5 py-4 text-foreground">
            {children}
            <Refusal error={error} />
          </div>
        </DialogDescription>
        <div className="flex items-center justify-end gap-2 px-5 pt-1 pb-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending || disabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The facts a confirm states (kit `.cfacts`): a short label, then the count and what it names. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2.5">{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 font-medium">{children}</dd>
    </>
  );
}

/**
 * A secret shown this once (kit `.secret`): the text in mono, Copy, and the warning. Copy puts it
 * on the clipboard; where the browser refuses, it selects the text so it can be copied by hand.
 */
export function ShownOnce({ value, label }: { value: string; label: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      input.current?.focus();
      input.current?.select();
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-input bg-muted pr-1 pl-2.5">
        <input
          ref={input}
          readOnly
          aria-label={label}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs tracking-[0.02em] outline-none"
        />
        <Button type="button" variant="outline" size="xs" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="flex items-center gap-1.5 font-medium text-state-claimed">
        <AlertTriangleIcon className="size-3" aria-hidden />
        It will not be shown again.
      </p>
    </div>
  );
}

/** The kit's segmented control (`.seg`): a few choices, one chosen. */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex self-start justify-self-start rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-[6px] px-2.5 font-medium text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-3.5",
            value === o.value && "bg-background text-foreground shadow-soft",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A Member's avatar and name in a row. */
export function MemberName({ member, you, className }: { member: Pick<Member, "name" | "kind">; you?: boolean; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <MemberAvatar member={member} />
      <span className="truncate">{member.name}</span>
      {you && <span className="text-xs text-muted-foreground">you</span>}
    </span>
  );
}

/** A few avatars side by side, humans first, then how many Members they are. */
export function Avatars({ members, max = 8 }: { members: Pick<Member, "id" | "name" | "kind">[]; max?: number }) {
  if (members.length === 0) return <span className="text-muted-foreground">No one</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="inline-flex flex-none gap-[3px]">
        {members.slice(0, max).map((m) => (
          <MemberAvatar key={m.id} member={m} />
        ))}
      </span>
      <span className="truncate text-muted-foreground">
        {members.length} {members.length === 1 ? "Member" : "Members"}
      </span>
    </span>
  );
}

/** A group's heading row in a list (kit `.group-h`): Humans 3, Agents 5. */
export function GroupRow({ icon, label, count }: { icon: ReactNode; label: string; count: number }) {
  return (
    <div role="row" className="flex h-[34px] items-center gap-2 border-b bg-muted pr-4 pl-6 font-medium [&_svg]:size-3.5">
      <span role="rowheader" aria-label={`${label} ${count}`} className="flex items-center gap-2">
        {icon}
        {label}
        <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
      </span>
    </div>
  );
}
