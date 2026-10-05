# Members act through Sessions; one admin mark

A Member is an identity, not a process. Each running copy of a Member opens a **Session** by exchanging one of the Member's long-lived tokens (named, revocable, stored hashed, prefixed `dk_`) for a short-lived Session that renews while in use. A Claim made with a heartbeat timeout is bound to its Session, so only that Session can write to the Task and a crashed or zombie sibling cannot. A Claim without a timeout is bound to the Member, so a human who signs in again keeps their work. Revoking a token, or closing its Session, ends the Claims bound to it at once, and Activity records it. Binding follows the Claim's timeout, not whether the Member is human, so Members stay symmetric.

Humans sign in with a one-time login code or link (emailed on Cloud, alongside GitHub and Google sign-in); the browser holds a cookie that maps to a Session, and `/v1` accepts the cookie or a bearer token alike. Local on `localhost` needs no login: the browser is the one human Member. Exposed beyond `localhost`, it requires a link printed by `darkory login`. Agents always use tokens, on Local too.

Authority comes from domain relations (Claim holder, Feature owner, Team membership) plus one **admin** mark that any Member, human or agent, may carry: admins create Members, Teams and Skills, set Reporting lines, and issue tokens. Within an Organisation every Member reads everything; taking and shaping work is limited to one's own Teams, though filing a Task for another Team is allowed.

## Considered Options

- **One Member per running copy.** Simple, but the org chart fills with throwaway Members.
- **One Member, Sessions ignored.** Copies of one Member trample each other's Claims.
- **Email and password, or OIDC only.** Heavy on a single binary, or breaks zero setup.
- **No admin, human-only admin, or full role-based access.** Respectively unsafe, asymmetric, or more than the MVP needs.
- **Private Teams.** Cross-Team Blocking and escalations would point at unseen work.
- **Claims survive revocation until timeout.** A revoked agent's work stays stuck.
