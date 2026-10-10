import { useMutation } from "@tanstack/react-query";
import { ArrowRightIcon, BookOpenIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { BarAction } from "@/app/TopBar";
import type { Skill, SkillDetail, SkillVersion } from "@/api/client";
import { useDirectory, useSkills } from "@/api/queries";
import { createSkill } from "@/api/writes";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { Pill } from "@/components/Pill";
import { Property, PropertiesRail } from "@/components/PropertiesRail";
import { Markdown } from "@/components/Markdown";
import { Loaded } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { LoadingFrame, SettingsFrame, tableHead, tableRow } from "./frame";
import { Stamp } from "./credentials";
import { holdersBySkill, humansFirst, lineDiff, pendingProposals, skillNamePattern, type Pending } from "./model";
import { Avatars, Segmented } from "./parts";
import { skillPath, skillsPath } from "./paths";
import { useMemberDetails, useRetrospectives, useSkillDetail, useSkillTasks, useSkillVersions } from "./queries";

// Skill · Kind · Builds on · Built in · Current · Held by. A phone keeps Skill and Held by.
const cols = "grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_90px_120px_80px_90px_220px]";
const wide = "hidden md:flex";

/** Settings › Organisation › Skills: every Skill, what it builds on, who holds it, and the proposals waiting for review. */
export function SkillsPage() {
  const skills = useSkills();
  const { details } = useMemberDetails();
  const retros = useRetrospectives();
  const [open, setOpen] = useState(false);
  const holders = holdersBySkill(details);
  const byId = new Map((skills.data ?? []).map((s) => [s.id, s]));

  return (
    <SettingsFrame
      crumbs={[{ label: "Skills" }]}
      pad={false}
      primary={<BarAction icon={<PlusIcon />} label="New Skill" onClick={() => setOpen(true)} />}
    >
      <Loaded query={skills} loading={<Skeleton className="m-6 h-8" />}>
        {(list) => (
          <div role="table" aria-label="Skills" className="min-w-0">
            <div role="row" className={cn(tableHead, cols)}>
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
              const pending = pendingProposals(s, retros.details);
              const base = s.base_skill_id ? byId.get(s.base_skill_id) : undefined;
              return (
                <div role="row" key={s.id} aria-label={s.name} className={cn(tableRow, "hover:bg-accent/60", cols)}>
                  <span role="cell" className="flex min-w-0 items-center gap-2">
                    <Link to={skillPath(s)} className="truncate font-medium after:absolute after:inset-0">
                      {s.name}
                    </Link>
                    {pending.length > 0 && (
                      <Pill className="hidden sm:inline-flex">
                        <BookOpenIcon className="size-3" />
                        {pending.length === 1 ? "1 proposal" : `${pending.length} proposals`}
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
    </SettingsFrame>
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
      navigate(skillPath(d.skill));
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
        <FormRow label="Kind" info="A generic Skill is what a Member arrives with; a company Skill builds on a generic one and adds the company's own knowledge.">
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
            <Select value={base} onValueChange={setBase}>
              <SelectTrigger id="skill-base" size="sm" className="h-8 w-full">
                <SelectValue placeholder="A generic Skill" />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {generics.map((s) => (
                  <SelectItem key={s.id} value={s.name}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
        )}
        <FormRow label="Text" htmlFor="skill-body" info="Published as version 1.">
          <Textarea id="skill-body" required rows={6} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
        </FormRow>
      </FormRows>
    </FormDialog>
  );
}

/** Settings › Organisation › Skills › a Skill: the current text, the proposals waiting for review, the versions. */
export function SkillPage() {
  const { skill: ref = "" } = useParams();
  const skill = useSkillDetail(ref);
  return (
    <Loaded
      query={skill}
      loading={<LoadingFrame crumbs={[{ label: "Skills", to: skillsPath }]} />}
    >
      {(d) => <SkillRecord detail={d} />}
    </Loaded>
  );
}

function SkillRecord({ detail }: { detail: SkillDetail }) {
  const { skill, current } = detail;
  const { skills } = useDirectory();
  const { details } = useMemberDetails();
  const retros = useRetrospectives();
  const versions = useSkillVersions(skill.name);
  const tasks = useSkillTasks(skill.id);
  const pending = pendingProposals(skill, retros.details);
  const base = skill.base_skill_id ? skills.get(skill.base_skill_id) : undefined;
  const holders = humansFirst(holdersBySkill(details).get(skill.id) ?? []);

  return (
    <SettingsFrame crumbs={[{ label: "Skills", to: skillsPath, wide: true }, { label: skill.name }]}>
      <div className="grid max-w-[1100px] grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-[22px]">
          <div className="flex flex-wrap items-center gap-2.5">
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
          {pending.map((p) => (
            <ProposalSection key={p.proposal.id} pending={p} current={current.body} versions={versions.data} />
          ))}
        </div>
        <aside aria-label="About the Skill" className="min-w-0 lg:border-l lg:pl-6">
          <PropertiesRail compact>
            <Property label="Builds on">
              {base ? (
                <Link to={skillPath(base)} className="underline underline-offset-2">
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
          <Loaded query={versions}>{(list) => <Versions skill={skill} list={list} />}</Loaded>
        </aside>
      </div>
    </SettingsFrame>
  );
}

function Versions({ skill, list }: { skill: Skill; list: SkillVersion[] }) {
  const { members } = useDirectory();
  return (
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
  );
}

/**
 * A proposal waiting for review: the Retrospective that carries it, its author, the change against
 * the version it was written on (which a later one may have replaced), and the author's Note.
 */
function ProposalSection({ pending, current, versions }: { pending: Pending; current: string; versions?: SkillVersion[] }) {
  const { members } = useDirectory();
  const { proposal, retro } = pending;
  const author = members.get(proposal.author_id);
  const basedOn = versions?.find((v) => v.version === proposal.based_on_version)?.body;
  return (
    <section aria-label={`Proposal from ${retro.task.key}`}>
      <h2 className="mb-2 flex flex-wrap items-center gap-2 font-semibold">
        Proposal
        <span className="font-normal text-muted-foreground">on version {proposal.based_on_version}</span>
        <Pill tone="waiting">Pending review</Pill>
      </h2>
      <div className="overflow-hidden rounded-md border">
        <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-2 border-b py-1.5 pr-2 pl-3">
          <BookOpenIcon className="size-3.5 text-muted-foreground" />
          <span>From</span>
          <Key className="text-foreground">{retro.task.key}</Key>
          <span className="min-w-0 flex-1 truncate">{retro.task.title}</span>
          {author && (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
              <MemberAvatar member={author} />
              {author.name} · <Stamp at={proposal.created_at} />
            </span>
          )}
          <Button asChild variant="outline" size="xs">
            <Link to={`/tasks/${retro.task.key}`}>
              Open Task
              <ArrowRightIcon />
            </Link>
          </Button>
        </div>
        <Diff before={basedOn ?? current} after={proposal.body} />
        <ProposalNote retroNotes={retro.notes} author={proposal.author_id} since={proposal.created_at} />
      </div>
    </section>
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
      <Markdown text={note.body} className="min-w-0" />
    </div>
  );
}
