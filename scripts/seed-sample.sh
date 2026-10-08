#!/usr/bin/env bash
# Seeds a running Install with the Workflow line's sample data (mock-workflow/fixture.md and the
# deps round's additions), as closely as /v1 allows, for screenshots and demos:
#
#   Project "Sample" (SAM): Backlog · Plan · Build · QA · Review · Acceptance · Retro · Skill review
#   with the fixture's Connectors; agents planner, builder, qa, reviewer and retro (retro paused);
#   a done Parent "Saved cards at checkout" whose Retrospective waits at Retro; the Parent "Emoji
#   reactions on support messages" with its Breakdown done and Subtasks at Build, QA and Review; the
#   standalone Tasks; the question aimed at the admin; the Blockings (a chain of three and a Task
#   blocked by two); every Claim and advance made with the agent's own token and Session, so the
#   Activity trail and each Task's time at its Step tell the fixture's story, "now"-relative.
#
#   Project "Big" (BIG): the heavy 12-Step / 7-loop Workflow with 24 open Tasks, 6 of them held and
#   9 Blockings (a 4-long chain and one Task blocked by two).
#
# Point it at an Install whose server runs with --runner=off, so no session starts for the agents:
#
#   DARKORY_URL=http://127.0.0.1:7788 DARKORY_TOKEN=dk_... scripts/seed-sample.sh
#
# DARKORY_TOKEN is an admin's (a fresh `darkory init` prints one). Never point it at a real Install:
# it creates Members, Skills and two Projects. It is not idempotent; run it once per Install.
set -euo pipefail

: "${DARKORY_URL:?set DARKORY_URL to the Install's address}"
: "${DARKORY_TOKEN:?set DARKORY_TOKEN to an admin's token}"
URL="${DARKORY_URL%/}"
ADMIN="$DARKORY_TOKEN"
PAUSE="${SEED_PAUSE:-1}" # seconds between the story's moves, so their times differ

# api METHOD PATH [BODY] [TOKEN] [SESSION]: one /v1 call; prints the response, fails loudly.
api() {
  local method=$1 path=$2 body=${3:-} token=${4:-$ADMIN} session=${5:-seed-admin}
  local args=(-sS -X "$method" "$URL$path" -H "Authorization: Bearer $token" -H "Darkory-Session: $session" -H "Idempotency-Key: seed-$RANDOM-$RANDOM-$(date +%s%N)")
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" --data "$body")
  local out code
  out=$(curl "${args[@]}" -w $'\n%{http_code}')
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [[ $code -ge 400 ]]; then
    echo "seed: $method $path -> $code: $out" >&2
    exit 1
  fi
  printf '%s' "$out"
}

say() { printf '· %s\n' "$*" >&2; }
step() { sleep "$PAUSE"; }

me=$(api GET /v1/me | jq -r .member.name)
say "seeding $URL as $me"

# ------------------------------------------------------------------ Skills
have_skill() { api GET /v1/skills | jq -e --arg n "$1" '.items[] | select(.name == $n)' >/dev/null; }
for s in engineer qa review triage design security docs release; do
  have_skill "$s" || { api POST /v1/skills "$(jq -nc --arg n "$s" '{name: $n, kind: "generic", body: ("Work a Task at a Step carrying " + $n + ".")}')" >/dev/null && say "Skill $s"; }
done

# ------------------------------------------------------------------ Agents
member_id() { api GET /v1/members | jq -r --arg n "$1" '.items[] | select(.name == $n) | .id'; }
agent() {
  local name=$1 model=$2 paused=$3
  shift 3
  local id
  id=$(member_id "$name")
  if [[ -z "$id" ]]; then
    id=$(api POST /v1/members "$(jq -nc --arg n "$name" '{name: $n, kind: "agent"}')" | jq -r '.member.id // .id')
    say "agent $name"
  fi
  api PATCH "/v1/members/$id/agent" "$(jq -nc --arg m "$model" --argjson p "$paused" '{model: $m, paused: $p}')" >/dev/null
  for s in "$@"; do api PUT "/v1/members/$id/skills/$s" >/dev/null; done
  echo "$id"
}
planner=$(agent planner claude-opus-5-5 false breakdown)
builder=$(agent builder claude-sonnet-5-5 false engineer)
qa=$(agent qa claude-sonnet-5-5 false qa acceptance)
reviewer=$(agent reviewer claude-opus-5-5 false review skill-review)
retro=$(agent retro claude-opus-5-5 true retro)
admin=$(member_id "$me")

token() { api POST "/v1/members/$1/tokens" '{"name":"seed-sample"}' | jq -r .secret; }
T_PL=$(token "$planner")
T_BU=$(token "$builder")
T_QA=$(token "$qa")
T_RV=$(token "$reviewer")

# as AGENT TOKEN SESSION METHOD PATH [BODY]: a move made by an agent, in its own Session.
as() { local tok=$1 ses=$2 method=$3 path=$4 body=${5:-}; api "$method" "$path" "$body" "$tok" "$ses"; }
claim() { as "$1" "$2" POST "/v1/tasks/$3/claim" '{"heartbeat_timeout_seconds":0}' >/dev/null; step; }
advance() { as "$1" "$2" POST "/v1/tasks/$3/advance" "$(jq -nc --arg o "$4" '{outcome: $o}')" >/dev/null; step; }
key() { jq -r '.task.key'; }
file() { api POST /v1/tasks "$1" | key; }

# ------------------------------------------------------------------ Sample
say "Project Sample"
api POST /v1/projects "$(jq -nc --arg a "$admin" --arg p "$planner" --arg b "$builder" --arg q "$qa" --arg r "$reviewer" --arg t "$retro" \
  '{key: "SAM", name: "Sample", workflow: "empty", acceptance: true, members: [$a, $p, $b, $q, $r, $t]}')" >/dev/null
api PUT /v1/projects/SAM/workflow '{
  "steps": [
    {"name": "Backlog", "position": 1},
    {"name": "Plan", "skill": "breakdown", "position": 2},
    {"name": "Build", "skill": "engineer", "position": 3},
    {"name": "QA", "skill": "qa", "position": 4},
    {"name": "Review", "skill": "review", "position": 5},
    {"name": "Acceptance", "skill": "acceptance", "position": 6},
    {"name": "Retro", "skill": "retro", "position": 7},
    {"name": "Skill review", "skill": "skill-review", "position": 8}
  ],
  "connectors": [
    {"from": "Plan", "name": "done", "position": 1},
    {"from": "Build", "to": "QA", "name": "pass", "position": 1},
    {"from": "Build", "to": "Review", "name": "no UI change", "position": 2},
    {"from": "QA", "to": "Review", "name": "pass", "position": 1},
    {"from": "QA", "to": "Build", "name": "fail", "position": 2},
    {"from": "Review", "name": "pass", "position": 1},
    {"from": "Review", "to": "Build", "name": "needs changes", "position": 2},
    {"from": "Review", "to": "QA", "name": "needs QA", "position": 3},
    {"from": "Acceptance", "name": "pass", "position": 1},
    {"from": "Acceptance", "to": "Build", "name": "fail", "position": 2},
    {"from": "Retro", "name": "done", "position": 1},
    {"from": "Retro", "to": "Skill review", "name": "propose", "position": 2},
    {"from": "Skill review", "name": "publish", "position": 1},
    {"from": "Skill review", "to": "Retro", "name": "needs changes", "position": 2}
  ]
}' >/dev/null

# Yesterday's Parent, done: its one Subtask worked through, then it completes itself and Darkory
# files its Retrospective at Retro, where it waits (retro is paused).
cards=$(file '{"project":"SAM","title":"Saved cards at checkout","auto_complete":true,"acceptance":false}')
vault=$(file "$(jq -nc --arg p "$cards" '{parent: $p, title: "Card vault client", step: "Build"}')")
claim "$T_BU" builder-1 "$vault"; advance "$T_BU" builder-1 "$vault" pass
claim "$T_QA" qa-1 "$vault"; advance "$T_QA" qa-1 "$vault" pass
claim "$T_RV" reviewer-1 "$vault"; advance "$T_RV" reviewer-1 "$vault" pass
say "$cards done; its Retrospective waits at Retro"

# The standalone Tasks.
abn=$(file '{"project":"SAM","title":"Invoice PDF shows the wrong ABN","step":"Build"}')
claim "$T_BU" builder-2 "$abn"; advance "$T_BU" builder-2 "$abn" "no UI change"
claim "$T_RV" reviewer-2 "$abn"
export_slow=$(file '{"project":"SAM","title":"Coordinator export times out","step":"Build"}')
accents=$(file '{"project":"SAM","title":"Participant search ignores accents"}')

# The Parent, broken down by planner, its Subtasks filed at Build.
emoji=$(file '{"project":"SAM","title":"Emoji reactions on support messages","breakdown":true,"auto_complete":true,"acceptance":true}')
breakdown=$(api GET "/v1/tasks/$emoji" | jq -r '.subtasks[] | select(.kind == "breakdown") | .key')
# The Subtasks are filed before the Breakdown ends: a Parent whose last open Subtask ends Done gets
# its Acceptance filed then, which would come too early here.
claim "$T_PL" planner-1 "$breakdown"
sub() { as "$T_PL" planner-1 POST /v1/tasks "$(jq -nc --arg p "$emoji" --arg t "$1" '{parent: $p, title: $t, step: "Build"}')" | key; }
picker=$(sub "Reaction picker on a message")
counts=$(sub "Show reaction counts")
notify=$(sub "Notify the author of a reaction")
remove=$(sub "Admin can remove a reaction")
advance "$T_PL" planner-1 "$breakdown" done

# builder asks the admin a question that blocks the export.
question=$(as "$T_BU" builder-3 POST /v1/tasks "$(jq -nc --arg b "$export_slow" --arg a "$me" '{title: "Which export format do coordinators use?", aim: $a, blocks: $b}')" | key)
step

# The morning's moves: MAIN-12 through QA to Review, MAIN-9 to QA where qa picks it up.
claim "$T_BU" builder-4 "$remove"; advance "$T_BU" builder-4 "$remove" pass
claim "$T_QA" qa-2 "$remove"
claim "$T_BU" builder-5 "$picker"; advance "$T_BU" builder-5 "$picker" pass
advance "$T_QA" qa-2 "$remove" pass
claim "$T_QA" qa-3 "$picker"

# The deps round's additions and the Blockings.
analytics=$(sub "Reaction analytics")
exportr=$(file '{"project":"SAM","title":"Export reactions","step":"Build"}')
block() { api PUT "/v1/tasks/$1/blockers/$2" >/dev/null; }
block "$notify" "$counts"
block "$analytics" "$notify"
block "$exportr" "$remove"
block "$exportr" "$export_slow"

# The moment the line was drawn for: builder picks up the counts.
step
claim "$T_BU" builder-6 "$counts"
say "Sample: $emoji ($picker $counts $notify $remove $analytics), $abn $export_slow $accents $question $exportr"

# ------------------------------------------------------------------ Big
say "Project Big"
# Big's Tasks are held by mai, a human Member of Big alone who holds its Skills, so Sample's Steps
# keep their own takers.
mai=$(member_id mai)
[[ -n "$mai" ]] || mai=$(api POST /v1/members '{"name":"mai","kind":"human"}' | jq -r '.member.id // .id')
for s in triage breakdown design engineer review qa security docs acceptance release retro; do api PUT "/v1/members/$mai/skills/$s" >/dev/null; done
T_MAI=$(token "$mai")
api POST /v1/projects "$(jq -nc --arg a "$admin" --arg m "$mai" '{key: "BIG", name: "Big", workflow: "empty", acceptance: true, members: [$a, $m]}')" >/dev/null
api PUT /v1/projects/BIG/workflow "$(jq -nc '
  ["Backlog","Triage","Plan","Design","Build","Code review","QA","Security review","Docs","Acceptance","Release","Retro"] as $names |
  ["",       "triage","breakdown","design","engineer","review","qa","security","docs","acceptance","release","retro"] as $skills |
  {
    steps: [range(0; 12) | {name: $names[.], position: (. + 1)} + (if $skills[.] == "" then {} else {skill: $skills[.]} end)],
    connectors: (
      [range(0; 11) | {from: $names[.], to: $names[. + 1], name: "pass", position: 1}] +
      [{from: "Retro", name: "pass", position: 1},
       {from: "Plan", to: "Build", name: "no design needed", position: 2},
       {from: "Design", to: "Plan", name: "rework", position: 2},
       {from: "Code review", to: "Build", name: "needs changes", position: 2},
       {from: "QA", to: "Build", name: "fail", position: 2},
       {from: "Security review", to: "Build", name: "fail", position: 2},
       {from: "Docs", to: "Build", name: "needs changes", position: 2},
       {from: "Acceptance", to: "Build", name: "fail", position: 2},
       {from: "Release", to: "QA", name: "rollback", position: 2}]
    )
  }')" >/dev/null

# 24 Tasks over the Steps as F8 spreads them; the first at six busy Steps is held by mai.
declare -a big
spread=("Backlog:3" "Triage:2" "Plan:1" "Design:2" "Build:6" "Code review:2" "QA:3" "Security review:1" "Docs:1" "Acceptance:1" "Release:1" "Retro:1")
n=0
for entry in "${spread[@]}"; do
  at=${entry%%:*}
  count=${entry##*:}
  for ((i = 0; i < count; i++)); do
    n=$((n + 1))
    big[$n]=$(file "$(jq -nc --arg s "$at" --arg t "Big Task $n" '{project: "BIG", title: $t, step: $s}')")
  done
done
for n in 4 6 7 9 15 17; do api POST "/v1/tasks/${big[$n]}/claim" '{"heartbeat_timeout_seconds":0}' "$T_MAI" "mai-big-$n" >/dev/null; done
# 9 Blockings: BIG-7 → 10 → 12 → 19 (a 4-long chain), 14 by 9 and 13, and four pairs.
for pair in "10:7" "12:10" "19:12" "11:9" "14:9" "14:13" "16:15" "22:21" "24:23"; do block "${big[${pair%%:*}]}" "${big[${pair##*:}]}"; done
say "Big: 24 Tasks, 6 held, 9 Blockings"
say "done"
