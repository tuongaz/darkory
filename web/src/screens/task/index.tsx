// W3 Task and Feature owns this folder: the Task page and its Peek, the Feature page, and their
// dialogs. Placeholders until W3 lands; routes.tsx imports what this file exports.
import { Link, useParams } from "react-router";
import { PlaceholderPage } from "@/app/Placeholder";
import { EmptyState } from "@/components/EmptyState";
import { Key } from "@/components/Key";
import { Peek } from "@/components/Peek";
import { Button } from "@/components/ui/button";

const owner = "W3 Task and Feature";

/** /tasks/:task */
export function TaskPage() {
  const { task = "" } = useParams();
  return <PlaceholderPage title="Task" owner={owner} crumbs={[{ label: "Task" }, { label: task }]} />;
}

/** /features/:feature */
export function FeaturePage() {
  const { feature = "" } = useParams();
  return <PlaceholderPage title="Feature" owner={owner} crumbs={[{ label: "Feature" }, { label: feature }]} />;
}

/** The Task opened over any page by ?task=<key>; the shell mounts it and closes it by dropping the parameter. */
export function TaskPeek({ taskKey, onClose }: { taskKey: string; onClose: () => void }) {
  return (
    <Peek
      open
      onOpenChange={(o) => !o && onClose()}
      label={`Task ${taskKey}`}
      heading={<Key className="text-xs">{taskKey}</Key>}
      actions={
        <Button asChild variant="ghost" size="xs">
          <Link to={`/tasks/${encodeURIComponent(taskKey)}`}>Open page</Link>
        </Button>
      }
    >
      <EmptyState title="Task peek">Built by {owner}.</EmptyState>
    </Peek>
  );
}
