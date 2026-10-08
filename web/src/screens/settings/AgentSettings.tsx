import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError, type AgentSettings, type Member } from "@/api/client";
import type { components } from "@/api/schema.gen";
import { clearAgentSettings, setAgentSettings } from "@/api/writes";
import { InfoPopover } from "@/components/InfoPopover";
import { SectionHeader } from "@/components/PageHeader";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { argsOf, argsText, envOf, envText, knownModels, placeholders } from "./agent";
import { count } from "./model";
import { ConfirmDialog, Fact, Facts, MoreMenu, SettingsForm, SettingsRow, w320 } from "./parts";

type Body = components["schemas"]["SetAgentSettingsBody"];

/**
 * An agent's Agent card: how the Runner starts its sessions. Each field saves on its own when it
 * is left, and sends only itself (PATCH /v1/members/{member}/agent keeps the rest). An agent
 * with no settings works from elsewhere through its own token until an admin hands it to the
 * Runner; Stop using the Runner, behind ⋯, clears them again.
 */
export function AgentCard({ member }: { member: Member }) {
  const s = member.agent;
  const [stopping, setStopping] = useState(false);
  return (
    <section aria-label="Agent" className="mt-8 flex flex-col gap-2">
      <SectionHeader
        title="Agent"
        actions={
          s && (
            <MoreMenu label={`More for the Agent settings of ${member.name}`} size="icon-xs">
              <DropdownMenuItem variant="destructive" onSelect={() => setStopping(true)}>
                Stop using the Runner
              </DropdownMenuItem>
            </MoreMenu>
          )
        }
      />
      {s ? <AgentForm member={member} settings={s} /> : <NotRun member={member} />}
      {s && stopping && <StopRunnerDialog member={member} settings={s} onClose={() => setStopping(false)} />}
    </section>
  );
}

/** Asks before clearing an agent's settings, and says what goes with them. */
function StopRunnerDialog({ member, settings: s, onClose }: { member: Member; settings: AgentSettings; onClose: () => void }) {
  const stop = useMutation({ mutationFn: () => clearAgentSettings(member.id), onSuccess: onClose });
  const vars = Object.keys(s.env).length;
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Stop using the Runner for ${member.name}?`}
      confirmLabel="Stop using the Runner"
      onConfirm={() => stop.mutate()}
      pending={stop.isPending}
      error={stop.error}
    >
      <Facts>
        <Fact label="Clears">
          <code className="font-mono text-[11.5px] font-normal">{s.command}</code>
          {count(s.args.length, "argument")}
          <code className="font-mono text-[11.5px] font-normal">{s.model}</code>
          {vars > 0 && count(vars, "variable")}
        </Fact>
        <Fact label="Then">
          <span className="font-normal">
            The Runner starts no new session for {member.name}, which works through its own tokens; one running carries on until its Claim
            ends.
          </span>
        </Fact>
      </Facts>
    </ConfirmDialog>
  );
}

function NotRun({ member }: { member: Member }) {
  // Settings start from the Install's defaults: Claude Code on the default model.
  const start = useMutation({ mutationFn: () => setAgentSettings(member.id, {}) });
  return (
    <SettingsForm label={`Agent settings of ${member.name}`}>
      <SettingsRow label="Runner">
        <span className="text-muted-foreground">Works through its own token; the Runner does not start it.</span>
        <Button variant="outline" size="xs" onClick={() => start.mutate()} disabled={start.isPending}>
          Use the Runner
        </Button>
        <Refusal error={start.error} />
      </SettingsRow>
    </SettingsForm>
  );
}

function AgentForm({ member, settings: s }: { member: Member; settings: AgentSettings }) {
  // Each row is keyed by its saved value, so a change made elsewhere replaces what the field shows.
  return (
    <SettingsForm label={`Agent settings of ${member.name}`}>
      <TextSetting
        key={`command:${s.command}`}
        member={member}
        id="agent-command"
        label="Command"
        saved={s.command}
        required
        body={(command) => ({ command })}
        help={<Placeholders />}
      />
      <LinesSetting
        key={`args:${argsText(s.args)}`}
        member={member}
        id="agent-args"
        label="Arguments"
        saved={argsText(s.args)}
        parse={(text) => ({ body: { args: argsOf(text) }, same: argsText(argsOf(text)) === argsText(s.args) })}
        help="One per line, in order."
      />
      <TextSetting
        key={`model:${s.model}`}
        member={member}
        id="agent-model"
        label="Model"
        saved={s.model}
        required
        list="agent-models"
        body={(model) => ({ model })}
        help="Passed as {model}, and reported as the Claim's model label."
      />
      <datalist id="agent-models">
        {knownModels.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <LinesSetting
        key={`env:${envText(s.env)}`}
        member={member}
        id="agent-env"
        label="Environment"
        saved={envText(s.env)}
        placeholder="KEY = value"
        parse={(text) => {
          const r = envOf(text);
          return "problem" in r ? r : { body: { env: r.env }, same: envText(r.env) === envText(s.env) };
        }}
        help="One KEY = value per line. Every Member can read these: keep secrets in the server's environment, which sessions inherit."
      />
      <TextSetting
        key={`progress:${s.progress_file ?? ""}`}
        member={member}
        id="agent-progress"
        label="Progress file"
        saved={s.progress_file ?? ""}
        placeholder="Claude Code's transcript"
        body={(progress_file) => ({ progress_file })}
        help="For a command other than Claude Code: the file whose changes show the session working."
      />
      <SwitchSetting
        member={member}
        id="agent-paused"
        label="Paused"
        checked={s.paused}
        body={(paused) => ({ paused })}
        help="The Runner starts no new session; one running carries on."
      />
      <SwitchSetting
        member={member}
        id="agent-unattended"
        label="Unattended"
        checked={s.unattended}
        body={(unattended) => ({ unattended })}
        help="Skips the agent's permission checks; its worktree and the exit rules are the fence."
      />
    </SettingsForm>
  );
}

/** The placeholders a template may use, under the Command field; ⓘ says what each becomes. */
function Placeholders() {
  return (
    <span className="flex flex-wrap items-center gap-1">
      Placeholders
      {placeholders.map(([p]) => (
        <code key={p} className="rounded-sm bg-muted px-1 font-mono text-[11.5px] text-foreground">
          {p}
        </code>
      ))}
      <InfoPopover label="About the placeholders" className="w-[340px]">
        <p className="mb-1.5">The Runner replaces these in the command, each argument and the progress file:</p>
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-1">
          {placeholders.map(([p, what]) => (
            <div key={p} className="contents">
              <dt className="font-mono text-[11.5px]">{p}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </InfoPopover>
    </span>
  );
}

/** A one-line setting: saved when the field is left or on Enter, put back on Esc. */
function TextSetting({
  member,
  id,
  label,
  saved,
  required,
  list,
  placeholder,
  body,
  help,
}: {
  member: Member;
  id: string;
  label: string;
  saved: string;
  required?: boolean;
  list?: string;
  placeholder?: string;
  body: (value: string) => Body;
  help?: ReactNode;
}) {
  const [value, setValue] = useState(saved);
  const save = useMutation({ mutationFn: (v: string) => setAgentSettings(member.id, body(v)) });
  const commit = () => {
    const next = value.trim();
    if ((required && !next) || next === saved) return setValue(saved);
    save.mutate(next);
  };
  return (
    <SettingsRow label={label} htmlFor={id} help={help}>
      <Input
        id={id}
        className={cn(w320, "font-mono text-xs md:text-xs")}
        maxLength={1000}
        list={list}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setValue(saved);
        }}
      />
      <Refusal error={save.error} />
    </SettingsRow>
  );
}

type Parsed = { body: Body; same: boolean } | { problem: string };

/** A setting of several lines: saved when the field is left; what /v1 would refuse is said before sending. */
function LinesSetting({
  member,
  id,
  label,
  saved,
  placeholder,
  parse,
  help,
}: {
  member: Member;
  id: string;
  label: string;
  saved: string;
  placeholder?: string;
  parse: (text: string) => Parsed;
  help?: ReactNode;
}) {
  const [value, setValue] = useState(saved);
  const [problem, setProblem] = useState<string>();
  const save = useMutation({ mutationFn: (b: Body) => setAgentSettings(member.id, b) });
  const commit = () => {
    const r = parse(value);
    if ("problem" in r) return setProblem(r.problem);
    setProblem(undefined);
    if (!r.same) save.mutate(r.body);
  };
  return (
    <SettingsRow label={label} htmlFor={id} help={help}>
      <Textarea
        id={id}
        className={cn(w320, "min-h-9 py-1.5 font-mono text-xs md:text-xs")}
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        aria-invalid={!!problem || undefined}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setValue(saved);
            setProblem(undefined);
          }
        }}
      />
      <Refusal error={problem ? new ApiError(0, "invalid", problem) : save.error} />
    </SettingsRow>
  );
}

function SwitchSetting({
  member,
  id,
  label,
  checked,
  body,
  help,
}: {
  member: Member;
  id: string;
  label: string;
  checked: boolean;
  body: (on: boolean) => Body;
  help: ReactNode;
}) {
  const save = useMutation({ mutationFn: (on: boolean) => setAgentSettings(member.id, body(on)) });
  return (
    <SettingsRow label={label} htmlFor={id} help={help}>
      <Switch id={id} checked={save.isPending ? save.variables : checked} onCheckedChange={(on) => save.mutate(on)} disabled={save.isPending} />
      <Refusal error={save.error} />
    </SettingsRow>
  );
}
