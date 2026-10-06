// W2 Board owns this folder: Team › Tasks (list and board), Team › Features, File Task and File
// Feature. Placeholders until W2 lands; routes.tsx imports what this file exports.
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useTeams } from "@/api/queries";
import { PlaceholderPage } from "@/app/Placeholder";
import { useIntent, type Intent } from "@/app/intents";
import { TeamMark } from "@/components/TeamMark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const owner = "W2 Board";

function useTeamCrumb(section: string) {
  const { team: key = "" } = useParams();
  const team = useTeams().data?.find((t) => t.key === key);
  return [{ label: team?.name ?? key, icon: team ? <TeamMark team={team} /> : undefined }, { label: section }];
}

/** /teams/:team/tasks?view=list|board */
export function TeamTasksPage() {
  const crumbs = useTeamCrumb("Tasks");
  const [params] = useSearchParams();
  const view = params.get("view") === "board" ? "board" : "list";
  const other = new URLSearchParams(params);
  other.set("view", view === "board" ? "list" : "board");
  return (
    <PlaceholderPage
      title={view === "board" ? "Tasks, board" : "Tasks, list"}
      owner={owner}
      crumbs={crumbs}
      view={
        <Button asChild variant="outline" size="xs">
          <Link to={{ search: `?${other}` }}>{view === "board" ? "List" : "Board"}</Link>
        </Button>
      }
    />
  );
}

/** /teams/:team/features */
export function TeamFeaturesPage() {
  return <PlaceholderPage title="Features" owner={owner} crumbs={useTeamCrumb("Features")} />;
}

/**
 * Mounted once by the shell, so C and ⌘K open File Task from any screen: answers the
 * `file-task` and `file-feature` intents (src/app/intents.ts).
 */
export function BoardDialogs() {
  const [open, setOpen] = useState<Intent | null>(null);
  useIntent("file-task", setOpen);
  useIntent("file-feature", setOpen);
  const title = open?.kind === "file-feature" ? "File a Feature" : "File a Task";
  return (
    <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
      <DialogContent className="top-20 translate-y-0 sm:max-w-[480px]">
        <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
        <DialogDescription>
          Built by {owner}.{open?.team && ` Team ${open.team}.`}
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}
