import { useMutation } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, RotateCcwIcon } from "lucide-react";
import { Fragment, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, call, fileBody, type Connector, type TaskDetail } from "@/api/client";
import { useDirectory } from "@/api/queries";
import { useNow } from "@/clock";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCurrentMe } from "@/me";
import { openFileTask } from "../board/state";
import { taskActions, type TaskAction, type TaskActions } from "./actions";
import {
  AdvanceDialog,
  BlockerDialog,
  CompleteDialog,
  DropTaskDialog,
  MoveDialog,
  ObserveDialog,
  PassOwnershipDialog,
  ProposeDialog,
  RankDialog,
  ReleaseDialog,
  TakeBackDialog,
} from "./dialogs";
import { ActionItem } from "./parts";
import { useTakeableIds, useTaskWorkflow } from "./queries";

export type TaskActionsUI = {
  actions: TaskActions;
  /** The one primary: Claim; Advance with the other outcomes and Release in its caret; Complete. */
  primary: ReactNode;
  /** The ⋯ menu's items; empty when there are none. */
  menu: ReactNode[];
  /** The dialogs and the file picker the items open; render once beside them. */
  dialogs: ReactNode;
  /** Opens File a Task for a Subtask of this Task. */
  addSubtask?: () => void;
};

const none: TaskActions = { caret: [], menu: [], dimmed: {}, notes: null, labels: false, splits: false };

type Opened = { kind: "advance"; connector: Connector } | { kind: Exclude<TaskAction, "advance"> };

/** "Advance · pass" along a Connector into a Step; "Complete · pass" into Done. */
export function connectorLabel(c: Connector): string {
  return `${c.to_step_id ? "Advance" : "Complete"} · ${c.name}`;
}

/**
 * What the signed-in Member can do to the Task, drawn for the peek (`xs`) or the page's top bar.
 * Nothing while the Task loads.
 */
export function useTaskActionsUI(detail: TaskDetail | undefined, size: "xs" | "default"): TaskActionsUI {
  const me = useCurrentMe();
  const { members } = useDirectory();
  const takeable = useTakeableIds().data;
  const now = useNow();
  const { project } = useTaskWorkflow(detail?.task.project_id);
  const actions = detail
    ? taskActions({ me: me.member.id, detail, members, takeable: takeable ?? new Set(), projects: new Set(me.projects.map((p) => p.id)), now })
    : none;
  const taskId = detail?.task.id ?? "";
  const taskKey = detail?.task.key ?? "";
  // The dialog open, for the Task it was opened on: the peek moving to another Task closes it.
  const [opened, setOpened] = useState<{ task: string; what: Opened } | null>(null);
  const open = opened && opened.task === taskId ? opened.what : null;
  const setOpen = (what: Opened | null) => setOpened(what ? { task: taskId, what } : null);
  const file = useRef<HTMLInputElement>(null);

  // A Claim from the browser has no Heartbeat timeout: it is bound to the Member, not a Session.
  const claim = useMutation({
    mutationFn: () => call(api.POST("/v1/tasks/{task}/claim", { params: { path: { task: taskId } }, body: { heartbeat_timeout_seconds: 0 } })),
    onSuccess: () => toast.success(`${taskKey} claimed`),
    onError: (err) => toast.error(`${taskKey} not claimed`, { description: err.message }),
  });
  const attach = useMutation({
    mutationFn: (f: File) => call(api.POST("/v1/tasks/{task}/evidence", { params: { path: { task: taskId }, query: { filename: f.name } }, ...fileBody(f) })),
    onSuccess: (e) => toast.success(`${e.filename} attached to ${taskKey}`),
    onError: (err) => toast.error("Evidence not attached", { description: err.message }),
  });

  const addSubtask = detail && actions.menu.includes("file-subtask") ? () => openFileTask({ project: project?.key, parent: taskKey }) : undefined;
  const choose = (a: TaskAction) => {
    if (a === "attach-evidence") return file.current?.click();
    if (a === "file-subtask") return addSubtask?.();
    if (a === "ask-question" && detail) {
      // A question goes to the Owner, or for the Owner to the Member above them.
      const owner = detail.task.owner_id;
      const aim = owner !== me.member.id ? owner : (members.get(owner)?.manager_id ?? undefined);
      return openFileTask({ project: project?.key, blocks: taskKey, aim });
    }
    if (a === "advance") return;
    setOpen({ kind: a });
  };

  let primary: ReactNode = null;
  const p = actions.primary;
  if (p?.kind === "claim") {
    primary = (
      <Button size={size} onClick={() => claim.mutate()} disabled={claim.isPending}>
        Claim
      </Button>
    );
  } else if (p?.kind === "complete") {
    const reason = actions.dimmed.complete;
    primary = (
      <Button size={size} onClick={() => setOpen({ kind: "complete" })} disabled={!!reason} title={reason ? `${reason}: a Parent completes once every Subtask has ended` : undefined}>
        <CheckIcon />
        Complete
      </Button>
    );
  } else if (p?.kind === "advance") {
    const into = (c: Connector) => (c.to_step_id ? <ArrowRightIcon /> : <CheckIcon />);
    primary = (
      <div className="inline-flex">
        <Button size={size} className="rounded-r-none" onClick={() => setOpen({ kind: "advance", connector: p.connector })}>
          {into(p.connector)}
          {connectorLabel(p.connector)}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size={size === "xs" ? "icon-xs" : "icon"} className="w-7 rounded-l-none border-l border-primary-foreground/20" aria-label="More ways to end the Claim">
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.caret.map((c) =>
              c.kind === "advance" ? (
                <DropdownMenuItem key={c.connector.id} onSelect={() => setOpen(c)}>
                  {into(c.connector)}
                  {connectorLabel(c.connector)}
                </DropdownMenuItem>
              ) : (
                <Fragment key="release">
                  {actions.caret.length > 1 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={() => setOpen({ kind: "release" })}>
                    <RotateCcwIcon />
                    Release
                  </DropdownMenuItem>
                </Fragment>
              ),
            )}
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
  const props = (what: Opened["kind"]) => ({ detail, open: open?.kind === what, onOpenChange: (o: boolean) => !o && setOpen(null) });
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
      {/* Mounted while open, so each opens with empty fields. */}
      {open?.kind === "advance" && <AdvanceDialog key={open.connector.id} {...props("advance")} connector={open.connector} />}
      {open?.kind === "complete" && <CompleteDialog {...props("complete")} />}
      {open?.kind === "release" && <ReleaseDialog {...props("release")} />}
      {open?.kind === "move" && <MoveDialog {...props("move")} />}
      {open?.kind === "take-back" && <TakeBackDialog {...props("take-back")} />}
      {open?.kind === "drop" && <DropTaskDialog {...props("drop")} />}
      {open?.kind === "pass-ownership" && <PassOwnershipDialog {...props("pass-ownership")} />}
      {open?.kind === "rank" && <RankDialog {...props("rank")} />}
      {open?.kind === "observe" && <ObserveDialog {...props("observe")} />}
      {open?.kind === "add-blocker" && <BlockerDialog {...props("add-blocker")} />}
      {open?.kind === "propose" && <ProposeDialog {...props("propose")} />}
    </>
  );
  return { actions, primary, menu, dialogs, addSubtask };
}
