import { Link } from "react-router";
import { useMemberSessions, useTokens } from "@/api/queries";
import { MemberAvatar } from "@/components/MemberAvatar";
import { PageHeader } from "@/components/PageHeader";
import { Pill } from "@/components/Pill";
import { ProjectMark } from "@/components/ProjectMark";
import { Loaded } from "@/components/Refusal";
import { shellQuote } from "@/lib/shell";
import { useCurrentMe } from "@/me";
import { taskPath } from "@/screens/task/format";
import { TokenRows } from "./credentials";
import { SettingsFrame } from "./frame";
import { heldClaims, liveTokens } from "./model";
import { SettingsForm, SettingsRow } from "./parts";
import { SessionsTable } from "./SessionsTable";
import { useHeldTasks } from "./queries";
import { memberPath } from "./paths";

/**
 * Settings › Account: who the signed-in Member is, and what can sign in as them: their
 * tokens, their Sessions with this browser marked (Log out on its row), and the CLI line for
 * another browser. An admin changes the facts on the Member's page under Organisation.
 */
export function AccountPage() {
  const me = useCurrentMe();
  const m = me.member;
  const tokens = useTokens(m.id);
  const sessions = useMemberSessions(m.id);
  const held = heldClaims(useHeldTasks(m.id).data ?? []);
  return (
    <SettingsFrame crumbs={[{ label: "Account" }]}>
      <div className="max-w-[820px]">
        <PageHeader
          title={m.name}
          mark={<MemberAvatar member={m} size="lg" />}
          meta={
            <>
              <span>{me.organisation.name}</span>
              {m.kind === "agent" ? <Pill tone="agent">Agent</Pill> : <Pill>Human</Pill>}
              {m.admin && <Pill>Admin</Pill>}
            </>
          }
          actions={
            m.admin && (
              <Link to={memberPath(m)} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                Change in Members
              </Link>
            )
          }
        />
        <SettingsForm label="Profile">
          <SettingsRow label="Name">{m.name}</SettingsRow>
          <SettingsRow label="Email">{m.email ?? <span className="text-muted-foreground">None set</span>}</SettingsRow>
          <SettingsRow label="Projects" count={me.projects.length}>
            {me.projects.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              me.projects.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <ProjectMark project={p} />
                  {p.name}
                </span>
              ))
            )}
          </SettingsRow>
          <SettingsRow label="Skills" count={me.skills.length}>
            {me.skills.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              me.skills.map((s) => (
                <Pill key={s.id} tone="outline">
                  {s.name}
                </Pill>
              ))
            )}
          </SettingsRow>
          <SettingsRow label="Tokens" count={tokens.data ? liveTokens(tokens.data).length : undefined}>
            <Loaded query={tokens}>{(list) => <TokenRows tokens={liveTokens(list)} sessions={sessions.data?.items ?? []} held={held} />}</Loaded>
          </SettingsRow>
          <SettingsRow label="Sessions" count={sessions.data?.open}>
            <Loaded query={sessions}>
              {(list) => <SessionsTable member={m} sessions={list} held={held} taskTo={taskPath} self current={me.session.id} canClose />}
            </Loaded>
          </SettingsRow>
          <SettingsRow label="CLI">
            <span className="text-muted-foreground">Sign in another browser:</span>
            <code className="max-w-full truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
              darkory login {shellQuote(m.name)}
            </code>
          </SettingsRow>
        </SettingsForm>
      </div>
    </SettingsFrame>
  );
}
