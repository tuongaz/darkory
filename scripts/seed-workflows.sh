#!/usr/bin/env bash
# Seeds a running Install with a Project of five Workflows (ADR 0019), for the Named Workflows
# proof and its screenshots:
#
#   Project "Accounting" (ACC):
#     Triage      Triage (triage)
#     Bugs        Investigate (engineer) · Fix (engineer) · Review (review) · Verify (qa)
#     Features    Build (engineer) · Code review (review) · QA (qa) · Release (devops)
#     Prototypes  Sketch (design) · Prototype review (review)
#     Support     Support (support) · Awaiting customer (a hold) · Ops (ops) · Approve (finance)
#   Triage's outcomes bug, feature, prototype and question lead into the first Step of Bugs,
#   Features, Prototypes and Support; Support's exception leads to Approve.
#
#   Six Tasks, filed only while the Project has none: three at Triage, two at Support, one at
#   Sketch. The admin triages the first along bug and the second along feature, and sends the
#   refund along exception to Approve; then kai, a human engineer, takes the bug at Investigate and
#   advances it along fix, so one Bugs Task waits at Fix. kai does that step because a Member who
#   has held a Task under one Skill takes it again only under that Skill: the admin triaged it.
#
# Run it with the CLI on PATH (or DARKORY_BIN), against an Install whose server runs with
# --runner=off:
#
#   DARKORY_URL=http://127.0.0.1:7788 DARKORY_TOKEN=dk_... scripts/seed-workflows.sh
#
# DARKORY_TOKEN is an admin's (a fresh `darkory init` prints one). Optional: PROJECT (key, default
# ACC), PROJECT_NAME (default Accounting), DARKORY_BIN (the binary; default darkory on PATH, else
# `go run ./cmd/darkory` from this checkout). It creates Skills, the Member kai and a Project, so
# never point it at a real Install. Safe to run again: the Workflows keep their ids and their
# Steps', so a re-run writes no workflow.changed, and the Tasks are filed only into an empty
# Project. Any other Workflow of the Project is carried across as it is.
set -euo pipefail
: "${DARKORY_URL:?set DARKORY_URL to the address of the Install}"
: "${DARKORY_TOKEN:?set DARKORY_TOKEN to the token of an admin}"
project=${PROJECT:-ACC}
project_name=${PROJECT_NAME:-Accounting}
export DARKORY_NO_UPDATE_CHECK=1
export DARKORY_SESSION=${DARKORY_SESSION:-seed-workflows-admin}
command -v jq >/dev/null || { echo "seed-workflows.sh needs jq" >&2; exit 2; }

root=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "${DARKORY_BIN:-}" ]; then dk=("$DARKORY_BIN")
elif command -v darkory >/dev/null; then dk=("$(command -v darkory)")
else dk=(go run -C "$root" ./cmd/darkory)
fi
darkory() { "${dk[@]}" "$@"; }

say() { printf '· %s\n' "$*" >&2; }

admin=$(darkory me --json | jq -r '.member.name')
say "seeding $DARKORY_URL as $admin"

# ------------------------------------------------------------------ the Project and kai
if darkory project show "$project" >/dev/null 2>&1; then
  say "project $project: there"
else
  darkory project create "$project" "$project_name" --workflow empty >/dev/null
  say "project $project: created"
fi
if darkory member show kai >/dev/null 2>&1; then say "member kai: there"
else darkory member create kai --kind human >/dev/null; say "member kai: created"; fi

# ------------------------------------------------------------------ the Workflows
# The body is the Project's whole graph. The five Workflows come first, in this order; the
# Project's other Workflows follow as they are, with their Steps and the Connectors out of them,
# except the one a Project made empty starts with (Work, holding Backlog alone), which the five
# replace, its Tasks moved to Triage. Each
# Workflow and Step keeps the id of the one of the same name, ignoring case, and a Step its place
# on the canvas, so a re-run changes nothing. Skills already there are not created again; the
# admin and kai join the Project, the admin holds every Skill the Workflows carry, kai engineer.
want='{
  "workflows": [
    {"name": "Triage"}, {"name": "Bugs"}, {"name": "Features"}, {"name": "Prototypes"}, {"name": "Support"}
  ],
  "steps": [
    {"workflow": "Triage", "name": "Triage", "skill": "triage"},
    {"workflow": "Bugs", "name": "Investigate", "skill": "engineer"},
    {"workflow": "Bugs", "name": "Fix", "skill": "engineer"},
    {"workflow": "Bugs", "name": "Review", "skill": "review"},
    {"workflow": "Bugs", "name": "Verify", "skill": "qa"},
    {"workflow": "Features", "name": "Build", "skill": "engineer"},
    {"workflow": "Features", "name": "Code review", "skill": "review"},
    {"workflow": "Features", "name": "QA", "skill": "qa"},
    {"workflow": "Features", "name": "Release", "skill": "devops"},
    {"workflow": "Prototypes", "name": "Sketch", "skill": "design"},
    {"workflow": "Prototypes", "name": "Prototype review", "skill": "review"},
    {"workflow": "Support", "name": "Support", "skill": "support"},
    {"workflow": "Support", "name": "Awaiting customer"},
    {"workflow": "Support", "name": "Ops", "skill": "ops"},
    {"workflow": "Support", "name": "Approve", "skill": "finance"}
  ],
  "connectors": [
    {"from": "Triage", "to": "Investigate", "name": "bug"},
    {"from": "Triage", "to": "Build", "name": "feature"},
    {"from": "Triage", "to": "Sketch", "name": "prototype"},
    {"from": "Triage", "to": "Support", "name": "question"},
    {"from": "Investigate", "to": "Fix", "name": "fix"},
    {"from": "Fix", "to": "Review", "name": "ready"},
    {"from": "Review", "to": "Verify", "name": "pass"},
    {"from": "Review", "to": "Fix", "name": "needs changes"},
    {"from": "Verify", "name": "pass"},
    {"from": "Verify", "to": "Fix", "name": "fail"},
    {"from": "Build", "to": "Code review", "name": "ready for review"},
    {"from": "Code review", "to": "QA", "name": "pass"},
    {"from": "Code review", "to": "Build", "name": "needs changes"},
    {"from": "QA", "to": "Release", "name": "pass"},
    {"from": "QA", "to": "Build", "name": "fail"},
    {"from": "Release", "name": "released"},
    {"from": "Sketch", "to": "Prototype review", "name": "ready"},
    {"from": "Prototype review", "name": "approved"},
    {"from": "Prototype review", "to": "Sketch", "name": "redesign"},
    {"from": "Support", "name": "answered"},
    {"from": "Support", "to": "Awaiting customer", "name": "waiting on the customer"},
    {"from": "Support", "to": "Ops", "name": "account change"},
    {"from": "Support", "to": "Approve", "name": "exception"},
    {"from": "Ops", "to": "Support", "name": "done"},
    {"from": "Approve", "to": "Ops", "name": "approved"},
    {"from": "Approve", "to": "Support", "name": "declined"}
  ]
}'
current=$(darkory workflow show "$project" --body)
existing=$(darkory skill list --json | jq -c '[.items[].name]')
body=$(jq -c --argjson cur "$current" --argjson have "$existing" --arg admin "$admin" '
  def lc: ascii_downcase;
  ([.workflows[].name | lc]) as $ours
  | ($cur.workflows | map({key: (.name | lc), value: .id}) | from_entries) as $wids
  | ($cur.steps | map({key: (.name | lc), value: {id, x, y}}) | from_entries) as $sids
  | [$cur.workflows[] | .name as $w | select([$cur.steps[] | select(.workflow == $w) | .name] == ["Backlog"])
      | .name] as $starters
  | [$cur.workflows | sort_by(.position)[]
      | select((.name | lc | IN($ours[]) | not) and (.name | IN($starters[]) | not))] as $others
  | ([$others[].name]) as $otherNames
  | [$cur.steps[] | select(.workflow | IN($otherNames[]))] as $otherSteps
  | ([$otherSteps[].name]) as $otherStepNames
  | ([.steps[].skill // empty] | unique) as $skills
  | .workflows = ([.workflows[] | . + (if $wids[.name | lc] then {id: $wids[.name | lc]} else {} end)] + $others
      | to_entries | map(.value + {position: (.key + 1)}))
  | .steps = ([.steps[] | . + ($sids[.name | lc] // {})] + $otherSteps)
  | .connectors += [$cur.connectors[] | select(.from | IN($otherStepNames[]))]
  | .moves = ([$cur.steps[] | select(.workflow | IN($starters[])) | {key: .id, value: "Triage"}] | from_entries)
  | .skills = [$skills[] | select(IN($have[]) | not)
      | {name: ., body: ("Work a Task at a Step carrying " + . + ".")}]
  | .joins = [$admin, "kai"]
  | .grants = ([$skills[] | {member: $admin, skill: .}] + [{member: "kai", skill: "engineer"}])
' <<<"$want")
before=$(darkory activity --project "$project" --kind workflow.changed --all --json | jq '.items | length')
printf '%s' "$body" | darkory workflow set "$project" --file - >/dev/null
after=$(darkory activity --project "$project" --kind workflow.changed --all --json | jq '.items | length')
if [ "$after" = "$before" ]; then say "workflows: unchanged"; else say "workflows: set"; fi

# ------------------------------------------------------------------ the Tasks
count=$(darkory tasks --project "$project" --json | jq '.items | length')
if [ "$count" -gt 0 ]; then
  say "tasks: $project has $count, none filed"
else
  file() { darkory file --project "$project" --json "$@" | jq -r '.task.key'; }
  totals=$(file --title "Totals round twice on multi-currency invoices")
  xero=$(file --title "Export to Xero")
  file --title "Dark mode for the ledger" >/dev/null
  file --title "Client asks how to void an invoice" --step Support >/dev/null
  refund=$(file --title "Refund for duplicate payment" --step Support)
  file --title "Prototype: new onboarding" --step Sketch >/dev/null

  darkory claim "$totals" >/dev/null
  darkory advance "$totals" bug >/dev/null
  darkory claim "$xero" >/dev/null
  darkory advance "$xero" feature >/dev/null
  darkory claim "$refund" >/dev/null
  darkory advance "$refund" exception >/dev/null

  # kai works the bug at Investigate, in a Session of its own; the token is made here alone, so a
  # re-run issues none.
  kai=$(darkory token issue kai --name seed-workflows --json | jq -r '.secret')
  DARKORY_TOKEN=$kai DARKORY_SESSION=seed-workflows-kai darkory claim "$totals" >/dev/null
  DARKORY_TOKEN=$kai DARKORY_SESSION=seed-workflows-kai darkory advance "$totals" fix >/dev/null
  say "tasks: $totals at Fix, $xero at Build, $refund at Approve; three more at Triage, Support and Sketch"
fi

darkory workflow show "$project"
