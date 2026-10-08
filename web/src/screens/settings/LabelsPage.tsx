import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useLabels, useProject, useProjectLabels } from "@/api/queries";
import { useRouteProject } from "@/app/currentProject";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { useCurrentMe } from "@/me";
import { SettingsFrame } from "./frame";
import { LabelsEditor } from "./LabelsEditor";

/** Settings › Organisation › Labels: the Labels every Project's Tasks may carry. Admins only, as the route is. */
export function OrganisationLabelsPage() {
  const labels = useLabels();
  const [adding, setAdding] = useState(false);
  return (
    <SettingsFrame
      crumbs={[{ label: "Labels" }]}
      pad={false}
      primary={
        <Button onClick={() => setAdding(true)} disabled={adding}>
          <PlusIcon />
          New Label
        </Button>
      }
    >
      <Refusal error={labels.error} className="px-6 py-4" />
      <LabelsEditor
        labels={labels.data}
        editable
        adding={adding}
        onAddingChange={setAdding}
        emptyHint="A Label is a named colour any Task may carry; every Project's Tasks may carry these."
      />
    </SettingsFrame>
  );
}

/**
 * Settings › a Project › Labels: the Project's own, which only its Tasks may carry, with the
 * Organisation's under them for the names they share. Its Members and admins change them, as /v1
 * allows; anyone else reads.
 */
export function ProjectLabelsPage() {
  const project = useRouteProject();
  const me = useCurrentMe();
  const own = useProjectLabels(project.key);
  const org = useLabels();
  const members = useProject(project.key).data?.members;
  const editable = me.member.admin || !!members?.some((m) => m.id === me.member.id);
  const [adding, setAdding] = useState(false);
  return (
    <SettingsFrame
      crumbs={[{ label: project.name, wide: true }, { label: "Labels" }]}
      pad={false}
      primary={
        editable && (
          <Button onClick={() => setAdding(true)} disabled={adding}>
            <PlusIcon />
            New Label
          </Button>
        )
      }
    >
      <Refusal error={own.error} className="px-6 py-4" />
      <LabelsEditor
        labels={own.data}
        project={project.key}
        editable={editable}
        others={org.data}
        adding={adding}
        onAddingChange={setAdding}
        emptyHint={`${project.name}'s own Labels: only its Tasks carry them.`}
      />
      {org.data && org.data.length > 0 && (
        <section aria-label="The Organisation's Labels" className="px-6 pt-6 pb-6">
          <h2 className="mb-2 flex items-center gap-2 font-semibold">
            The Organisation&apos;s <span className="font-normal text-muted-foreground tabular-nums">{org.data.length}</span>
            {me.member.admin && (
              <Link to="/settings/organisation/labels" className="ml-auto text-xs font-normal text-muted-foreground hover:text-foreground hover:underline">
                Change in Organisation
              </Link>
            )}
          </h2>
          <ul className="flex flex-wrap gap-1.5">
            {org.data.map((l) => (
              <li key={l.id} className="inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs">
                <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: l.color }} />
                {l.name}
              </li>
            ))}
          </ul>
        </section>
      )}
    </SettingsFrame>
  );
}
