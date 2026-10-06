// W2 Board owns this folder: Team › Tasks (list and board), Team › Features, File Task and File
// Feature. routes.tsx imports what this file exports.
import { useState } from "react";
import { useMatch } from "react-router";
import { useTeams } from "@/api/queries";
import { useCurrentTeam } from "@/app/currentTeam";
import { useIntent } from "@/app/intents";
import { FileFeatureDialog, FileTaskDialog } from "./FileDialogs";
import { useFileTaskPreset, type FileTaskPreset } from "./state";

export { TeamFeaturesPage } from "./TeamFeaturesPage";
export { TeamTasksPage } from "./TeamTasksPage";

type Open = { kind: "file-task"; preset: FileTaskPreset; n: number } | { kind: "file-feature"; team?: string; n: number } | null;

/**
 * Mounted once by the shell, so C and ⌘K open File Task from any screen: answers the
 * `file-task` and `file-feature` intents (src/app/intents.ts), and a column's + (openFileTask).
 */
export function BoardDialogs() {
  const [open, setOpen] = useState<Open>(null);
  const current = useCurrentTeam();
  const teams = useTeams().data ?? [];
  // On a Feature's page, File Task starts in that Feature.
  const onFeature = useMatch("/features/:feature")?.params.feature;
  const fileTask = (preset: FileTaskPreset) => setOpen((o) => ({ kind: "file-task", preset, n: (o?.n ?? 0) + 1 }));
  useIntent("file-task", (i) => fileTask({ team: i.team, feature: onFeature }));
  useFileTaskPreset(fileTask);
  useIntent("file-feature", (i) => setOpen((o) => ({ kind: "file-feature", team: i.team, n: (o?.n ?? 0) + 1 })));

  const close = () => setOpen(null);
  if (open?.kind === "file-task") {
    const key = open.preset.team ?? current?.key;
    const team = teams.find((t) => t.key === key || t.id === key) ?? current;
    return <FileTaskDialog key={open.n} team={team} status={open.preset.status} feature={open.preset.feature} onClose={close} />;
  }
  if (open?.kind === "file-feature") return <FileFeatureDialog key={open.n} team={open.team ?? current?.key} onClose={close} />;
  return null;
}
