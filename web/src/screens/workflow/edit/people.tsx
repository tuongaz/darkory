import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { IssuedToken, Member, Project, Skill } from "@/api/client";
import { invalidateAll } from "@/api/queries";
import { addProjectMember, createMember, grantSkill, issueToken, setAgentSettings } from "@/api/writes";
import { FormDialog, FormRow, FormRows } from "@/components/FormDialog";
import { Refusal } from "@/components/Refusal";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { defaultModel, knownModels } from "@/screens/settings/agent";
import { firstTokenName } from "@/screens/settings/model";
import { OnceDialog, TokenShown } from "@/screens/settings/secrets";
import { orgWide } from "./holders";

/*
 * New agent, from a Step's Taken by: it makes a Member at once, with a token whose secret shows
 * once, so it is not part of what Save sends.
 */


type Made = { member?: Member; token?: IssuedToken; done: string[]; failed?: { what: string; error: unknown }; runner?: string };

/**
 * New agent: a name, the Step's Skill, and whether the Runner starts its Shifts and on
 * which model. /v1 makes it in steps — the Member, its place in the Project, its Skill, its first
 * token, its Runner settings — and what refuses says which, beside what was made. The token's
 * secret shows once, with how the agent runs.
 */
export function CreateAgentDialog({ project, skill, onClose }: { project: Project; skill: Skill; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [runner, setRunner] = useState(true);
  const [model, setModel] = useState(defaultModel);
  const make = useMutation({
    mutationFn: async (): Promise<Made> => {
      const made: Made = { done: [] };
      const step = async (what: string, run: () => Promise<unknown>) => {
        if (made.failed) return;
        try {
          await run();
          made.done.push(what);
        } catch (error) {
          made.failed = { what, error };
        }
      };
      made.member = await createMember({ name: name.trim(), kind: "agent" });
      const id = made.member.id;
      if (!orgWide(skill)) await step(`added to ${project.name}`, () => addProjectMember(project.key, id));
      await step(`given ${skill.name}`, () => grantSkill(id, skill.id));
      if (!made.failed) {
        try {
          made.token = await issueToken(id, { name: firstTokenName });
        } catch (error) {
          made.failed = { what: "issued its token", error };
        }
      }
      if (runner) {
        const m = model.trim() || defaultModel;
        await step("set up for the Runner", () => setAgentSettings(id, { model: m }));
        if (!made.failed) made.runner = `The Runner starts its Shifts on this Install, on ${m}.`;
      } else made.runner = "The Runner does not start it: it works through this token.";
      return made;
    },
    onSettled: () => invalidateAll(qc),
  });

  const made = make.data;
  if (made?.member) {
    return (
      <OnceDialog open onDone={onClose} title={`${made.member.name} is ready`}>
        <p className="text-muted-foreground">
          Created{made.done.length > 0 && `, ${made.done.join(", ")}`}.
        </p>
        {made.failed && (
          <div className="flex flex-col gap-1">
            <p>Not {made.failed.what}:</p>
            <Refusal error={made.failed.error} />
          </div>
        )}
        {made.token && <TokenShown issued={made.token} label={`Secret of ${made.member.name}'s token`} />}
        {made.runner && <p className="text-muted-foreground">{made.runner}</p>}
      </OnceDialog>
    );
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New agent"
      description={`An agent Member of ${project.name} with ${skill.name}.`}
      submitLabel="Create agent"
      onSubmit={() => make.mutate()}
      pending={make.isPending}
      submitDisabled={!name.trim()}
      error={make.error}
    >
      <FormRows>
        <FormRow label="Name" htmlFor="agent-name">
          <Input id="agent-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormRow>
        <FormRow label="Skill">
          <span className="font-mono text-xs">{skill.name}</span>
        </FormRow>
        <FormRow label="Runner" info="On, the Runner starts its Shifts with the Install's default command; off, it works through its own token.">
          <Switch checked={runner} onCheckedChange={setRunner} aria-label="Run with the Runner" className="self-start" />
        </FormRow>
        {runner && (
          <FormRow label="Model" htmlFor="agent-model">
            <Input
              id="agent-model"
              list="agent-models"
              maxLength={200}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="font-mono text-xs md:text-xs"
            />
            <datalist id="agent-models">
              {knownModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </FormRow>
        )}
      </FormRows>
    </FormDialog>
  );
}
