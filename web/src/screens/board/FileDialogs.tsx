// F-T7 File a Task and F-F3 File a Feature. BoardDialogs (index.tsx) mounts them once for the
// whole app: C, ⌘K, a column's +, the Install checklist and the Features page open them.
import { useMutation } from "@tanstack/react-query";
import { ChevronRightIcon, LayersIcon, LinkIcon, SearchIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, ApiError, call, type Team } from "@/api/client";
import { useDirectory, useTeams } from "@/api/queries";
import { usePeekLink } from "@/app/peek";
import { FormDialog } from "@/components/FormDialog";
import { Key } from "@/components/Key";
import { MemberAvatar } from "@/components/MemberAvatar";
import { StatusSelect } from "@/components/StatusSelect";
import { TeamMark } from "@/components/TeamMark";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useCurrentMe } from "@/me";
import { Combobox } from "./Combobox";
import { defaultFileStatus } from "./derive";
import { useStatuses, useTeamFeatures, useTeamTasks } from "./queries";

/** One field of the dialogs' 12-column form (kit `.field`): its label over its control, and what is wrong with it. */
function Field({ label, htmlFor, error, className, children }: { label: ReactNode; htmlFor?: string; error?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("grid min-w-0 content-start gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="h-[18px] text-[12.5px] font-medium">
        {label}
      </Label>
      {children}
      {error && (
        <p role="alert" className="text-xs text-state-blocked">
          {error}
        </p>
      )}
    </div>
  );
}

/** A refusal reworded where the API's message names a rule the filer can act on. */
function inWords(err: unknown, words: (code: string) => string | undefined): unknown {
  if (!(err instanceof ApiError)) return err;
  const said = words(err.code);
  return said ? new ApiError(err.status, err.code, said, err.details) : err;
}

type Who = "skill" | "member";

/** F-T7: Feature, Title, Description, who can take it, Status, Blocks, and Create more. */
export function FileTaskDialog({
  team,
  status: presetStatus,
  feature: presetFeature,
  onClose,
}: {
  team: Team | undefined;
  status?: string;
  feature?: string;
  onClose: () => void;
}) {
  const features = useTeamFeatures(team?.key);
  const tasks = useTeamTasks(team?.key);
  const statuses = useStatuses();
  const { skillList, memberList } = useDirectory();
  const navigate = useNavigate();
  const peek = usePeekLink();
  const titleRef = useRef<HTMLInputElement>(null);

  const openFeatures = (features.data ?? []).filter((f) => f.state === "open");
  const [chosenFeature, setFeatureKey] = useState<string | undefined>(presetFeature);
  // A Feature given from the page in view counts only when it is one of this Team's open Features.
  const featureKey = features.data && !openFeatures.some((f) => f.key === chosenFeature) ? undefined : chosenFeature;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [who, setWho] = useState<Who>("skill");
  const [skillId, setSkillId] = useState<string>();
  const [memberId, setMemberId] = useState<string>();
  const [statusId, setStatusId] = useState<string | undefined>(presetStatus);
  const [blocksKey, setBlocksKey] = useState<string>();
  const [more, setMore] = useState(false);
  const [errors, setErrors] = useState<{ feature?: string; title?: string; who?: string }>({});

  const chosenStatus = statusId ?? defaultFileStatus(statuses.data ?? [])?.id;
  const blockable = (tasks.data ?? []).filter((t) => t.state === "open" && (!featureKey || features.data?.find((f) => f.key === featureKey)?.id === t.feature_id));
  const featureById = new Map((features.data ?? []).map((f) => [f.id, f]));

  const file = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/tasks", {
          body: {
            feature: featureKey,
            title: title.trim(),
            description: description.trim() || undefined,
            skill: who === "skill" ? skillId : undefined,
            aimed_at: who === "member" ? memberId : undefined,
            status: chosenStatus,
            blocks: blocksKey,
          },
        }),
      ),
    onSuccess: (filed) => {
      const key = filed.task.key;
      toast(`Filed ${key}`, { description: filed.task.title, action: { label: "Open", onClick: () => navigate(peek(key)) } });
      if (!more) return onClose();
      setTitle("");
      setDescription("");
      setBlocksKey(undefined);
      file.reset();
      titleRef.current?.focus();
    },
  });

  const submit = () => {
    const next = {
      feature: featureKey ? undefined : "Choose a Feature.",
      title: title.trim() ? undefined : "Name the Task.",
      who: (who === "skill" ? skillId : memberId) ? undefined : who === "skill" ? "Choose a Skill." : "Choose a Member.",
    };
    setErrors(next);
    if (next.feature || next.title || next.who) return;
    file.mutate();
  };

  const teamName = team?.name ?? "this Team";
  const error = inWords(file.error, (code) => {
    if (code === "forbidden")
      return blocksKey
        ? `Only a Member of ${teamName} or the Feature's owner files a Task that blocks ${blocksKey}.`
        : `Only Members of ${teamName} file its Tasks; an admin can add you to ${teamName}.`;
    if (code === "not_holder" && blocksKey) return `${blocksKey} is held by someone else; only its holder files a Task that blocks it.`;
    return undefined;
  });

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={
        <span className="flex min-w-0 items-center gap-2">
          {team && (
            <span aria-hidden className="inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-normal">
              <TeamMark team={team} />
              {team.name}
            </span>
          )}
          {team && <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />}
          File a Task
        </span>
      }
      submitLabel="File Task"
      onSubmit={submit}
      pending={file.isPending}
      error={error}
      hint={
        <label className="flex cursor-pointer items-center gap-2">
          <Switch checked={more} onCheckedChange={setMore} aria-label="Create more" />
          Create more
        </label>
      }
    >
      <div className="grid grid-cols-1 gap-x-3 gap-y-3.5 sm:grid-cols-12">
        <Field label="Feature" htmlFor="file-task-feature" error={errors.feature} className="sm:col-span-12">
          <Combobox
            id="file-task-feature"
            value={featureKey}
            onChange={(v) => {
              setFeatureKey(v);
              if (v && blocksKey && tasks.data?.find((t) => t.key === blocksKey)?.feature_id !== features.data?.find((f) => f.key === v)?.id) setBlocksKey(undefined);
            }}
            options={openFeatures.map((f) => ({ value: f.key, label: f.title, keywords: [f.key], detail: <Key>{f.key}</Key> }))}
            placeholder="Choose a Feature"
            searchPlaceholder="Search Features"
            empty={team ? `No open Feature in ${team.name}` : "No Team"}
            icon={<LayersIcon />}
            invalid={!!errors.feature}
          />
        </Field>
        <Field label="Title" htmlFor="file-task-title" error={errors.title} className="sm:col-span-12">
          <Input
            id="file-task-title"
            ref={titleRef}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            maxLength={200}
            aria-invalid={!!errors.title || undefined}
            className="h-9 text-[15px] font-medium"
          />
        </Field>
        <Field label="Description" htmlFor="file-task-description" className="sm:col-span-12">
          <Textarea id="file-task-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add a description" className="min-h-[72px]" />
        </Field>
        <Field label="Who can take it" htmlFor="file-task-who" error={errors.who} className="sm:col-span-8">
          <div className="flex min-w-0 items-center gap-2">
            <div role="group" aria-label="Who can take it" className="inline-flex flex-none rounded-md bg-muted p-0.5">
              {(["skill", "member"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={who === w}
                  onClick={() => setWho(w)}
                  className={cn("h-[26px] rounded-[6px] px-2.5 font-medium whitespace-nowrap text-muted-foreground", who === w && "bg-background text-foreground shadow-soft")}
                >
                  {w === "skill" ? "Skill" : "One Member"}
                </button>
              ))}
            </div>
            {who === "skill" ? (
              <Combobox
                id="file-task-who"
                value={skillId}
                onChange={setSkillId}
                options={skillList.map((s) => ({ value: s.id, label: s.name }))}
                placeholder="Choose a Skill"
                searchPlaceholder="Search Skills"
                empty="No Skill"
                icon={<SearchIcon />}
                invalid={!!errors.who}
              />
            ) : (
              <Combobox
                id="file-task-who"
                value={memberId}
                onChange={setMemberId}
                options={memberList
                  .filter((m) => !m.deactivated_at)
                  .map((m) => ({ value: m.id, label: m.name, icon: <MemberAvatar member={m} /> }))}
                placeholder="Choose a Member"
                searchPlaceholder="Search Members"
                empty="No Member"
                icon={<SearchIcon />}
                invalid={!!errors.who}
              />
            )}
          </div>
        </Field>
        <Field label="Status" htmlFor="file-task-status" className="sm:col-span-4">
          <StatusSelect id="file-task-status" statuses={statuses.data ?? []} value={chosenStatus} onValueChange={setStatusId} />
        </Field>
        <Field
          label={
            <>
              Blocks <span className="font-normal text-muted-foreground">optional</span>
            </>
          }
          htmlFor="file-task-blocks"
          className="sm:col-span-12"
        >
          <Combobox
            id="file-task-blocks"
            value={blocksKey}
            onChange={(v) => {
              setBlocksKey(v);
              // A Task that blocks another joins that Task's Feature.
              const blocked = tasks.data?.find((t) => t.key === v);
              const f = blocked && featureById.get(blocked.feature_id);
              if (f) setFeatureKey(f.key);
            }}
            options={blockable.map((t) => ({ value: t.key, label: t.title, keywords: [t.key], icon: <Key>{t.key}</Key> }))}
            placeholder="Choose a Task"
            searchPlaceholder="Search Tasks"
            empty="No open Task"
            icon={<LinkIcon />}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

/** F-F3: Team, Owner, Title, Description; the same write files its Break down Task. */
export function FileFeatureDialog({ team: presetTeam, onClose }: { team?: string; onClose: () => void }) {
  const me = useCurrentMe();
  const teams = useTeams().data ?? [];
  const { memberList } = useDirectory();
  const navigate = useNavigate();
  const [teamKey, setTeamKey] = useState<string | undefined>(presetTeam ?? me.teams[0]?.key);
  const [ownerId, setOwnerId] = useState<string | undefined>(me.member.id);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<{ team?: string; title?: string }>({});
  const chosenTeam = teams.find((t) => t.key === teamKey) ?? (presetTeam ? undefined : teams[0]);

  const file = useMutation({
    mutationFn: () =>
      call(
        api.POST("/v1/features", {
          body: { team: chosenTeam!.key, title: title.trim(), description: description.trim() || undefined, owner: ownerId },
        }),
      ),
    onSuccess: (filed) => {
      onClose();
      navigate(`/features/${encodeURIComponent(filed.feature.key)}`);
    },
  });

  const submit = () => {
    const next = { team: chosenTeam ? undefined : "Choose a Team.", title: title.trim() ? undefined : "Name the Feature." };
    setErrors(next);
    if (next.team || next.title) return;
    file.mutate();
  };

  const error = inWords(file.error, (code) =>
    code === "forbidden" && chosenTeam ? `Only Members of ${chosenTeam.name} file its Features; an admin can add you to ${chosenTeam.name}.` : undefined,
  );

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="File a Feature"
      submitLabel="File Feature"
      onSubmit={submit}
      pending={file.isPending}
      error={error}
      hint={
        <span className="flex items-center gap-2">
          <LayersIcon className="size-3.5" aria-hidden />
          Also files its Break down Task
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-x-3 gap-y-3.5 sm:grid-cols-12">
        <Field label="Team" htmlFor="file-feature-team" error={errors.team} className="sm:col-span-6">
          <Select value={chosenTeam?.key} onValueChange={setTeamKey}>
            <SelectTrigger id="file-feature-team" className="w-full" aria-invalid={!!errors.team || undefined}>
              <SelectValue placeholder="Choose a Team" />
            </SelectTrigger>
            <SelectContent>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.key}>
                  <TeamMark team={t} />
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Owner" htmlFor="file-feature-owner" className="sm:col-span-6">
          <Combobox
            id="file-feature-owner"
            value={ownerId}
            onChange={(v) => setOwnerId(v ?? me.member.id)}
            options={memberList
              .filter((m) => !m.deactivated_at)
              .map((m) => ({
                value: m.id,
                label: m.name,
                icon: <MemberAvatar member={m} />,
                detail: m.id === me.member.id ? <span className="text-muted-foreground">· you</span> : undefined,
              }))}
            placeholder="Choose a Member"
            searchPlaceholder="Search Members"
            empty="No Member"
          />
        </Field>
        <Field label="Title" htmlFor="file-feature-title" error={errors.title} className="sm:col-span-12">
          <Input
            id="file-feature-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Feature title"
            maxLength={200}
            aria-invalid={!!errors.title || undefined}
            className="h-9 text-[15px] font-medium"
          />
        </Field>
        <Field label="Description" htmlFor="file-feature-description" className="sm:col-span-12">
          <Textarea id="file-feature-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Add a description" className="min-h-24" />
        </Field>
      </div>
    </FormDialog>
  );
}
