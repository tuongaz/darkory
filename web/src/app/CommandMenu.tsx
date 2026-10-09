import {
  ActivityIcon,
  BuildingIcon,
  CircleUserIcon,
  InboxIcon,
  KanbanIcon,
  ListIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon,
  WorkflowIcon,
  ZapIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useAllTasks, useDirectory, useRunnerSessions, useWorkflow } from "@/api/queries";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { ProjectMark } from "@/components/ProjectMark";
import { remembered, workflowParam } from "@/components/pickedWorkflow";
import { workflowsInOrder } from "@/components/workflowLine/model";
import { WorkGlyph } from "@/components/WorkGlyph";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { useCurrentMe } from "@/me";
import { taskWorkGlyph } from "@/work";
import { projectPath, projectSettingsPath, useCurrentProject, useProjectArea } from "./currentProject";
import { sendIntent } from "./intents";
import { orderGroups, rankRecords, type Hit } from "./search";

type Entry = { id: string; content: ReactNode; keys?: string[]; run: () => void };
type Group = { heading: string; best: number; entries: Entry[] };
// What a place or an action is found by: its words, no key.
type Named = { id: string; key: string; title: string; icon: ReactNode; keys?: string[]; run: () => void };

function group<T>(heading: string, hits: Hit<T>[], entry: (record: T) => Entry): Group {
  return { heading, best: hits[0]?.score ?? Infinity, entries: hits.map((h) => entry(h.record)) };
}

const organisationPages = ["Members", "Agents", "Skills", "Labels", "Install"] as const;

/**
 * ⌘K: Tasks by key or words, the Projects to switch to, Members, the places to go to (the current
 * Project's, and Settings), and the actions. The group holding the best hit comes first, so a key
 * typed whole is the first choice.
 */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const me = useCurrentMe();
  const project = useCurrentProject();
  const area = useProjectArea();
  const tasks = useAllTasks(open);
  const sessions = useRunnerSessions().data?.items;
  const { projects: projectsById, projectList, memberList, members: byId } = useDirectory();
  const now = useNow();
  const admin = me.member.admin;
  // A Project of two or more Workflows has a board for each.
  const listed = useWorkflow(project?.key).data?.workflows;
  const workflows = useMemo(() => workflowsInOrder(listed ?? []), [listed]);
  // G B opens the board on the Workflow this browser last picked, else the first: its entry shows the keys.
  const boardWorkflow = (project && workflows.find((w) => w.id === remembered(project.key))?.id) ?? workflows[0]?.id;

  // An admin opens a Member's settings; another Member finds the agents on the Project's Agents.
  const members = useMemo(
    () => memberList.filter((m) => admin || m.kind === "agent").map((m) => ({ ...m, key: m.name, title: m.name })),
    [memberList, admin],
  );
  const projects = useMemo(() => projectList.map((p) => ({ ...p, title: p.name })), [projectList]);

  const go = (to: string) => () => navigate(to);
  const places: Named[] = [
    { id: "inbox", title: "Inbox", icon: <InboxIcon />, keys: ["G", "I"], run: go("/inbox") },
    { id: "my-work", title: "My work", icon: <UserIcon />, keys: ["G", "M"], run: go("/my-work") },
    ...(project
      ? [
          { id: "tasks", title: `${project.name} › Tasks`, icon: <ListIcon />, keys: ["G", "T"], run: go(projectPath(project, "tasks")) },
          ...(workflows.length > 1
            ? workflows.map((w) => ({
                id: `board ${w.id}`,
                title: `${project.name} › ${w.name} board`,
                icon: <KanbanIcon />,
                ...(w.id === boardWorkflow ? { keys: ["G", "B"] } : {}),
                run: go(projectPath(project, "tasks", "board", { [workflowParam]: w.id })),
              }))
            : [{ id: "board", title: `${project.name} › Tasks board`, icon: <KanbanIcon />, keys: ["G", "B"], run: go(projectPath(project, "tasks", "board")) }]),
          { id: "workflow", title: `${project.name} › Workflow`, icon: <WorkflowIcon />, keys: ["G", "W"], run: go(projectPath(project, "workflow")) },
          { id: "agents", title: `${project.name} › Agents`, icon: <ZapIcon />, keys: ["G", "A"], run: go(projectPath(project, "agents")) },
          { id: "activity", title: `${project.name} › Activity`, icon: <ActivityIcon />, run: go(projectPath(project, "activity")) },
        ]
      : []),
    { id: "account", title: "Settings › Account", icon: <CircleUserIcon />, run: go("/settings/account") },
    ...(admin
      ? organisationPages.map((page) => ({
          id: `organisation-${page}`,
          title: `Settings › ${page}`,
          icon: <BuildingIcon />,
          run: go(`/settings/organisation/${page.toLowerCase()}`),
        }))
      : []),
    ...(project ? [{ id: "project-settings", title: `Settings › ${project.name}`, icon: <SettingsIcon />, run: go(projectSettingsPath(project)) }] : []),
  ].map((p) => ({ ...p, key: "" }));
  const actions: Named[] = [
    { id: "file-task", key: "", title: "File a Task", icon: <PlusIcon />, keys: ["C"], run: () => sendIntent({ kind: "file-task", project: project?.key }) },
    ...(admin ? [{ id: "new-project", key: "", title: "New Project", icon: <PlusIcon />, run: () => sendIntent({ kind: "new-project" }) }] : []),
  ];

  const named = (n: Named): Entry => ({ id: n.id, content: <>{n.icon}{n.title}</>, keys: n.keys, run: n.run });
  const projectEntry = (p: (typeof projects)[number]): Entry => ({
    id: `project ${p.key}`,
    content: (
      <>
        <ProjectMark project={p} />
        <span className="truncate">{p.name}</span>
        <span className="font-mono text-2xs text-muted-foreground">{p.key}</span>
        {p.id === project?.id && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
      </>
    ),
    // To the same place in the other Project, or its Tasks.
    run: go(projectPath(p, area ?? "tasks")),
  });
  const words = query.trim();
  // With nothing typed, the actions, the Projects and the places; else what matches, best group first.
  const found: Group[] = words
    ? orderGroups([
        group("Tasks", rankRecords(query, tasks.data ?? []), (t) => ({
          id: `task ${t.key}`,
          content: (
            <>
              <WorkGlyph glyph={taskWorkGlyph(t, now, (id) => byId.get(id)?.kind, sessions?.find((s) => s.task_id === t.id)?.state)} />{" "}
              <Key>{t.key}</Key> <span className="truncate">{t.title}</span>{" "}
              <span className="ml-auto truncate text-xs text-muted-foreground">{projectsById.get(t.project_id)?.name}</span>
            </>
          ),
          run: go(`/tasks/${t.key}`),
        })),
        group("Projects", rankRecords(query, projects), projectEntry),
        group("Members", rankRecords(query, members, 5), (m) => ({
          id: `member ${m.id}`,
          content: (
            <>
              <MemberAvatar member={m} card={false} /> <span className="truncate">{m.name}</span>{" "}
              <span className="ml-auto text-xs text-muted-foreground">{m.kind === "agent" ? "Agent" : "Human"}</span>
            </>
          ),
          run: admin
            ? go(`/settings/organisation/${m.kind === "agent" ? "agents" : "members"}/${m.id}`)
            : go(project ? `${projectPath(project, "agents")}?agent=${encodeURIComponent(m.name)}` : "/inbox"),
        })),
        group("Go to", rankRecords(query, places, places.length), named),
        group("Actions", rankRecords(query, actions), named),
      ]).filter((g) => g.entries.length > 0)
    : [
        { heading: "Actions", best: 0, entries: actions.map(named) },
        { heading: "Projects", best: 0, entries: projects.map(projectEntry) },
        { heading: "Go to", best: 0, entries: places.map(named) },
      ].filter((g) => g.entries.length > 0);
  // Words that match nothing can still be filed, as a Task's title.
  const groups: Group[] =
    words && found.length === 0
      ? [
          {
            heading: "No match",
            best: 0,
            entries: [
              {
                id: "file-task-titled",
                content: <><PlusIcon />File a Task “{words}”</>,
                run: () => sendIntent({ kind: "file-task", project: project?.key, title: words }),
              },
            ],
          },
        ]
      : found;

  const close = (then: () => void) => {
    onOpenChange(false);
    setQuery("");
    then();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQuery("");
      }}
      title="Search"
      description="Find a Task, a Project or a Member by key, name or words, go to a page, or run an action."
      showCloseButton={false}
      className="top-[120px] translate-y-0 sm:max-w-[640px]"
      shouldFilter={false}
    >
      <CommandInput placeholder="Search Tasks, Projects, Members and pages" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No match</CommandEmpty>
        {groups.map((g) => (
          <CommandGroup key={g.heading} heading={g.heading}>
            {g.entries.map((e) => (
              <CommandItem key={e.id} value={e.id} onSelect={() => close(e.run)}>
                {e.content}
                {e.keys && (
                  <span className="ml-auto flex gap-1">
                    {e.keys.map((k) => (
                      <Kbd key={k} className="border">
                        {k}
                      </Kbd>
                    ))}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
