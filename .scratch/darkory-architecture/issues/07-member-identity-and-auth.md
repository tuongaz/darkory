# Member identity and auth across cloud and local

Type: grilling
Status: resolved
Blocked by: 03, 04

## Question

How does a Member prove who it is, and what is it then allowed to do?

Decide:

- How an agent Member is identified in a cloud sandbox and on a laptop.
- How a human Member signs in.
- How a Member is bound to a Team.
- Who can create a Member. Members are fully symmetric, so can an agent add another agent?
- Whether full symmetry leaves any need for permissions at all, and if so where they attach.

Constraint from [Agent interface: how agent Members talk to Darkory](06-agent-interface.md): an agent is configured with only `DARKORY_URL` and `DARKORY_TOKEN`, sent as an HTTP bearer credential; the token must work the same against Local and Cloud and be injectable as a sandbox secret.

Constraint from [Human surface: what human Members use](08-human-surface.md): humans sign in to a browser web app served by the same binary, which calls `/v1`, so browser auth must reach the same API agents use with tokens. Local bootstraps with `darkory init`, which prints the first Member's token and a login link; Cloud bootstraps through signup.

## Answer

ADR: [Members act through Sessions; one admin mark](../../../docs/adr/0008-members-act-through-sessions.md).

- **Sessions:** one Member, many Sessions. A running copy exchanges a Member token for a short-lived Session that renews while in use.
  - Claim with a heartbeat timeout → bound to its Session; only that Session writes.
  - Claim without a timeout → bound to the Member; any of its Sessions writes.
  - Revoking a token or closing its Session ends the Claims bound to it at once; Activity records it.
- **Agents:** always a Member token (`dk_…`), several per Member, named, revocable, stored hashed.
- **Humans:** one-time login code or link, emailed on Cloud, plus GitHub and Google sign-in; SSO later through the same pluggable sign-in. Browser cookie maps to a Session.
  - Local on `localhost`: no login, the browser is the one human Member.
  - Local exposed beyond `localhost`: link printed by `darkory login`.
- **Authority:** domain relations (Claim holder, Feature owner, Team membership) plus one admin mark any Member can carry. Admins create Members, Teams, Skills, Reporting lines and tokens; an admin agent may add agents. `darkory init` makes the first human an admin.
- **Teams:** admins add Members to Teams; a token carries all its Member's Teams. Every Member reads the whole Organisation; takes and shapes work only in its own Teams; may file Tasks for any Team.

**Revised 2026-10-05 by [Independent architecture review](13-independent-architecture-review.md):**

- **Sessions.** A Session is an id the running copy chooses and sends with the token on every request. There is no exchange and no short-lived credential. A token may carry a default heartbeat timeout.
- **Humans.** `darkory serve` prints and opens a one-time link at start. A request with no credential is never a Member, on `localhost` too. Whether the link is printed, emailed, or replaced by GitHub or Google sign-in is a setting of the Install.
- **Teams.** A named relation (a Task aimed at the Member, Feature ownership, a Reporting line) outranks the limit to one's own Teams.
