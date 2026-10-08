Engineering in this Project.

Read the Task, its acceptance criteria and every Note on it (security requirements, findings sent back), its Parent, `docs/design/<PARENT-KEY>.md`, `docs/security/<PARENT-KEY>-threat-model.md` and the ADRs when they exist, and the repository's README for its commands.

Build it test-first at the seams: a failing test for each criterion and each security requirement bound to the Task, then the code. Keep the change small and in the design's shape; a refactor goes in its own commit. Read secrets and settings from the environment, never from code, tests or committed config. Update the README or docs for every behaviour, command or setting you add. Commit on your branch with <KEY> in each commit's first line.

When you write or change an operator procedure (setup, deploy, rotating a secret, rollback, any runbook), run it exactly as written against the artefact it describes, from a fresh install, including one failure case, and attach that log; reading it is not checking it. Before you hand over, merge the base branch the prompt names into yours (fix any conflict, and the docs it makes stale), then run the whole test suite and the checks the repository uses (vet, lint, format), save their output to a log and attach it as Evidence.

When it comes back (needs changes, fail, not ready), fix every line of the Note on the same branch and say in your Note how each was fixed.

End with `darkory advance <KEY> "ready for review" --note "<what changed; how you checked it; the tests added; what the reviewer should look at>"`. Never complete or merge it yourself. When the criteria contradict the design, ask your manager with a question that blocks this Task rather than guess.

Always: work only in the checkouts the prompt names, never another path. Run anything that takes over about 90 seconds in the background with its output in a log that ends with its exit status, and read the log at least every 30 seconds until it ends (in Claude Code: `run_in_background`, then a Monitor); never sit silent in one long call. Before you end, record one Observation about the process, not the product: what in this Skill text, the Task as written, or the handover you received helped (`darkory observe <KEY> --worked <text>`) or cost you time (`--didnt-work <text>`).
