import { useMutation } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, call, fileBody, type TaskDetail } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { useNow } from "@/clock";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCurrentMe } from "@/me";
import { taskActions, type TaskAction, type TaskActions } from "./actions";
import { BlockerDialog, CompleteDialog, DropTaskDialog, HandOverDialog, ObserveDialog, ProposeDialog, ReleaseDialog, TakeBackDialog } from "./dialogs";
import { ActionItem } from "./parts";
import { useTakeable } from "./queries";


export type TaskActionsUI = {
  actions: TaskActions;
  /** The one primary: Claim, or Complete with Hand over and Release in its caret. */
  primary: ReactNode;
  /** The ⋯ menu's items; empty when there are none. */
  menu: ReactNode[];
  /** The dialogs and the file picker the items open; render once beside them. */
  dialogs: ReactNode;
};

const none: TaskActions = { caret: [], menu: [], dimmed: {}, status: "fact", notes: null };

/**
 * What the signed-in Member can do to the Task, drawn for the peek (`xs`) or the page's top bar.
 * Nothing while the Task loads.
 */
export function useTaskActionsUI(detail: TaskDetail | undefined, size: "xs" | "default"): TaskActionsUI {
  const me = useCurrentMe();
  const { members } = useDirectory();
  const takeable = useTakeable().data;
  const now = useNow();
  const actions = detail
    ? taskActions({ me: me.member.id, detail, members, takeable: takeable ?? new Set(), teams: new Set(me.teams.map((t) => t.id)), now })
    : none;
  const taskId = detail?.task.id ?? "";
  const taskKey = detail?.task.key ?? "";
  const [open, setOpen] = useState<TaskAction | null>(null);
  const file = useRef<HTMLInputElement>(null);

  // A Claim from the browser has no Heartbeat timeout: it is bound to the Member, not a Session.
  const claim = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/claim", { params: { path: { task: taskId } }, body: { heartbeat_timeout_seconds: 0 } })),
    onSuccess: () => toast.success(`${taskKey} claimed`),
    onError: (err) => toast.error(`${taskKey} not claimed`, { description: err.message }),
  });
  const attach = useMutation({
    mutationFn: (f: File) =>
      call(api.POST("/v1/tasks/{task}/evidence", { params: { path: { task: taskId }, query: { filename: f.name } }, ...fileBody(f) })),
    onSuccess: (e) => toast.success(`${e.filename} attached to ${taskKey}`),
    onError: (err) => toast.error("Evidence not attached", { description: err.message }),
  });

  const choose = (a: TaskAction) => (a === "attach-evidence" ? file.current?.click() : setOpen(a));

  let primary: ReactNode = null;
  if (actions.primary === "claim") {
    primary = (
      <Button size={size} onClick={() => claim.mutate()} disabled={claim.isPending}>
        Claim
      </Button>
    );
  } else if (actions.primary === "complete") {
    primary = (
      <div className="inline-flex">
        <Button size={size} className="rounded-r-none" onClick={() => setOpen("complete")}>
          <CheckIcon />
          Complete
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size={size === "xs" ? "icon-xs" : "icon"} className="w-7 rounded-l-none border-l border-primary-foreground/20" aria-label="More ways to end the Claim">
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.caret.map((a) => (
              <ActionItem key={a} action={a} onSelect={() => choose(a)} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  const menu: ReactNode[] = [];
  actions.menu.forEach((a, i) => {
    // Drop ends the Task; it sits apart from the rest.
    if (a === "drop" && i > 0) menu.push(<DropdownMenuSeparator key="sep" />);
    menu.push(<ActionItem key={a} action={a} reason={actions.dimmed[a]} onSelect={() => choose(a)} />);
  });

  if (!detail) return { actions, primary, menu, dialogs: null };
  const props = (a: TaskAction) => ({ detail, open: open === a, onOpenChange: (o: boolean) => setOpen(o ? a : null) });
  const dialogs = (
    <>
      <input
        ref={file}
        type="file"
        hidden
        aria-label="Evidence file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) attach.mutate(f);
          e.target.value = "";
        }}
      />
      {/* Keyed by what opened them, so each opens with empty fields. */}
      {open === "complete" && <CompleteDialog {...props("complete")} />}
      {open === "hand-over" && <HandOverDialog {...props("hand-over")} />}
      {open === "release" && <ReleaseDialog {...props("release")} />}
      {open === "take-back" && <TakeBackDialog {...props("take-back")} />}
      {open === "drop" && <DropTaskDialog {...props("drop")} />}
      {open === "observe" && <ObserveDialog {...props("observe")} />}
      {open === "add-blocker" && <BlockerDialog {...props("add-blocker")} />}
      {open === "propose" && <ProposeDialog {...props("propose")} />}
    </>
  );
  return { actions, primary, menu, dialogs };
}
