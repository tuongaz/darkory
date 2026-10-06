import { useMutation } from "@tanstack/react-query";
import { FolderGit2Icon, GitPullRequestIcon, GitMergeIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, type Task, type Team, type Workspace, type WorkspaceMode } from "@/api/client";
import { useAllTasks, useOpenTasks, useTeams, useWorkspaces } from "@/api/queries";
import { EmptyState } from "@/components/EmptyState";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { InfoPopover } from "@/components/InfoPopover";
import { Loaded, Refusal } from "@/components/Refusal";
import { TeamMark } from "@/components/TeamMark";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AdminFrame } from "./AdminLayout";
import { count, defaultOf, modeNames, naming, workspaceNamePattern } from "./model";
import { ConfirmDialog, Fact, Facts, MoreMenu, Segmented } from "./parts";
import { createWorkspace, removeWorkspace, updateWorkspace } from "./writes";

// Name · Kind · Path · Mode · Default branch · Team default · Open Tasks · ⋯. A phone keeps Name,
// Mode and ⋯; the rest come at the width of a laptop.
const cols = "grid-cols-[minmax(0,1fr)_132px_26px] lg:grid-cols-[150px_40px_minmax(0,1fr)_150px_140px_120px_84px_26px]";
const wide = "hidden lg:flex";

type Change = { workspace: Workspace; body: Partial<Pick<Workspace, "path" | "mode" | "default_branch">> };

/** /admin/workspaces: the places a session works in, how work lands in each, and who uses it. */
export function WorkspacesPage() {
  const workspaces = useWorkspaces();
  const teams = useTeams();
  const open = useOpenTasks();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const modeHead = useRef<HTMLSpanElement>(null);
  // One write at a time from the table; while it is on its way the row shows it.
  const save = useMutation({ mutationFn: ({ workspace, body }: Change) => updateWorkspace(workspace.id, body) });
  const shown = (w: Workspace): Workspace => (save.isPending && save.variables.workspace.id === w.id ? { ...w, ...save.variables.body } : w);

  return (
    <AdminFrame
      crumbs={[{ label: "Workspaces" }]}
      pad={false}
      primary={
        <Button onClick={() => setAdding(true)}>
          <PlusIcon />
          New Workspace
        </Button>
      }
    >
      <Loaded query={workspaces} loading={<Skeleton className="m-6 h-8" />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState icon={<FolderGit2Icon />} title="No Workspaces yet" action={<Button onClick={() => setAdding(true)}>New Workspace</Button>}>
              A Workspace is where an agent&apos;s session works: a git repository on this machine.
            </EmptyState>
          ) : (
            <>
              <div role="table" aria-label="Workspaces" className="min-w-0">
                <div role="row" className={cn("grid h-8 items-center gap-3 border-b px-6 text-xs font-medium text-muted-foreground", cols)}>
                  <span role="columnheader">Name</span>
                  <span role="columnheader" className={wide}>
                    Kind
                  </span>
                  <span role="columnheader" className={wide}>
                    Path
                  </span>
                  <span ref={modeHead} role="columnheader" className="flex items-center gap-1">
                    Mode
                    <InfoPopover label="About the modes" anchor={modeHead} side="bottom" align="start" className="w-[320px]">
                      <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-2.5 gap-y-1">
                        <dt className="text-muted-foreground">{modeNames.plain}</dt>
                        <dd>The Runner merges a Task&apos;s branch when its review completes, and the Feature&apos;s at Ship.</dd>
                        <dt className="text-muted-foreground">{modeNames.pull_request}</dt>
                        <dd>The Runner opens pull requests; merging one that carries a Task&apos;s key completes that Task&apos;s review.</dd>
                      </dl>
                    </InfoPopover>
                  </span>
                  <span role="columnheader" className={wide}>
                    Default branch
                  </span>
                  <span role="columnheader" className={wide}>
                    Team default
                  </span>
                  <span role="columnheader" className={wide}>
                    Open Tasks
                  </span>
                  <span role="columnheader">
                    <span className="sr-only">Actions</span>
                  </span>
                </div>
                {list.map((w) => (
                  <WorkspaceRow
                    key={w.id}
                    workspace={shown(w)}
                    teams={teams.data ? defaultOf(w, teams.data) : undefined}
                    openTasks={open.data ? naming(w, open.data).length : undefined}
                    busy={save.isPending}
                    onChange={(body) => {
                      save.reset();
                      save.mutate({ workspace: w, body });
                    }}
                    onRemove={() => setRemoving(w)}
                  />
                ))}
              </div>
              <Refusal error={save.error} className="px-6 pt-3" />
            </>
          )
        }
      </Loaded>
      {adding && <NewWorkspaceDialog onClose={() => setAdding(false)} />}
      {removing && <RemoveWorkspaceDialog workspace={removing} teams={teams.data ?? []} onClose={() => setRemoving(null)} />}
    </AdminFrame>
  );
}

function WorkspaceRow({
  workspace: w,
  teams,
  openTasks,
  busy,
  onChange,
  onRemove,
}: {
  workspace: Workspace;
  teams?: Team[];
  openTasks?: number;
  busy: boolean;
  onChange: (body: Change["body"]) => void;
  onRemove: () => void;
}) {
  return (
    <div role="row" aria-label={w.name} className={cn("grid h-11 items-center gap-3 border-b px-6", cols)}>
      <span role="cell" className="flex min-w-0 items-center gap-2 font-medium">
        <FolderGit2Icon className="size-3.5 flex-none text-muted-foreground" aria-hidden />
        <span className="truncate">{w.name}</span>
      </span>
      <span role="cell" className={cn(wide, "font-mono text-xs text-muted-foreground")}>
        {w.kind}
      </span>
      <span role="cell" className={cn(wide, "min-w-0")}>
        <InlineText label={`path of ${w.name}`} value={w.path} onSave={(path) => onChange({ path })} disabled={busy} className="w-full" />
      </span>
      <span role="cell">
        <ModeSelect label={`Mode of ${w.name}`} value={w.mode} onChange={(mode) => onChange({ mode })} disabled={busy} />
      </span>
      <span role="cell" className={cn(wide, "min-w-0")}>
        <InlineText
          label={`default branch of ${w.name}`}
          value={w.default_branch}
          onSave={(default_branch) => onChange({ default_branch })}
          disabled={busy}
          className="w-full"
        />
      </span>
      <span role="cell" className={cn(wide, "min-w-0 items-center gap-1.5")}>
        {teams === undefined ? (
          <Skeleton className="h-4 w-16" />
        ) : teams.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <>
            <span className="inline-flex flex-none gap-[3px]">
              {teams.slice(0, 3).map((t) => (
                <TeamMark key={t.id} team={t} />
              ))}
            </span>
            <span className="truncate" title={teams.map((t) => t.name).join(", ")}>
              {teams.length === 1 ? teams[0].name : count(teams.length, "Team")}
            </span>
          </>
        )}
      </span>
      <span role="cell" className={cn(wide, "text-muted-foreground tabular-nums")}>
        {openTasks === undefined ? <Skeleton className="h-4 w-12" /> : count(openTasks, "Task")}
      </span>
      <span role="cell">
        <MoreMenu label={`More for ${w.name}`} size="icon-xs">
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            Remove
          </DropdownMenuItem>
        </MoreMenu>
      </span>
    </div>
  );
}

/** A value shown as text that becomes a field when clicked; Enter or leaving the field saves it, Esc puts it back. */
function InlineText({
  label,
  value,
  onSave,
  disabled,
  className,
}: {
  label: string;
  value: string;
  onSave: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (editing) {
    return (
      <Input
        aria-label={label.charAt(0).toUpperCase() + label.slice(1)}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          setEditing(false);
          const next = draft.trim();
          if (next && next !== value) onSave(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className={cn("h-7 font-mono text-xs md:text-xs", className)}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={`Change ${label}`}
      disabled={disabled}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      title={value}
      className="max-w-full cursor-text truncate rounded-sm px-1 py-0.5 text-left font-mono text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
    >
      {value}
    </button>
  );
}

const modeIcons = { plain: <GitMergeIcon />, pull_request: <GitPullRequestIcon /> };

function ModeSelect({ label, value, onChange, disabled }: { label: string; value: WorkspaceMode; onChange: (m: WorkspaceMode) => void; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={(v) => v !== value && onChange(v as WorkspaceMode)} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={label} className="h-8 w-full lg:w-[150px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {(["plain", "pull_request"] as const).map((m) => (
          <SelectItem key={m} value={m}>
            {modeIcons[m]}
            {modeNames[m]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** New Workspace: a name, the repository's path, how work lands, and the branch it lands on. */
function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>("plain");
  const [branch, setBranch] = useState("main");
  const create = useMutation({
    mutationFn: () => createWorkspace({ name: name.trim(), kind: "git", path: path.trim(), mode, default_branch: branch.trim() }),
    onSuccess: (w) => {
      onClose();
      toast(`Added ${w.name}`, { description: w.path });
    },
  });
  const nameOK = workspaceNamePattern.test(name.trim());
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New Workspace"
      size="md"
      submitLabel="Create Workspace"
      onSubmit={() => create.mutate()}
      pending={create.isPending}
      submitDisabled={!nameOK || !path.trim() || !branch.trim()}
      error={create.error}
    >
      <FormRows>
        <FormRow
          label="Name"
          htmlFor="workspace-name"
          help={
            name.trim() && !nameOK ? (
              <span className="text-state-blocked">Letters, digits, dots, dashes and underscores, starting with a letter or digit.</span>
            ) : (
              "Names the session's checkout, as in web."
            )
          }
        >
          <Input id="workspace-name" required maxLength={63} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!name.trim() && !nameOK} autoFocus />
        </FormRow>
        <FormRow label="Path" htmlFor="workspace-path" help="The git repository's absolute path on this machine.">
          <Input id="workspace-path" required maxLength={4096} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/ada/src/web" className="font-mono text-xs md:text-xs" />
        </FormRow>
        <FormRow label="Mode" help={mode === "plain" ? "The Runner merges branches itself." : "Work lands through pull requests."}>
          <Segmented
            label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: "plain", label: modeNames.plain, icon: modeIcons.plain },
              { value: "pull_request", label: modeNames.pull_request, icon: modeIcons.pull_request },
            ]}
          />
        </FormRow>
        <FormRow label="Default branch" htmlFor="workspace-branch" help="Where shipped work lands.">
          <Input id="workspace-branch" required maxLength={255} value={branch} onChange={(e) => setBranch(e.target.value)} className="w-40 font-mono text-xs md:text-xs" />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}

/**
 * Remove, asking first: it clears the Team defaults that name it. /v1 refuses while any Task, open
 * or ended, names it, because the record keeps where work was done; the dialog says so in words,
 * before asking when it already knows, and when the server refuses.
 */
function RemoveWorkspaceDialog({ workspace: w, teams, onClose }: { workspace: Workspace; teams: Team[]; onClose: () => void }) {
  const all = useAllTasks();
  const remove = useMutation({
    mutationFn: () => removeWorkspace(w.id),
    onSuccess: () => {
      onClose();
      toast(`Removed ${w.name}`);
    },
  });
  const defaults = defaultOf(w, teams);
  const named = all.data ? naming(w, all.data) : [];
  const inUse = named.length > 0 || (remove.error instanceof ApiError && remove.error.code === "conflict");
  const refusal = inUse ? new ApiError(409, "conflict", stays(w, named)) : remove.error;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Remove ${w.name}?`}
      confirmLabel="Remove"
      onConfirm={() => remove.mutate()}
      pending={remove.isPending}
      disabled={all.isPending || inUse}
      error={refusal}
    >
      {all.isPending ? (
        <Skeleton className="h-10" />
      ) : defaults.length > 0 ? (
        <Facts>
          <Fact label="Clears">
            the default of {count(defaults.length, "Team")}
            {defaults.map((t) => (
              <span key={t.id} className="inline-flex items-center gap-1 font-normal text-muted-foreground">
                <TeamMark team={t} />
                {t.name}
              </span>
            ))}
          </Fact>
        </Facts>
      ) : (
        !inUse && <p>No Team has it as its default, and no Task names it.</p>
      )}
    </ConfirmDialog>
  );
}

/** Why a Workspace stays: the Tasks that name it, as many as fit a line. */
function stays(w: Workspace, tasks: Task[]): string {
  const keys = tasks.slice(0, 5).map((t) => t.key);
  const more = tasks.length > keys.length ? ` and ${tasks.length - keys.length} more` : "";
  const who = tasks.length
    ? `${count(tasks.length, "Task")} ${tasks.length === 1 ? "names" : "name"} ${w.name} (${keys.join(", ")}${more})`
    : `Tasks name ${w.name}`;
  return `${who}; the record keeps where their work was done, so it cannot be removed.`;
}
