import {
  ActivityIcon,
  CircleUserIcon,
  InboxIcon,
  KanbanIcon,
  LayersIcon,
  ListIcon,
  PlusIcon,
  ShieldIcon,
  UserIcon,
  ZapIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useAllFeatures, useAllTasks, useDirectory } from "@/api/queries";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { StatusGlyph } from "@/components/StatusGlyph";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { useCurrentMe } from "@/me";
import { taskGlyph } from "@/work";
import { teamFeaturesPath, teamTasksPath, useCurrentTeam } from "./currentTeam";
import { sendIntent } from "./intents";
import { orderGroups, rankRecords, type Hit } from "./search";

type Entry = { id: string; content: ReactNode; keys?: string[]; run: () => void };
type Group = { heading: string; best: number; entries: Entry[] };
// What a place or an action is found by: its words, no key.
type Named = { id: string; key: string; title: string; icon: ReactNode; keys?: string[]; run: () => void };

function group<T>(heading: string, hits: Hit<T>[], entry: (record: T) => Entry): Group {
  return { heading, best: hits[0]?.score ?? Infinity, entries: hits.map((h) => entry(h.record)) };
}

/**
 * ⌘K (F-B6): Tasks, Features and Members by key, name or words, the places to go to, and the
 * actions. The group holding the best hit comes first, so a key typed whole is the first choice.
 */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const me = useCurrentMe();
  const team = useCurrentTeam();
  const tasks = useAllTasks(open);
  const features = useAllFeatures(open);
  const { teams, teamList, memberList } = useDirectory();
  const now = useNow();
  const admin = me.member.admin;

  const featureTitles = useMemo(() => new Map((features.data ?? []).map((f) => [f.id, f.title])), [features.data]);
  // An agent opens its peek on Agents; a human their Member page, which only admins have.
  const members = useMemo(
    () => memberList.filter((m) => m.kind === "agent" || admin).map((m) => ({ ...m, key: m.name, title: m.name })),
    [memberList, admin],
  );

  const go = (to: string) => () => navigate(to);
  const places: Named[] = [
    { id: "inbox", title: "Inbox", icon: <InboxIcon />, keys: ["G", "I"], run: go("/inbox") },
    { id: "my-work", title: "My work", icon: <UserIcon />, keys: ["G", "M"], run: go("/my-work") },
    { id: "agents", title: "Agents", icon: <ZapIcon />, keys: ["G", "A"], run: go("/agents") },
    { id: "activity", title: "Activity", icon: <ActivityIcon />, run: go("/activity") },
    ...teamList.flatMap((t) => [
      { id: `tasks-${t.id}`, title: `${t.name} › Tasks`, icon: <ListIcon />, run: go(teamTasksPath(t)) },
      ...(t.id === team?.id
        ? [{ id: `board-${t.id}`, title: `${t.name} › Tasks board`, icon: <KanbanIcon />, keys: ["G", "B"], run: go(teamTasksPath(t, "board")) }]
        : []),
      { id: `features-${t.id}`, title: `${t.name} › Features`, icon: <LayersIcon />, run: go(teamFeaturesPath(t)) },
    ]),
    ...(admin
      ? (["Members", "Teams", "Skills", "Workflow"] as const).map((tab) => ({
          id: `admin-${tab}`,
          title: `Admin › ${tab}`,
          icon: <ShieldIcon />,
          run: go(`/admin/${tab.toLowerCase()}`),
        }))
      : []),
    { id: "account", title: "Account", icon: <CircleUserIcon />, run: go("/account") },
  ].map((p) => ({ ...p, key: "" }));
  const actions: Named[] = [
    { id: "file-task", key: "", title: "File a Task", icon: <PlusIcon />, keys: ["C"], run: () => sendIntent({ kind: "file-task", team: team?.key }) },
    { id: "file-feature", key: "", title: "File a Feature", icon: <LayersIcon />, run: () => sendIntent({ kind: "file-feature", team: team?.key }) },
  ];

  const named = (n: Named): Entry => ({ id: n.id, content: <>{n.icon}{n.title}</>, keys: n.keys, run: n.run });
  // With nothing typed, the actions and the places; else what matches, best group first.
  const groups: Group[] = query.trim()
    ? orderGroups([
        group("Tasks", rankRecords(query, tasks.data ?? []), (t) => ({
          id: `task ${t.key}`,
          content: (
            <>
              <StatusGlyph glyph={taskGlyph(t, now)} /> <Key>{t.key}</Key> <span className="truncate">{t.title}</span>{" "}
              <span className="ml-auto truncate text-xs text-muted-foreground">{featureTitles.get(t.feature_id)}</span>
            </>
          ),
          run: go(`/tasks/${t.key}`),
        })),
        group("Features", rankRecords(query, features.data ?? []), (f) => ({
          id: `feature ${f.key}`,
          content: (
            <>
              <LayersIcon className="text-muted-foreground" />
              <Key>{f.key}</Key> <span className="truncate">{f.title}</span>{" "}
              <span className="ml-auto truncate text-xs text-muted-foreground">{teams.get(f.team_id)?.name}</span>
            </>
          ),
          run: go(`/features/${f.key}`),
        })),
        group("Members", rankRecords(query, members, 5), (m) => ({
          id: `member ${m.id}`,
          content: (
            <>
              <MemberAvatar member={m} /> <span className="truncate">{m.name}</span>{" "}
              <span className="ml-auto text-xs text-muted-foreground">{m.kind === "agent" ? "Agent" : "Human"}</span>
            </>
          ),
          run: go(m.kind === "agent" ? `/agents?agent=${encodeURIComponent(m.name)}` : `/admin/members/${m.id}`),
        })),
        group("Go to", rankRecords(query, places, places.length), named),
        group("Actions", rankRecords(query, actions), named),
      ]).filter((g) => g.entries.length > 0)
    : [
        { heading: "Actions", best: 0, entries: actions.map(named) },
        { heading: "Go to", best: 0, entries: places.map(named) },
      ];

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
      description="Find a Task, a Feature or a Member by key, name or words, go to a page, or run an action."
      showCloseButton={false}
      className="top-[120px] translate-y-0 sm:max-w-[640px]"
      shouldFilter={false}
    >
      <CommandInput placeholder="Search Tasks, Features, Members and pages" value={query} onValueChange={setQuery} />
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
