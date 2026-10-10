import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError, type AgentSettings, type Member } from "@/api/client";
import { useRunnerSessions } from "@/api/queries";
import type { components } from "@/api/schema.gen";
import { clearAgentSettings, setAgentSettings } from "@/api/writes";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { argsOf, argsText, envOf, envText, knownModels, placeholders, runnerNow } from "./agent";
import { count } from "./model";
import { ConfirmDialog, Fact, Facts, MoreMenu, SettingsForm, SettingsRow, SettingsSection, w320 } from "./parts";

type Body = components["schemas"]["SetAgentSettingsBody"];

/**
 * An agent's Agent card: how the Runner starts its sessions, the Runner row first saying what the
 * Runner is. Each field saves on its own when it is left, and sends only itself
 * (PATCH /v1/members/{member}/agent keeps the rest). An agent with no settings works from
 * elsewhere through its own token until an admin hands it to the Runner; Stop using the Runner,
 * behind ⋯, clears them again. Paused is in the page's last card (`PausedRow`), with Deactivate.
 */
export function AgentCard({ member }: { member: Member }) {
  const s = member.agent;
  const [stopping, setStopping] = useState(false);
  return (
    <SettingsSection
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
    >
      {s ? <AgentForm member={member} settings={s} /> : <NotRun member={member} />}
      {s && stopping && <StopRunnerDialog member={member} settings={s} onClose={() => setStopping(false)} />}
    </SettingsSection>
  );
}

/** What the Runner does for this agent, from the Runner row's ⓘ. */
const aboutRunner = (
  <p>
    In use, the Runner beside this server starts the agent&apos;s command whenever it has a Task to take: it takes the Task through{" "}
    <code className="font-mono text-[11.5px]">next</code> as this agent, prepares its Workspace, and ends the Shift when the Claim ends. Not in
    use, the agent works through its own token.
  </p>
);

/** Paused, for an agent the Runner starts: no new session until it is switched off. */
export function PausedRow({ member, settings: s }: { member: Member; settings: AgentSettings }) {
  return (
    <SwitchSetting
      member={member}
      id="agent-paused"
      label="Paused"
      checked={s.paused}
      body={(paused) => ({ paused })}
      info="The Runner starts no new Shift; one running carries on."
    />
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
            The Runner starts no new Shift for {member.name}, which works through its own tokens; one running carries on until its Claim
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
      <SettingsRow label="Runner" info={aboutRunner}>
        <span className="text-muted-foreground">Not in use</span>
        <Button variant="outline" size="xs" onClick={() => start.mutate()} disabled={start.isPending}>
          Use the Runner
        </Button>
        <Refusal error={start.error} />
      </SettingsRow>
    </SettingsForm>
  );
}

function AgentForm({ member, settings: s }: { member: Member; settings: AgentSettings }) {
  const sessions = useRunnerSessions().data;
  const now = runnerNow({ runner: sessions?.runner, session: sessions?.items.find((x) => x.member_id === member.id), paused: s.paused });
  // Each row is keyed by its saved value, so a change made elsewhere replaces what the field shows.
  return (
    <SettingsForm label={`Agent settings of ${member.name}`}>
      <SettingsRow label="Runner" info={aboutRunner} help={now}>
        <span>In use</span>
      </SettingsRow>
      <TextSetting
        key={`command:${s.command}`}
        member={member}
        id="agent-command"
        label="Command"
        saved={s.command}
        required
        body={(command) => ({ command })}
        info={<Placeholders />}
      />
      <LinesSetting
        key={`args:${argsText(s.args)}`}
        member={member}
        id="agent-args"
        label="Arguments"
        saved={argsText(s.args)}
        parse={(text) => ({ body: { args: argsOf(text) }, same: argsText(argsOf(text)) === argsText(s.args) })}
        info="One per line, in order."
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
        info="Passed as {model}, and reported as the Claim's model label."
      />
      <datalist id="agent-models">
        {knownModels.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <ShiftsSetting key={`shifts:${s.shifts}`} member={member} saved={s.shifts} />
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
        info="One KEY = value per line. Shifts also inherit the server's environment."
        help="Every Member can read these: keep secrets in the server's environment."
      />
      <TextSetting
        key={`progress:${s.progress_file ?? ""}`}
        member={member}
        id="agent-progress"
        label="Progress file"
        saved={s.progress_file ?? ""}
        placeholder="Claude Code's transcript"
        body={(progress_file) => ({ progress_file })}
        info="For a command other than Claude Code: the file whose changes show the Shift working."
      />
      <SwitchSetting
        member={member}
        id="agent-unattended"
        label="Unattended"
        checked={s.unattended}
        body={(unattended) => ({ unattended })}
        info="Skips the agent's permission checks; its worktree and the exit rules are the fence."
      />
    </SettingsForm>
  );
}

/** The placeholders a template may use, from the Command field's ⓘ: what each becomes. */
function Placeholders() {
  return (
    <>
      <p className="mb-1.5">The Runner replaces these in the command, each argument and the progress file:</p>
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-1">
        {placeholders.map(([p, what]) => (
          <div key={p} className="contents">
            <dt className="font-mono text-[11.5px]">{p}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </>
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
  info,
}: {
  member: Member;
  id: string;
  label: string;
  saved: string;
  required?: boolean;
  list?: string;
  placeholder?: string;
  body: (value: string) => Body;
  info?: ReactNode;
}) {
  const [value, setValue] = useState(saved);
  const save = useMutation({ mutationFn: (v: string) => setAgentSettings(member.id, body(v)) });
  const commit = () => {
    const next = value.trim();
    if ((required && !next) || next === saved) return setValue(saved);
    save.mutate(next);
  };
  return (
    <SettingsRow label={label} htmlFor={id} info={info}>
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

/** The most Shifts the Runner runs for one agent at once (`AgentSettings.shifts`). */
const maxShifts = 8;

/** How many Shifts the Runner runs for the agent at once: saved when left or on Enter; out of 1..8 it is put back. */
function ShiftsSetting({ member, saved }: { member: Member; saved: number }) {
  const [value, setValue] = useState(String(saved));
  const save = useMutation({ mutationFn: (shifts: number) => setAgentSettings(member.id, { shifts }) });
  const commit = () => {
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n < 1 || n > maxShifts || n === saved) return setValue(String(saved));
    save.mutate(n);
  };
  return (
    <SettingsRow label="Shifts" htmlFor="agent-shifts" info="Each Shift runs in its own Session and holds its own Claim.">
      <Input
        id="agent-shifts"
        type="number"
        inputMode="numeric"
        min={1}
        max={maxShifts}
        step={1}
        className="w-16 flex-none font-mono text-xs tabular-nums md:text-xs"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setValue(String(saved));
        }}
      />
      <span className="text-muted-foreground">at once</span>
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
  info,
  help,
}: {
  member: Member;
  id: string;
  label: string;
  saved: string;
  placeholder?: string;
  parse: (text: string) => Parsed;
  info?: ReactNode;
  /** A warning the field keeps in sight. */
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
    <SettingsRow label={label} htmlFor={id} info={info} help={help}>
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
  info,
}: {
  member: Member;
  id: string;
  label: string;
  checked: boolean;
  body: (on: boolean) => Body;
  info: ReactNode;
}) {
  const save = useMutation({ mutationFn: (on: boolean) => setAgentSettings(member.id, body(on)) });
  return (
    <SettingsRow label={label} htmlFor={id} info={info}>
      <Switch id={id} checked={save.isPending ? save.variables : checked} onCheckedChange={(on) => save.mutate(on)} disabled={save.isPending} />
      <Refusal error={save.error} />
    </SettingsRow>
  );
}
