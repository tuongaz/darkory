import { Content, TopBar } from "@/app/TopBar";
import { MemberAvatar } from "@/components/MemberAvatar";
import { PageHeader } from "@/components/PageHeader";
import { Loaded } from "@/components/Refusal";
import { useCurrentMe } from "@/me";
import { SessionRows, TokenRows } from "./credentials";
import { heldClaims, liveTokens } from "./model";
import { SettingsForm, SettingsRow } from "./parts";
import { useHeldTasks, useSessions, useTokens } from "./queries";

/**
 * /account (F-D7): who the signed-in Member is, and what can sign in as them: their tokens, their
 * Sessions with this browser marked, and the CLI line for another browser. An admin changes the
 * facts on the Member's Admin page.
 */
export function AccountPage() {
  const me = useCurrentMe();
  const m = me.member;
  const tokens = useTokens(m.id);
  const sessions = useSessions(m.id);
  const held = heldClaims(useHeldTasks(m.id).data ?? []);
  return (
    <>
      <TopBar crumbs={[{ label: "Account" }]} />
      <Content pad>
        <div className="max-w-[820px]">
          <PageHeader title={m.name} mark={<MemberAvatar member={m} size="lg" />} meta={me.organisation.name} />
          <SettingsForm label="Account">
            <SettingsRow label="Email">{m.email ?? <span className="text-muted-foreground">None set</span>}</SettingsRow>
            <SettingsRow label="Kind">{m.kind === "agent" ? "Agent" : "Human"}</SettingsRow>
            <SettingsRow label="Admin">{m.admin ? "Yes" : "No"}</SettingsRow>
            <SettingsRow label="Tokens" count={tokens.data ? liveTokens(tokens.data).length : undefined}>
              <Loaded query={tokens}>{(list) => <TokenRows tokens={liveTokens(list)} sessions={sessions.data ?? []} held={held} />}</Loaded>
            </SettingsRow>
            <SettingsRow label="Sessions" count={sessions.data?.length}>
              <Loaded query={sessions}>{(list) => <SessionRows member={m} sessions={list} held={held} current={me.session.id} />}</Loaded>
            </SettingsRow>
            <SettingsRow label="CLI">
              <span className="text-muted-foreground">Sign in another browser:</span>
              <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">darkory login {/^[\w.@-]+$/.test(m.name) ? m.name : `"${m.name}"`}</code>
            </SettingsRow>
          </SettingsForm>
        </div>
      </Content>
    </>
  );
}
