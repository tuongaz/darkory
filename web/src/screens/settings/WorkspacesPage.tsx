import { useMutation } from "@tanstack/react-query";
import { FolderGit2Icon, GitPullRequestIcon, GitMergeIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, type Project, type Task, type Workspace, type WorkspaceMode } from "@/api/client";
import { useAllTasks, useOpenTasks, useProjects, useWorkspaces } from "@/api/queries";
import { updateProject } from "@/api/writes";
import { useRouteProject } from "@/app/currentProject";
import { EmptyState } from "@/components/EmptyState";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { InfoTip } from "@/components/InfoTip";
import { Loaded, Refusal } from "@/components/Refusal";
import { Pill } from "@/components/Pill";
import { ProjectMark } from "@/components/ProjectMark";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { tableHead } from "./frame";
import { count, defaultOf, modeNames, naming, workspaceNamePattern } from "./model";
import { ConfirmDialog, Fact, Facts, MoreMenu, Segmented } from "./parts";
import { ProjectSettingsFrame } from "./ProjectFrame";
import { createWorkspace, removeWorkspace, updateWorkspace } from "@/api/writes";

// Name · Kind · Path · Mode · Default branch · Default of · Open Tasks · ⋯. A phone keeps Name,
// Mode and ⋯; the rest come at the width of a laptop.
const cols = "grid-cols-[minmax(0,1fr)_152px_26px] lg:grid-cols-[150px_40px_minmax(0,1fr)_150px_140px_120px_84px_26px]";
const wide = "hidden lg:flex";

type Change = { workspace: Workspace; body: Partial<Pick<Workspace, "path" | "mode" | "default_branch">> };

/**
 * A Project › Settings › Workspaces: the places a session works in, how work lands in each, and
 * who uses it. Workspaces belong to the Install, so every Project lists the same ones; this
 * Project's default is marked, and ⋯ makes another its default. Admins change them; anyone else
 * reads.
 */
export function WorkspacesPage() {
  const project = useRouteProject();
  const admin = useCurrentMe().member.admin;
  const workspaces = useWorkspaces();
  const projects = useProjects();
  // The Projects as read: the route's own record may be older than the list a write refreshed.
  const here = projects.data?.find((p) => p.id === project.id) ?? project;
  const open = useOpenTasks();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const modeHead = useRef<HTMLSpanElement>(null);
  // One write at a time from the table; while it is on its way the row shows it.
  const save = useMutation({ mutationFn: ({ workspace, body }: Change) => updateWorkspace(workspace.id, body) });
  const setDefault = useMutation({
    mutationFn: (w: Workspace | null) => updateProject(project.key, { default_workspace: w ? w.id : "" }),
    onSuccess: (p, w) => toast(w ? `${w.name} is the default of ${p.name}` : `${p.name} has no default Workspace`),
  });
  const shown = (w: Workspace): Workspace => (save.isPending && save.variables.workspace.id === w.id ? { ...w, ...save.variables.body } : w);

  return (
    <ProjectSettingsFrame
      project={project}
      page="workspaces"
      pad={false}
      primary={
        admin && (
          <Button aria-label="New Workspace" onClick={() => setAdding(true)}>
            <PlusIcon />
            <span className="hidden sm:inline">New Workspace</span>
          </Button>
        )
      }
    >
      <Loaded query={workspaces} loading={<Skeleton className="m-6 h-8" />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={<FolderGit2Icon />}
              title="No Workspaces yet"
              action={admin && <Button onClick={() => setAdding(true)}>New Workspace</Button>}
            >
              A Workspace is where an agent&apos;s Shift works: a git repository on this machine.
            </EmptyState>
          ) : (
            <>
              <div role="table" aria-label="Workspaces" className="min-w-0">
                <div role="row" className={cn(tableHead, cols)}>
                  <span role="columnheader">Name</span>
                  <span role="columnheader" className={wide}>
                    Kind
                  </span>
                  <span role="columnheader" className={wide}>
                    Path
                  </span>
                  <span ref={modeHead} role="columnheader" className="flex items-center gap-1">
                    Mode
                    <InfoTip label="Mode" anchor={modeHead} side="bottom" className="w-[320px]">
                      {modeWords}
                    </InfoTip>
                  </span>
                  <span role="columnheader" className={wide}>
                    Default branch
                  </span>
                  <span role="columnheader" className={wide}>
                    Default of
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
                    projects={projects.data ? defaultOf(w, projects.data) : undefined}
                    project={here}
                    admin={admin}
                    busy={save.isPending || setDefault.isPending}
                    openTasks={open.data ? naming(w, open.data).length : undefined}
                    onChange={(body) => {
                      save.reset();
                      save.mutate({ workspace: w, body });
                    }}
                    onRemove={() => setRemoving(w)}
                    onDefault={(on) => setDefault.mutate(on ? w : null)}
                  />
                ))}
              </div>
              <Refusal error={save.error ?? setDefault.error} className="px-6 pt-3" />
            </>
          )
        }
      </Loaded>
      {adding && <NewWorkspaceDialog onClose={() => setAdding(false)} />}
      {removing && <RemoveWorkspaceDialog workspace={removing} projects={projects.data ?? []} onClose={() => setRemoving(null)} />}
    </ProjectSettingsFrame>
  );
}

function WorkspaceRow({
  workspace: w,
  projects,
  project,
  admin,
  openTasks,
  busy,
  onChange,
  onRemove,
  onDefault,
}: {
  workspace: Workspace;
  projects?: Project[];
  project: Project;
  admin: boolean;
  openTasks?: number;
  busy: boolean;
  onChange: (body: Change["body"]) => void;
  onRemove: () => void;
  onDefault: (on: boolean) => void;
}) {
  const isDefault = project.default_workspace_id === w.id;
  return (
    <div role="row" aria-label={w.name} className={cn("grid h-11 items-center gap-3 border-b px-6", cols)}>
      <span role="cell" className="flex min-w-0 items-center gap-2 font-medium">
        <FolderGit2Icon className="size-3.5 flex-none text-muted-foreground" aria-hidden />
        <span className="truncate">{w.name}</span>
        {isDefault && <Pill tone="done">Default</Pill>}
      </span>
      <span role="cell" className={cn(wide, "font-mono text-xs text-muted-foreground")}>
        {w.kind}
      </span>
      <span role="cell" className={cn(wide, "min-w-0")}>
        <InlineText label={`path of ${w.name}`} value={w.path} onSave={(path) => onChange({ path })} disabled={busy} readOnly={!admin} path className="w-full" />
      </span>
      <span role="cell">
        {admin ? (
          <ModeSelect label={`Mode of ${w.name}`} value={w.mode} onChange={(mode) => onChange({ mode })} disabled={busy} />
        ) : (
          <span className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
            {modeIcons[w.mode]}
            {modeNames[w.mode]}
          </span>
        )}
      </span>
      <span role="cell" className={cn(wide, "min-w-0")}>
        <InlineText
          label={`default branch of ${w.name}`}
          value={w.default_branch}
          onSave={(default_branch) => onChange({ default_branch })}
          disabled={busy}
          readOnly={!admin}
          className="w-full"
        />
      </span>
      <span role="cell" className={cn(wide, "min-w-0 items-center gap-1.5")}>
        {projects === undefined ? (
          <Skeleton className="h-4 w-16" />
        ) : projects.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <>
            <span className="inline-flex flex-none gap-[3px]">
              {projects.slice(0, 3).map((p) => (
                <ProjectMark key={p.id} project={p} />
              ))}
            </span>
            <span className="truncate" title={projects.map((p) => p.name).join(", ")}>
              {projects.length === 1 ? projects[0].name : count(projects.length, "Project")}
            </span>
          </>
        )}
      </span>
      <span role="cell" className={cn(wide, "text-muted-foreground tabular-nums")}>
        {openTasks === undefined ? <Skeleton className="h-4 w-12" /> : count(openTasks, "Task")}
      </span>
      <span role="cell">
        {admin && (
          <MoreMenu label={`More for ${w.name}`} size="icon-xs">
            {isDefault ? (
              <DropdownMenuItem onSelect={() => onDefault(false)}>Stop being the default of {project.name}</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onDefault(true)}>Make the default of {project.name}</DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              Remove
            </DropdownMenuItem>
          </MoreMenu>
        )}
      </span>
    </div>
  );
}

/**
 * A path cut in the middle, so its last part, the folder's own name, stays in view:
 * "/private/tmp/clau…/project".
 */
function MiddleTruncated({ path }: { path: string }) {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  if (cut <= 0) return <span className="truncate">{path}</span>;
  return (
    <>
      <span className="truncate">{path.slice(0, cut)}</span>
      <span className="flex-none whitespace-pre">{path.slice(cut)}</span>
    </>
  );
}

/**
 * A value shown as text that becomes a field when clicked; Enter or leaving the field saves it, Esc
 * puts it back. A `path` is cut in the middle rather than at its end.
 */
function InlineText({
  label,
  value,
  onSave,
  disabled,
  readOnly,
  path,
  className,
}: {
  label: string;
  value: string;
  onSave: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  path?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (readOnly) {
    return (
      <span title={value} className="flex max-w-full min-w-0 px-1 py-0.5 font-mono text-xs">
        {path ? <MiddleTruncated path={value} /> : <span className="truncate">{value}</span>}
      </span>
    );
  }
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
      className="flex max-w-full min-w-0 cursor-text rounded-sm px-1 py-0.5 text-left font-mono text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
    >
      {path ? <MiddleTruncated path={value} /> : <span className="truncate">{value}</span>}
    </button>
  );
}

const modeIcons = { plain: <GitMergeIcon />, pull_request: <GitPullRequestIcon /> };

/** What each mode does, from the Mode column's ⓘ and the New Workspace's. */
const modeWords = (
  <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-2.5 gap-y-1">
    <dt className="text-muted-foreground">{modeNames.plain}</dt>
    <dd>The Runner merges branches itself: a Subtask&apos;s into its Parent&apos;s, a Task&apos;s into the default branch when it completes.</dd>
    <dt className="text-muted-foreground">{modeNames.pull_request}</dt>
    <dd>The Runner opens pull requests instead; one merged that carries a Task&apos;s key is that Task&apos;s branch landed.</dd>
  </dl>
);

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
          info="Names the Shift's checkout, as in web."
          help={
            name.trim() && !nameOK ? (
              <span className="text-state-blocked">Letters, digits, dots, dashes and underscores, starting with a letter or digit.</span>
            ) : undefined
          }
        >
          <Input id="workspace-name" required maxLength={63} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!name.trim() && !nameOK} autoFocus />
        </FormRow>
        <FormRow label="Path" htmlFor="workspace-path" info="The git repository's absolute path on this machine.">
          <Input id="workspace-path" required maxLength={4096} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/ada/src/web" className="font-mono text-xs md:text-xs" />
        </FormRow>
        <FormRow label="Mode" info={modeWords}>
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
        <FormRow label="Default branch" htmlFor="workspace-branch" info="Where completed work lands.">
          <Input id="workspace-branch" required maxLength={255} value={branch} onChange={(e) => setBranch(e.target.value)} className="w-40 font-mono text-xs md:text-xs" />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}

/**
 * Remove, asking first: it clears the Project defaults that name it. /v1 refuses while any Task, open
 * or ended, names it, because the record keeps where work was done; the dialog says so in words,
 * before asking when it already knows, and when the server refuses.
 */
function RemoveWorkspaceDialog({ workspace: w, projects, onClose }: { workspace: Workspace; projects: Project[]; onClose: () => void }) {
  const all = useAllTasks();
  const remove = useMutation({
    mutationFn: () => removeWorkspace(w.id),
    onSuccess: () => {
      onClose();
      toast(`Removed ${w.name}`);
    },
  });
  const defaults = defaultOf(w, projects);
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
            the default of {count(defaults.length, "Project")}
            {defaults.map((p) => (
              <span key={p.id} className="inline-flex items-center gap-1 font-normal text-muted-foreground">
                <ProjectMark project={p} />
                {p.name}
              </span>
            ))}
          </Fact>
        </Facts>
      ) : (
        !inUse && <p>No Project has it as its default, and no Task names it.</p>
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
