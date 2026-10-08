import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import type { Member, NewWorkflow, Project } from "@/api/client";
import { keys, useMembers, useProjects, useWorkspaces } from "@/api/queries";
import { createProject } from "@/api/writes";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { MemberAvatar } from "@/components/MemberAvatar";
import { ProjectMark } from "@/components/ProjectMark";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCurrentMe } from "@/me";
import { findProject, projectPath, useCurrentProject } from "./currentProject";
import { useIntent } from "./intents";
import { projectKeyPattern, suggestKey } from "./projectKey";

/** The New Project dialog, mounted once by the shell and opened by the `new-project` intent. */
export function NewProjectDialog() {
  const [open, setOpen] = useState(0);
  useIntent("new-project", () => setOpen((n) => n + 1));
  // A fresh form each time it opens.
  return open > 0 ? <NewProjectForm key={open} onClose={() => setOpen(0)} /> : null;
}

const noWorkspace = "none";

const workflows: { value: NewWorkflow; label: string; help: string }[] = [
  { value: "default", label: "Default", help: "Backlog · Plan · Build · Review · Retro · Skill review" },
  { value: "copy", label: "Copy from", help: "Another Project's Steps and Connectors, without its Tasks" },
  { value: "empty", label: "Empty", help: "Backlog → Done, to draw your own" },
];

/**
 * A new Project: its name and key, the Workflow it starts with (the default, another Project's, or
 * an empty one to draw), the Members put in it (you among them unless unticked: /v1 adds the
 * creator only when named), and the Workspace its Tasks work in when they name none. Opens its
 * Tasks once made.
 */
function NewProjectForm({ onClose }: { onClose: () => void }) {
  const me = useCurrentMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = useProjects().data ?? [];
  const current = useCurrentProject();
  const members = (useMembers().data ?? []).filter((m) => !m.deactivated_at);
  const workspaces = useWorkspaces().data ?? [];

  const [name, setName] = useState("");
  const [typedKey, setTypedKey] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<NewWorkflow>("default");
  const [copyFrom, setCopyFrom] = useState<string | undefined>(current?.key);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set([me.member.id]));
  const [workspace, setWorkspace] = useState(noWorkspace);

  const key = typedKey ?? suggestKey(name);
  const keyOK = projectKeyPattern.test(key);
  const taken = findProject(projects, key);
  const copyOK = workflow !== "copy" || !!findProject(projects, copyFrom);

  const create = useMutation({
    mutationFn: () =>
      createProject({
        name: name.trim(),
        key,
        workflow,
        copy_from: workflow === "copy" ? copyFrom : undefined,
        members: [...chosen],
        default_workspace: workspace === noWorkspace ? undefined : workspace,
      }),
    onSuccess: ({ project }) => {
      // Its page finds it at once, before the Projects are read again.
      qc.setQueryData<Project[]>(keys.projects, (old = []) => [...old, project].sort((a, b) => a.name.localeCompare(b.name)));
      onClose();
      toast.success(`Created ${project.name}`);
      navigate(projectPath(project, "tasks"));
    },
  });

  const toggle = (m: Member, on: boolean) =>
    setChosen((s) => {
      const next = new Set(s);
      if (on) next.add(m.id);
      else next.delete(m.id);
      return next;
    });
  // You first, then the humans, then the agents, each by name as /v1 lists them.
  const ordered = [...members].sort((a, b) => rank(a) - rank(b));
  function rank(m: Member) {
    return m.id === me.member.id ? 0 : m.kind === "human" ? 1 : 2;
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New Project"
      description="A body of work with its own key, Workflow and Members."
      submitLabel="Create Project"
      onSubmit={() => create.mutate()}
      pending={create.isPending}
      submitDisabled={!name.trim() || !keyOK || !!taken || !copyOK}
      error={create.error}
      size="lg"
    >
      <FormRows>
        <FormRow label="Name" htmlFor="project-name">
          <Input id="project-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormRow>
        <FormRow
          label="Key"
          htmlFor="project-key"
          help={
            key && !keyOK ? (
              <span className="text-state-blocked">2 to 10 capitals or digits, starting with a capital.</span>
            ) : taken ? (
              <span className="text-state-blocked">
                {taken.name} has the key {taken.key}.
              </span>
            ) : (
              <>Starts each Task key, as in {key || "MAIN"}-1. It never changes.</>
            )
          }
        >
          <Input
            id="project-key"
            required
            maxLength={10}
            value={key}
            aria-invalid={(!!key && !keyOK) || !!taken}
            onChange={(e) => setTypedKey(e.target.value.toUpperCase())}
            className="w-32 font-mono"
          />
        </FormRow>
        <FormRow label="Workflow">
          <RadioGroup aria-label="Workflow" value={workflow} onValueChange={(v) => setWorkflow(v as NewWorkflow)} className="gap-2">
            {workflows.map((w) => {
              const disabled = w.value === "copy" && projects.length === 0;
              return (
                <div key={w.value} className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2">
                  <RadioGroupItem id={`workflow-${w.value}`} value={w.value} disabled={disabled} className="mt-0.5" />
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={`workflow-${w.value}`} className="font-normal">
                      {w.label}
                      <span className="sr-only">: {w.help}</span>
                    </Label>
                    {w.value === "copy" && workflow === "copy" ? (
                      <Select value={copyFrom} onValueChange={setCopyFrom}>
                        <SelectTrigger aria-label="Copy the Workflow of" size="sm" className="w-full">
                          <SelectValue placeholder="Choose a Project" />
                        </SelectTrigger>
                        <SelectContent>
                          {projects.map((p) => (
                            <SelectItem key={p.id} value={p.key}>
                              <ProjectMark project={p} />
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span aria-hidden className="text-xs text-muted-foreground">
                        {w.help}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </RadioGroup>
        </FormRow>
        <FormRow label="Members" help="They take its Tasks at the Steps whose Skills they have.">
          <div role="group" aria-label="Members" className="max-h-48 overflow-y-auto rounded-md border p-1">
            {ordered.map((m) => (
              <label key={m.id} className="flex h-8 cursor-pointer items-center gap-2 rounded-sm px-1.5 hover:bg-accent">
                <Checkbox checked={chosen.has(m.id)} onCheckedChange={(c) => toggle(m, c === true)} aria-label={m.name} />
                <MemberAvatar member={m} />
                <span className="min-w-0 flex-1 truncate">
                  {m.name}
                  {m.id === me.member.id && <span className="text-muted-foreground"> (you)</span>}
                </span>
                <span className="text-xs text-muted-foreground">{m.kind === "agent" ? "Agent" : "Human"}</span>
              </label>
            ))}
          </div>
        </FormRow>
        {workspaces.length > 0 && (
          <FormRow label="Workspace" help="Where its Tasks' sessions work when a Task names none.">
            <Select value={workspace} onValueChange={setWorkspace}>
              <SelectTrigger aria-label="Workspace" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={noWorkspace}>None</SelectItem>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
        )}
      </FormRows>
    </FormDialog>
  );
}
