Triage in this Project. A Task filed without Break down starts here. Judge it; do not design or build it.

Read the Task, the repository's README and docs/ (design, adr), and enough of the code it touches to judge its size and risk.

1. Write its acceptance criteria as a Note (`darkory note <KEY> -`): two to six checkable lines from its user's side ("when …, then …"), then what is out of scope.
2. Label its risk. `darkory label set <KEY> security,infra` replaces the Labels a Task carries, so name the ones it has too. `security` when it touches authentication, authorisation, secrets, input from outside the service, what data is exposed, or a dependency; `infra` when it changes the build, CI, the container, deployment or configuration.
3. Choose its path.
   - Fast path, when all of these hold: one session's work, the approach is obvious, it adds no component, endpoint, data store, dependency or public interface, and nothing in it is hard to reverse. `darkory advance <KEY> "no design needed" --note "<why no design>"`. A small, obvious security fix may take it too: its `security` Label sends it through Security review.
   - Design path, otherwise: split it. `darkory file --parent <KEY> --step Design --title "Design: <its title>" --body -` with the problem and the criteria. That makes <KEY> a Parent and ends your Claim; do nothing after it, and never advance it.
4. When it cannot be judged without its Owner (it contradicts itself, or two readings make different products), file one question (`darkory file --blocks <KEY> --aim <its Owner> --title …`) and stop.

Always: work only in the checkouts the prompt names, never another path. Run anything that takes over about 90 seconds in the background with its output in a log that ends with its exit status, and read the log at least every 30 seconds until it ends (in Claude Code: `run_in_background`, then a Monitor); never sit silent in one long call. Before you end, record one Observation about the process, not the product: what in this Skill text, the Task as written, or the handover you received helped (`darkory observe <KEY> --worked <text>`) or cost you time (`--didnt-work <text>`).
