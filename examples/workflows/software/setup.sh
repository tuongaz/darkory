#!/usr/bin/env bash
# Applies the software Workflow (docs/workflows/software.md) to an Install: its Skills, its
# agents with their tokens for the Runner, a Project on the Workflow with its Labels, and the
# Project's Workspace. Safe to run again: each step keeps what is already there, the Workflow
# keeps its Steps' ids, so Tasks in flight stay where they are, and the Project's other Workflows
# are left as they are.
#
# Needs DARKORY_URL and DARKORY_TOKEN (an admin's) and DATA (the Install's data directory, where
# the Runner reads <DATA>/agents/<agent>.token). Optional: PROJECT (key, default SW),
# PROJECT_NAME (default Software), REPO (a git repository to work in), WORKSPACE (its name,
# default the folder's), MODE (plain or pull_request, default plain), DARKORY (the binary).
set -euo pipefail
: "${DARKORY_URL:?}" "${DARKORY_TOKEN:?}" "${DATA:?}"
dk=${DARKORY:-darkory}
here=$(cd "$(dirname "$0")" && pwd)
project=${PROJECT:-SW}
project_name=${PROJECT_NAME:-Software}
mode=${MODE:-plain}
export DARKORY_NO_UPDATE_CHECK=1
command -v jq >/dev/null || { echo "setup.sh needs jq" >&2; exit 2; }

# The generic Skills each Step carries, then this Project's company Skill on each, whose text the
# Runner puts first in a session's prompt and a Retrospective may propose changes to.
skill() { # name kind [base]
  if $dk skill show "$1" >/dev/null 2>&1; then echo "skill $1: there"; return; fi
  if [ "$2" = company ]; then $dk skill create "$1" --kind company --base "$3" --file "$here/$1.md" >/dev/null
  else $dk skill create "$1" --kind generic --file "$here/$1.md" >/dev/null; fi
  echo "skill $1: created"
}
for s in triage architecture security qa devops; do skill "$s" generic; done
for s in triage architecture security qa devops engineer review breakdown acceptance retro; do
  skill "software-$s" company "$s"
done

if $dk project show "$project" >/dev/null 2>&1; then
  echo "project $project: there"
else
  $dk project create "$project" "$project_name" --workflow empty >/dev/null
  echo "project $project: created"
fi
$dk project set "$project" --acceptance=true --auto-complete=true >/dev/null

if [ -n "${REPO:-}" ]; then
  ws=${WORKSPACE:-$(basename "$REPO")}
  if $dk workspace list --json | jq -e --arg n "$ws" '.items[] | select(.name == $n)' >/dev/null; then
    $dk workspace set "$ws" --path "$REPO" --mode "$mode" >/dev/null
    echo "workspace $ws: there"
  else
    $dk workspace add "$ws" --path "$REPO" --mode "$mode" >/dev/null
    echo "workspace $ws: added"
  fi
  $dk project set "$project" --workspace "$ws" >/dev/null
fi

label() { # name colour
  if $dk label list --project "$project" --json | jq -e --arg n "$1" '.items[] | select(.name == $n)' >/dev/null; then
    echo "label $1: there"; return
  fi
  $dk label create "$1" --color "$2" --project "$project" >/dev/null
  echo "label $1: created"
}
label security '#d1242f'
label infra '#1f6feb'

# The agents: each a Member of the Project with its Skills, a Reporting line ("@owner" is the
# admin running this), the Runner's settings (Claude Code on the agent's model, unattended), and
# a token in DATA/agents that the Runner starts its sessions with. A token is never printed.
owner=$($dk me --json | jq -r '.member.name')
$dk project add "$project" "$owner" >/dev/null 2>&1 || true
mkdir -p "$DATA/agents"
jq -r '.agents[] | [.name, .model, .reports_to, (.skills | join(","))] | @tsv' "$here/agents.json" |
while IFS=$'\t' read -r name model manager skills; do
  if $dk member show "$name" >/dev/null 2>&1; then echo "agent $name: there"
  else $dk member create "$name" --kind agent >/dev/null; echo "agent $name: created"; fi
  $dk project add "$project" "$name" >/dev/null 2>&1 || true
  for s in $(echo "$skills" | tr ',' ' '); do $dk grant "$name" "$s" >/dev/null 2>&1 || true; done
  [ "$manager" = "@owner" ] && manager=$owner
  $dk report-to "$name" "$manager" >/dev/null
  $dk agent set "$name" --model "$model" --unattended >/dev/null
  if [ ! -s "$DATA/agents/$name.token" ]; then
    (umask 077; $dk token issue "$name" --name runner --timeout 5m --json | jq -r '.secret' > "$DATA/agents/$name.token")
  fi
done

# The Workflow, Software. The body is the Project's whole graph, and a Workflow left out of it is
# deleted with its Steps, so the preset owns Software alone and carries every other Workflow
# across untouched.
# - Software takes the id of the Workflow it becomes: the Project's only one (a Project made
#   empty, or from before Workflows were named, has one named Work); else the one named Software,
#   ignoring case; else the one holding a Step named Backlog or Triage; else none, and Software is
#   new. So a re-run never deletes and remakes it.
# - Software comes first, so its Backlog is where a Task filed without a Step starts; every other
#   Workflow follows in its order, with its id, its Steps (ids, places, Skills) and the Connectors
#   out of them, as they are. One of those leading into a Step of the old Software that the preset
#   does not have leads into Backlog instead, where that Step's Tasks go.
# - The preset's Steps keep the ids of the Steps of the same name, ignoring case, in the Workflow
#   it becomes; a Step of that name in another Workflow is not taken, and the set is refused as
#   two Steps sharing a name. Its other Steps are deleted, their open Tasks moved to Backlog.
# - The preset's Connectors replace those out of its Steps, except one leading into another
#   Workflow (such as bug → Bugs › Investigate), which is kept, after the preset's own.
current=$($dk workflow show "$project" --body)
jq --argjson cur "$current" '
  def lc: ascii_downcase;
  ([.steps[].name | lc]) as $ours
  | ($cur.workflows | sort_by(.position)) as $all
  | (if ($all | length) == 1 then $all[0]
     else (first($all[] | select(.name | lc == "software"))
           // first(["backlog", "triage"][] as $n | $cur.steps[] | select(.name | lc == $n) | .workflow as $w | $all[] | select(.name == $w))
           // null)
     end) as $old
  | ($old.name // null) as $oldName
  | [$cur.steps[] | select(.workflow == $oldName)] as $oldSteps
  | ($oldSteps | map({key: (.name | lc), value: .id}) | from_entries) as $ids
  | [$cur.steps[] | select(.workflow != $oldName)] as $keptSteps
  | ([$keptSteps[].name | lc]) as $kept
  | (.steps | map({key: (.name | lc), value: .name}) | from_entries) as $ourName
  | (reduce .connectors[] as $k ({}; .[$k.from | lc] += 1)) as $count
  | .workflows = [.workflows[0] + (if $old then {id: $old.id} else {} end) + {position: 1}]
      + [$all | map(select(.name != $oldName)) | to_entries[] | {id: .value.id, name: .value.name, position: (.key + 2)}]
  | .steps = (.steps | map(if $ids[.name | lc] then . + {id: $ids[.name | lc]} else . end)) + $keptSteps
  | .connectors += [$cur.connectors[] | select(.from | lc | IN($kept[]))
      | if .to and ((.to | lc | IN($ours[], $kept[])) | not) then .to = "Backlog" else . end]
  | .connectors as $preset
  | .connectors += [$cur.connectors
      | map(select((.from | lc | IN($ours[])) and .to and (.to | lc | IN($kept[])))
          | (.from | lc) as $f | select(.name | lc | IN($preset[] | select(.from | lc == $f) | .name | lc) | not))
      | group_by(.from | lc)[] | sort_by(.position) | to_entries[] | .key as $i | .value
      | (.from | lc) as $f | . + {from: $ourName[$f], position: (($count[$f] // 0) + $i + 1)}]
  | .moves = ([$oldSteps[] | select(.name | lc | IN($ours[]) | not) | {key: .id, value: "Backlog"}] | from_entries)
' "$here/workflow.json" | $dk workflow set "$project" --file - >/dev/null
$dk workflow show "$project"
