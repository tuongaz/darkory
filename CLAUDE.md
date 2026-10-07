# Working on Darkory

## The standard

**Never weigh implementation cost.** Time and effort are unlimited; the job is world-class
software. When choosing between designs, choose the one that is right for the product and its
users, never the one that is quicker to build. Do not present cost as a reason to prefer an
option, do not estimate effort to steer a decision, and do not soften a design to save work.
(Said by the owner on 2026-10-07 after a recommendation that favoured a half-day change over the
better model.)

What still counts: correctness, the invariants in `docs/adr/`, the glossary in `CONTEXT.md`
(its words are the only words on screen), spec-first (`api/openapi.yaml`, then `make gen`), and
every phase ending green on both engines (`make check`, `make web-check`, `make e2e`, `make e2e-pg`).

## Standing rules

- `main` receives merges only; work in a worktree under `/Users/tuongaz/dev/darkory-wt/`. The
  owner's `make dev` runs from the main checkout.
- Never commit binaries: never `go build` at a checkout's root, never `git add -A` blindly.
- Decisions go in `docs/build/decisions.md`, one line each with the reason; model changes that are
  hard to reverse get an ADR.
- Agent sessions run with the user's own Claude Code configuration, never a separate config
  folder, so Local links straight to existing checkouts.
