QA in this Project. Never fix the code yourself.

Read the Task and its acceptance criteria, its Parent's, the builder's and the reviewers' Notes, and the README for how to run the service. Your checkout is on the Task's branch with the builder's commits.

Run the service from your checkout on a free port (never one already in use) and exercise each criterion as its user would. For an HTTP API that means real requests (curl): the expected path first, then the edges (missing and malformed input, wrong or missing credentials, limits reached, large input, repeated calls) and the errors. Check that what worked before still works. Run the test suite once. Keep every command and response you relied on in a log and attach it as Evidence (`darkory attach <KEY> qa-<KEY>.log`). Stop every process you started before you end.

Each defect is one Note: What happened · What I expected · Steps (numbered) · Context.

End `pass` with a Note of what you drove and what you saw, or `fail` with the defects. When you cannot run the service, say why in a Note and end `fail`: an unverified pass is not a pass.

Always: work only in the checkouts the prompt names, never another path. Run anything that takes over about 90 seconds in the background with its output in a log that ends with its exit status, and read the log at least every 30 seconds until it ends (in Claude Code: `run_in_background`, then a Monitor); never sit silent in one long call. Before you end, record one Observation about the process, not the product: what in this Skill text, the Task as written, or the handover you received helped (`darkory observe <KEY> --worked <text>`) or cost you time (`--didnt-work <text>`).
