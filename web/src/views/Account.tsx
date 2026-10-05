import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, call } from "../api/client";
import { TokenList } from "../components/tokens";
import { Badge, Refusal, Time } from "../components/ui";
import { MemberName } from "../components/work";
import { useCurrentMe } from "../me";

/** The signed-in Member: who they are, this browser's Session, and their own tokens and Sessions. */
export function Account() {
  const me = useCurrentMe();
  const { member, session } = me;
  return (
    <>
      <h1>My account</h1>
      <dl className="facts">
        <dt>Name</dt>
        <dd>
          {member.name} <Badge>{member.kind}</Badge> {member.admin && <Badge tone="admin">admin</Badge>}
        </dd>
        {member.email && (
          <>
            <dt>Email</dt>
            <dd>{member.email}</dd>
          </>
        )}
        <dt>Reports to</dt>
        <dd>{member.manager_id ? <MemberName id={member.manager_id} /> : "No one"}</dd>
        <dt>Teams</dt>
        <dd>{me.teams.length ? me.teams.map((t) => `${t.name} (${t.key})`).join(", ") : "None"}</dd>
        <dt>Skills</dt>
        <dd>{me.skills.length ? me.skills.map((s) => s.name).join(", ") : "None"}</dd>
      </dl>

      <section aria-labelledby="session-heading" className="panel">
        <h2 id="session-heading">This browser</h2>
        <p>
          Session <code>{session.id}</code>, signed in <Time at={session.started_at} />. Signing out closes it.
        </p>
      </section>

      <section aria-labelledby="my-tokens" className="panel">
        <h2 id="my-tokens">My tokens</h2>
        <p className="muted">
          Revoking a token closes its Sessions and ends the Claims bound to them. Only an admin issues tokens.
        </p>
        <TokenList member={member} />
      </section>

      <CloseSession current={session.id} />
    </>
  );
}

/**
 * Closes one of the caller's Sessions by the id its running copy chose, as shown on its Claims.
 * The API closes Sessions but does not list them, so the id is typed.
 */
function CloseSession({ current }: { current: string }) {
  const [id, setId] = useState("");
  const close = useMutation({
    mutationFn: (session: string) => call(api.POST("/v1/sessions/{session}/close", { params: { path: { session } } })),
    onSuccess: () => setId(""),
  });
  return (
    <section aria-labelledby="close-session" className="panel">
      <h2 id="close-session">Close a Session</h2>
      <p className="muted">
        Ends the Claims bound to one of your Sessions, such as a CLI or agent run you stopped. Closing{" "}
        <code>{current}</code> signs this browser out.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          close.mutate(id);
        }}
      >
        <label>
          Session id
          <input required value={id} onChange={(e) => setId(e.target.value.trim())} />
        </label>
        <button type="submit" className="danger" disabled={!id || close.isPending}>
          Close Session
        </button>
      </form>
      <Refusal error={close.error} />
      {close.isSuccess && (
        <p role="status">
          Closed Session <code>{close.data.session.id}</code>; {close.data.claims_ended} Claim
          {close.data.claims_ended === 1 ? "" : "s"} ended.
        </p>
      )}
    </section>
  );
}
