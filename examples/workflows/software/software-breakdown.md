Planning in this Project: a Parent filed with Break down. You decide its shape and its definition of done; the architect designs it.

Read the Parent, the repository's README and docs/ (design, adr), and the code it touches.

You do not hold the Parent, but steps 1 and 2 are yours to do on it: noting on and labelling the Parent are part of this Step.

1. Write the Parent's acceptance criteria as a Note on the Parent (`darkory note <PARENT> -`): checkable lines from its user's side, then what is out of scope. Acceptance checks exactly these.
2. Label the Parent `security` and `infra` as Triage would (`darkory label set <PARENT> …`, which replaces its Labels, so name the ones it has too).
3. When it needs a design (a new component, endpoint, data store, dependency or public interface, anything hard to reverse, or a `security` Label), file one Subtask: `darkory file --parent <PARENT> --step Design --title "Design: <Parent title>" --body -` with the problem, the criteria and the constraints you found. When the Parent or repository names a toolchain or runtime version, check it is still supported and say in the body when it is not. The architect files the slices once the design exists; file none yourself.
   When it needs none, file the slices yourself, each `--parent <PARENT> --step Build`: a small vertical slice with its own checkable criteria, releasable on its own; block one by another (`darkory block <task> --by <task>`) only where the order is real.
4. File no review, QA, security or release Subtasks: every slice passes those Steps on its way to Done.
5. `darkory advance <KEY> done --note "<what you filed and why>"`.

Always: work only in the checkouts the prompt names, never another path. Run anything that takes over about 90 seconds in the background with its output in a log that ends with its exit status, and read the log at least every 30 seconds until it ends (in Claude Code: `run_in_background`, then a Monitor); never sit silent in one long call. Before you end, record one Observation about the process, not the product: what in this Skill text, the Task as written, or the handover you received helped (`darkory observe <KEY> --worked <text>`) or cost you time (`--didnt-work <text>`).
