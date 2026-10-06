import { useMutation } from "@tanstack/react-query";
import { ArrowRightIcon, BookOpenIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { Skill, SkillDetail } from "@/api/client";
import { useDirectory, useSkills } from "@/api/queries";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Property, PropertiesRail } from "@/components/PropertiesRail";
import { Loaded } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AdminFrame } from "./AdminLayout";
import { Stamp } from "./credentials";
import { holdersBySkill, humansFirst, lineDiff, pendingProposal, skillNamePattern } from "./model";
import { Avatars, Choice, Segmented } from "./parts";
import { useMemberDetails, useRetrospectives, useSkillDetail, useSkillTasks, useSkillVersions } from "./queries";
import { createSkill } from "./writes";

// Skill · Kind · Builds on · Built in · Current · Held by (F-D5a). A phone keeps Skill and Held by.
const cols = "grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_90px_120px_80px_90px_220px]";
const wide = "hidden md:flex";

/** /admin/skills (F-D5a): every Skill, what it builds on, who holds it, and a pending proposal. */
export function SkillsPage() {
  const skills = useSkills();
  const { details } = useMemberDetails();
  const retros = useRetrospectives();
  const [open, setOpen] = useState(false);
  const holders = holdersBySkill(details);
  const byId = new Map((skills.data ?? []).map((s) => [s.id, s]));

  return (
    <AdminFrame
      crumbs={[{ label: "Skills" }]}
      pad={false}
      primary={
        <Button onClick={() => setOpen(true)}>
          <PlusIcon />
          New Skill
        </Button>
      }
    >
      <Loaded query={skills} loading={<Skeleton className="m-6 h-8" />}>
        {(list) => (
          <div role="table" aria-label="Skills" className="min-w-0">
            <div role="row" className={cn("grid h-8 items-center gap-3 border-b px-6 text-xs font-medium text-muted-foreground", cols)}>
              <span role="columnheader">Skill</span>
              <span role="columnheader" className={wide}>
                Kind
              </span>
              <span role="columnheader" className={wide}>
                Builds on
              </span>
              <span role="columnheader" className={wide}>
                Built in
              </span>
              <span role="columnheader" className={wide}>
                Current
              </span>
              <span role="columnheader">Held by</span>
            </div>
            {list.map((s) => {
              const pending = pendingProposal(s, retros.details);
              const base = s.base_skill_id ? byId.get(s.base_skill_id) : undefined;
              return (
                <div role="row" key={s.id} aria-label={s.name} className={cn("relative grid h-10 items-center gap-3 border-b px-6 hover:bg-accent/60", cols)}>
                  <span role="cell" className="flex min-w-0 items-center gap-2">
                    <Link to={`/admin/skills/${s.name}`} className="truncate font-medium after:absolute after:inset-0">
                      {s.name}
                    </Link>
                    {pending && (
                      <Pill className="hidden sm:inline-flex">
                        <BookOpenIcon className="size-3" />
                        Proposal · version {pending.proposal.based_on_version + 1}
                      </Pill>
                    )}
                  </span>
                  <span role="cell" className={cn(wide, "text-muted-foreground")}>
                    {s.kind}
                  </span>
                  <span role="cell" className={wide}>
                    {base ? base.name : <span className="text-muted-foreground">—</span>}
                  </span>
                  <span role="cell" className={wide}>
                    {s.builtin && <Pill>Built in</Pill>}
                  </span>
                  <span role="cell" className={cn(wide, "tabular-nums")}>
                    version {s.current_version}
                  </span>
                  <span role="cell" className="min-w-0">
                    <Avatars members={humansFirst(holders.get(s.id) ?? [])} max={5} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Loaded>
      {open && <NewSkillDialog skills={skills.data ?? []} onClose={() => setOpen(false)} />}
    </AdminFrame>
  );
}

/** New Skill: its name, kind, the generic Skill a company one builds on, and the text published as version 1. */
function NewSkillDialog({ skills, onClose }: { skills: Skill[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"generic" | "company">("generic");
  const [base, setBase] = useState("");
  const [body, setBody] = useState("");
  const create = useMutation({
    mutationFn: () => createSkill({ name: name.trim(), kind, base_skill: kind === "company" ? base : undefined, body }),
    onSuccess: (d) => {
      onClose();
      navigate(`/admin/skills/${d.skill.name}`);
    },
  });
  const nameOK = skillNamePattern.test(name.trim());
  const generics = skills.filter((s) => s.kind === "generic");
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New Skill"
      submitLabel="Create Skill"
      size="lg"
      onSubmit={() => create.mutate()}
      pending={create.isPending}
      submitDisabled={!nameOK || !body.trim() || (kind === "company" && !base)}
      error={create.error}
    >
      <FormRows>
        <FormRow
          label="Name"
          htmlFor="skill-name"
          help={name.trim() && !nameOK ? <span className="text-state-blocked">Small letters, digits and dashes, as in web-qa.</span> : undefined}
        >
          <Input
            id="skill-name"
            required
            maxLength={63}
            value={name}
            aria-invalid={!!name.trim() && !nameOK}
            onChange={(e) => setName(e.target.value)}
            className="font-mono"
            autoFocus
          />
        </FormRow>
        <FormRow label="Kind">
          <Segmented
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: "generic", label: "Generic" },
              { value: "company", label: "Company" },
            ]}
          />
        </FormRow>
        {kind === "company" && (
          <FormRow label="Builds on" htmlFor="skill-base">
            <Choice
              id="skill-base"
              className="w-full"
              value={base}
              onChange={setBase}
              placeholder="A generic Skill"
              options={generics.map((s) => ({ value: s.name, label: s.name }))}
            />
          </FormRow>
        )}
        <FormRow label="Text" htmlFor="skill-body" help="Published as version 1.">
          <Textarea id="skill-body" required rows={6} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}

/** /admin/skills/:skill (F-D5b): the current text, the proposal waiting for review, the versions. */
export function SkillPage() {
  const { skill: ref = "" } = useParams();
  const skill = useSkillDetail(ref);
  return (
    <Loaded
      query={skill}
      loading={
        <AdminFrame crumbs={[{ label: "Skills", to: "/admin/skills" }]}>
          <Skeleton className="h-8 w-60" />
        </AdminFrame>
      }
    >
      {(d) => <SkillRecord detail={d} />}
    </Loaded>
  );
}

function SkillRecord({ detail }: { detail: SkillDetail }) {
  const { skill, current } = detail;
  const { members, skills } = useDirectory();
  const { details } = useMemberDetails();
  const retros = useRetrospectives();
  const versions = useSkillVersions(skill.name);
  const tasks = useSkillTasks(skill.name);
  const pending = pendingProposal(skill, retros.details);
  const base = skill.base_skill_id ? skills.get(skill.base_skill_id) : undefined;
  const holders = humansFirst(holdersBySkill(details).get(skill.id) ?? []);
  const author = pending ? members.get(pending.proposal.author_id) : undefined;
  // The proposal is read against the version it was written on, which a later one may have replaced.
  const basedOn = pending && versions.data?.find((v) => v.version === pending.proposal.based_on_version)?.body;

  return (
    <AdminFrame crumbs={[{ label: "Skills", to: "/admin/skills" }, { label: skill.name }]}>
      <div className="grid max-w-[1100px] grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-[22px]">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl leading-tight font-semibold tracking-[-0.01em]">{skill.name}</h1>
            <Pill tone="outline">{skill.kind}</Pill>
            {skill.builtin && <Pill>Built in</Pill>}
          </div>
          <section aria-label="Current text">
            <h2 className="mb-2 flex items-center gap-2 font-semibold">
              Current text <span className="font-normal text-muted-foreground">version {current.version}</span>
            </h2>
            <pre className="rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre-wrap">{current.body}</pre>
          </section>
          {pending && (
            <section aria-label="Proposal">
              <h2 className="mb-2 flex items-center gap-2 font-semibold">
                Proposal
                <span className="font-normal text-muted-foreground">version {pending.proposal.based_on_version + 1}</span>
                <Pill tone="waiting">Pending review</Pill>
              </h2>
              <div className="overflow-hidden rounded-md border">
                <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-2 border-b py-1.5 pr-2 pl-3">
                  <BookOpenIcon className="size-3.5 text-muted-foreground" />
                  <span>From</span>
                  <Key className="text-foreground">{pending.retro.task.key}</Key>
                  <span className="min-w-0 flex-1 truncate">{pending.retro.task.title}</span>
                  {author && (
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                      <MemberAvatar member={author} />
                      {author.name} · <Stamp at={pending.proposal.created_at} />
                    </span>
                  )}
                  <Button asChild variant="outline" size="xs">
                    <Link to={`/tasks/${pending.retro.task.key}`}>
                      Open Task
                      <ArrowRightIcon />
                    </Link>
                  </Button>
                </div>
                <Diff before={basedOn ?? current.body} after={pending.proposal.body} />
                <ProposalNote retroNotes={pending.retro.notes} author={pending.proposal.author_id} since={pending.proposal.created_at} />
              </div>
            </section>
          )}
        </div>
        <aside aria-label="About the Skill" className="min-w-0 lg:border-l lg:pl-6">
          <PropertiesRail compact>
            <Property label="Builds on">
              {base ? (
                <Link to={`/admin/skills/${base.name}`} className="underline underline-offset-2">
                  {base.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Property>
            <Property label="Held by">
              <Avatars members={holders} max={6} />
            </Property>
            <Property label="Open Tasks">
              {tasks.data === undefined ? (
                <Skeleton className="h-4 w-16" />
              ) : tasks.data.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span className="flex flex-wrap gap-x-2 gap-y-1">
                  {tasks.data.map((t) => (
                    <Key key={t.id} to={`/tasks/${t.key}`}>
                      {t.key}
                    </Key>
                  ))}
                </span>
              )}
            </Property>
          </PropertiesRail>
          <h2 className="mt-5 mb-2 flex items-center gap-2 font-semibold">
            Versions <span className="font-normal text-muted-foreground tabular-nums">{versions.data?.length}</span>
          </h2>
          <Loaded query={versions}>
            {(list) => (
              <ol aria-label="Versions" className="flex flex-col gap-1.5">
                {list.map((v) => {
                  const by = v.published_by ? members.get(v.published_by) : undefined;
                  return (
                    <li key={v.version} className="flex h-9 items-center gap-2 rounded-md border px-2.5">
                      <span className="tabular-nums">Version {v.version}</span>
                      {v.version === skill.current_version && <Pill tone="done">Current</Pill>}
                      <span className="ml-auto truncate text-muted-foreground">
                        <Stamp at={v.published_at} />
                        {by && ` · ${by.name}`}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Loaded>
        </aside>
      </div>
    </AdminFrame>
  );
}

/** The proposal against the text it was based on, line by line (kit `.diff`). */
function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre aria-label="Changes" className="bg-muted px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre-wrap">
      {lineDiff(before, after).map((l, i) => (
        <span
          key={i}
          className={cn(
            "block",
            l.op === "add" && "bg-state-done-bg text-state-done",
            l.op === "del" && "bg-state-blocked-bg text-state-blocked line-through",
          )}
        >
          <span className="sr-only">{l.op === "add" ? "Added: " : l.op === "del" ? "Removed: " : ""}</span>
          {l.text || " "}
        </span>
      ))}
    </pre>
  );
}

/** The author's Note on the Retrospective after proposing: why the change. */
function ProposalNote({ retroNotes, author, since }: { retroNotes: { author_id: string; body: string; created_at: string }[]; author: string; since: string }) {
  const note = [...retroNotes].reverse().find((n) => n.author_id === author && n.created_at >= since);
  if (!note) return null;
  return (
    <div className="flex min-h-10 items-center gap-2 border-t px-3 py-2">
      <MessageSquareIcon className="size-3.5 flex-none text-muted-foreground" />
      <span className="text-muted-foreground">Note</span>
      <span className="min-w-0">{note.body}</span>
    </div>
  );
}
