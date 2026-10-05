import { useMutation, useQuery } from "@tanstack/react-query";
import { api, call, type Member } from "../api/client";
import { keys } from "../api/queries";
import { ConfirmButton, Loaded, Refusal, Time } from "./ui";

/**
 * A Member's tokens, newest first, each with a button to revoke it. Secrets are never shown here.
 * A Member may list and revoke their own; an admin anyone's.
 */
export function TokenList({ member }: { member: Pick<Member, "id"> }) {
  const tokens = useQuery({
    queryKey: keys.tokens(member.id),
    queryFn: () => call(api.GET("/v1/members/{member}/tokens", { params: { path: { member: member.id } } })).then((r) => r.items),
  });
  const revoke = useMutation({
    mutationFn: (token: string) => call(api.POST("/v1/tokens/{token}/revoke", { params: { path: { token } } })),
  });
  return (
    <>
      <Loaded query={tokens}>
        {(list) =>
          list.length === 0 ? (
            <p className="muted">No tokens.</p>
          ) : (
            <ul className="list" aria-label="Tokens">
              {list.map((t) => (
                <li key={t.id} className={t.revoked_at ? "ended" : undefined}>
                  <div className="grow">
                    {t.name} <code>{t.prefix}…</code>
                    <div className="meta">
                      issued <Time at={t.created_at} />
                      {t.default_heartbeat_timeout_seconds !== undefined && (
                        <> · Heartbeat timeout {t.default_heartbeat_timeout_seconds}s by default</>
                      )}
                      {t.last_used_at && (
                        <>
                          {" "}
                          · last used <Time at={t.last_used_at} />
                        </>
                      )}
                      {t.revoked_at && (
                        <>
                          {" "}
                          · revoked <Time at={t.revoked_at} />
                        </>
                      )}
                    </div>
                  </div>
                  {!t.revoked_at && (
                    <ConfirmButton
                      label={`Revoke token ${t.name}`}
                      confirm={`Revoke ${t.name} and end its Sessions' Claims`}
                      onConfirm={() => revoke.mutate(t.id)}
                      disabled={revoke.isPending}
                    >
                      Revoke
                    </ConfirmButton>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <Refusal error={revoke.error} />
    </>
  );
}
