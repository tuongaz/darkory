# Build decisions

Defaults taken while building, where the ADRs leave a detail open. One line each: the decision, then why. Add to the end; never rewrite a line, strike it and add a new one.

- **Session header is `Darkory-Session`.** A bearer request without it is refused with `session_required`; the browser's Session lives in its cookie. Why: ADR 0008 says every request carries a Session id.
- **Times are Unix milliseconds and ids are UUIDv7 text on both engines.** Why: one schema to compare, and no timezone or UUID-type differences between SQLite and Postgres.
- **Display keys share one counter per Team across Features and Tasks** (`WEB-1` a Feature, `WEB-2` a Task). Why: one counter row to allocate under the write order, and keys stay unique within a Team.
- **Rank is an integer position per Team, renumbered on a move.** Why: Teams hold few Features, and an integer compares across Teams for `next`.
- **The built-in Skills `breakdown`, `retro` and `skill-review` are created by `darkory init`** and cannot be deleted. Why: Darkory files Tasks needing the first two, and ADR 0010 names the third.
- **Completing a skill-review Task whose proposal has a stale base is refused with `proposal_stale` and changes nothing;** the reviewer hands the Task back to `retro`. Why: a refused request should not write, and Handover already sends work back.
- **A Task aimed at a Member by name needs no Skill**, and its Claim row records none. Why: ADR 0001 aims a question at a Skill or at a Member.
- **Adding a blocker to a Task needs its Claim, its Feature's ownership, or membership of its Feature's Team.** Why: an escalating Member holds the Task they block; owners and the Team shape their own work.
- **Feature ownership passes by the owner or by someone on the owner's Reporting line.** Why: ticket 03 says "passable by the owner or taken back up the Reporting line".
- **Signing a release uses an ed25519 key over `checksums.txt`, with the public key compiled into the binary.** Why: no external signing service is needed to verify on `darkory update`.
- **GitHub and Google sign-in are not built in the MVP.** Why: printed and emailed links cover Local and a first Cloud; the sign-in setting leaves room for them.
