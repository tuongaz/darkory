import { useState } from "react";
import { useIntent } from "@/app/intents";
import { useCurrentProject } from "@/app/currentProject";
import { FileTaskDialog } from "./FileTaskDialog";
import { useFileTaskPreset, type FileTaskPreset } from "./state";

export { TasksPage } from "./TasksPage";

/**
 * The dialogs the shell mounts once over every page: File a Task, for the `file-task` intent (C,
 * ⌘K, the checklist, a column's +, a Parent's Add Subtask) and for a Task's Ask a question.
 */
export function BoardDialogs() {
  const current = useCurrentProject();
  // A fresh form each time it opens, in the Project it was opened for.
  const [opened, setOpened] = useState<{ n: number; preset: FileTaskPreset } | null>(null);
  const open = (preset: FileTaskPreset) => setOpened((o) => ({ n: (o?.n ?? 0) + 1, preset: { ...preset, project: preset.project ?? current?.key } }));
  useIntent("file-task", ({ project, step, parent, title }) => open({ project, step, parent, title }));
  useFileTaskPreset(open);
  if (!opened) return null;
  return <FileTaskDialog key={opened.n} preset={opened.preset} onClose={() => setOpened(null)} />;
}
