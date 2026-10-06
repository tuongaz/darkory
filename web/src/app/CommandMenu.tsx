import { KanbanIcon, LayersIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Feature, Task } from "@/api/client";
import { useAllFeatures, useAllTasks, useDirectory } from "@/api/queries";
import { useNow } from "@/clock";
import { Key } from "@/components/Key";
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
import { taskGlyph } from "@/work";
import { teamTasksPath, useCurrentTeam } from "./currentTeam";
import { sendIntent } from "./intents";
import { matchRecords } from "./search";

/** ⌘K (F-B6): Tasks and Features by key or words, then the actions. */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const team = useCurrentTeam();
  const tasks = useAllTasks(open);
  const features = useAllFeatures(open);
  const { teams } = useDirectory();
  const now = useNow();

  const taskHits = useMemo(() => matchRecords(query, tasks.data ?? []), [query, tasks.data]);
  const featureHits = useMemo(() => matchRecords(query, features.data ?? []), [query, features.data]);
  const featureTitles = useMemo(() => new Map((features.data ?? []).map((f) => [f.id, f.title])), [features.data]);

  const actions = [
    { id: "file-task", label: "File a Task", icon: <PlusIcon />, keys: ["C"], run: () => sendIntent({ kind: "file-task", team: team?.key }) },
    {
      id: "file-feature",
      label: "File a Feature",
      icon: <LayersIcon />,
      keys: [],
      run: () => sendIntent({ kind: "file-feature", team: team?.key }),
    },
    ...(team
      ? [
          {
            id: "board",
            label: `Go to ${team.name} › Tasks board`,
            icon: <KanbanIcon />,
            keys: ["G", "B"],
            run: () => navigate(teamTasksPath(team, "board")),
          },
        ]
      : []),
  ].filter((a) => !query.trim() || query.trim().toLowerCase().split(/\s+/).every((w) => a.label.toLowerCase().includes(w)));

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
      description="Find a Task or a Feature by key or words, or run an action."
      showCloseButton={false}
      className="top-[120px] translate-y-0 sm:max-w-[640px]"
      shouldFilter={false}
    >
      <CommandInput placeholder="Search Tasks and Features" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No match</CommandEmpty>
        {taskHits.length > 0 && (
          <CommandGroup heading="Tasks">
            {taskHits.map((t: Task) => (
              <CommandItem key={t.id} value={`task ${t.key}`} onSelect={() => close(() => navigate(`/tasks/${t.key}`))}>
                <StatusGlyph glyph={taskGlyph(t, now)} />
                <Key>{t.key}</Key>
                <span className="truncate">{t.title}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">{featureTitles.get(t.feature_id)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {featureHits.length > 0 && (
          <CommandGroup heading="Features">
            {featureHits.map((f: Feature) => (
              <CommandItem key={f.id} value={`feature ${f.key}`} onSelect={() => close(() => navigate(`/features/${f.key}`))}>
                <LayersIcon className="text-muted-foreground" />
                <Key>{f.key}</Key>
                <span className="truncate">{f.title}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">{teams.get(f.team_id)?.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {actions.length > 0 && (
          <CommandGroup heading="Actions">
            {actions.map((a) => (
              <CommandItem key={a.id} value={`action ${a.id}`} onSelect={() => close(a.run)}>
                {a.icon}
                {a.label}
                {a.keys.length > 0 && (
                  <span className="ml-auto flex gap-1">
                    {a.keys.map((k) => (
                      <Kbd key={k} className="border">
                        {k}
                      </Kbd>
                    ))}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
