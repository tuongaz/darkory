# The Workflow page, vertical — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task, a fresh subagent per task and a code review after each.

**Goal:** The Workflow page as the owner approved it on 2026-10-10: the line runs top to bottom from **Start** at every width; a Step shows who holds its Tasks and one count for the rest; loops come back as drawn lines; one light "Also starts here" group beside the start; words behind ⓘ. The final design: https://claude.ai/artifact/ChuJwMBtgszFR6ZZNAyiQc (ten frames vf-1 … vf-10; the frame is the spec). The evidence board (five directions, a stranger test, the owner's rulings D1–D9): https://claude.ai/artifact/ED9nUYciAqKaPN7ABEWPoH.

**Mockup sources (read these, they are the spec):** `/private/tmp/claude-501/-Users-tuongaz-dev-darkory/066e879e-2e98-43de-93f7-a295eb3f5238/scratchpad/wf-round/` — `dir-e/vf-1.png` … `vf-10.png` (one PNG per frame), `dir-e/frag-vfinal.html` + `dir-e/vfinal.css` (the drawn HTML, its exact words and sizes), `fixture.json` (every figure in the frames: Projects DARK (g1, g2, busy), NEWS, ACME; Members; clock), `brief.md` (the model's hard truths and the copy rules), `tokens.css` (the app's own tokens, transcribed).

**Architecture:** Web only in this PR; nothing changes in `api/openapi.yaml` or in Go. `WorkflowLine` (`web/src/components/workflowLine/`) keeps its props and data (`useLineData`, `data.ts`, `model.ts`, `words.ts`, `lineTopology`) and draws vertically at every width: `Vertical.tsx` evolves to the final composition and `Horizontal.tsx` retires. The Workflows list page draws each Workflow as its own vertical line. The editor keeps its draft model (`edit/draft.ts`, `edits.ts`, `bind.ts`, `describeChanges`) and gets a new rendering on the line in place of Preview · Step list · Step panel. The seed change (a new Project starts with Implementation · Bug triage · Retrospective, decision D1) is a SEPARATE PR on its own branch, opened and left for the owner's word; nothing in this PR depends on it, because the owner's Install has Projects on today's seed and on the 8-Step sacca shape.

**Tech stack:** React 19, react-router 7, TanStack Query, Tailwind 4 + shadcn kit, inline SVG for the rail and tracks, Vitest + Testing Library (jsdom), Playwright against the real binary (`cd web && npm run e2e`) and against `vite dev` with route mocks (`npm run lab`).

**Worktree:** `/Users/tuongaz/dev/darkory-wt/workflow-vertical`, branch `workflow-vertical` from main 23f137b. `web/node_modules` is installed. Work only there; `main` receives the merge at the end.

**Standing rules (CLAUDE.md and memory):** never weigh implementation cost; the glossary's words (`CONTEXT.md`) are the only words on screen; terse UI (one word where one will do, the sentence behind an ⓘ or a hover; hover never moves or resizes anything); never `go build` at a checkout root without `-o`, never `git add -A`; commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; decisions go in `docs/build/decisions.md`, one line each with the reason; when the build departs from a vf frame, log it in `.claude/skills/mockup/SKILL.md` (Corrections log, at the main checkout `/Users/tuongaz/dev/darkory/.claude/skills/mockup/SKILL.md`, the file is untracked) the moment it is decided, and say it in the task's report.

**How to run things (from the worktree):**
- One test file: `cd web && npx vitest run src/components/workflowLine/vertical.test.tsx`
- All web checks: `cd web && npm run typecheck && npm run lint && npm test` (= `make web-check` at the repo root)
- Playwright, one spec: `cd web && npm run build && npx playwright test e2e/workflow.spec.ts` (screenshots land in `web/e2e/screenshots/`, git-ignored)
- Playwright labs (vite dev + mocks, screenshots for a person): `cd web && npm run lab -- e2e/workflow.lab.ts`
- Go: `make check` (gen-check, vet, test, test-pg), `make e2e`, `make e2e-pg`

---

## The final design, in words (what each task builds to)

- **The line (vf-1, vf-2, vf-3, vf-6).** One rail down the card's left, 21px in. The entry is a filled 18px station at the top with **Start** in bold beside the ↓ above it (hover: `New Tasks start at Build, unless the filer names another Step`, from `words.ts`'s `entryHint`); a crossing in is a small chip beside Start (`Bug triage · feature ↙`, the shipped entry chip's words). Each Step is a row: name · Skill tag (`⌖ engineer`, the tag glyph and the mono name; hover "the Skill a Member needs to take Tasks here") · the median as a bare `6m` (hover "median time a Task spends here") · the takers as avatars (names on hover; agents ringed). Between two stations the rail carries the outcome's name and an arrowhead into the next station. A return is a drawn track in a lane beside the rail, labelled `↩ outcome` at its Step, rising into the Step it returns to with an arrowhead; returns into one Step share one track; when two tracks overlap the longer takes the inner lane. Marks (chips beside the Step) only for what leaves the line: `● not a bug → Done`, `↗ feature → Implementation › Build`, `⇢ by hand → Publish`; a hold on the line (Editorial's Legal) is a dashed station with the `hold` pill and ⓘ, and its by-hand move to the next Step is the rail segment dotted with an arrowhead and `by hand`. Done is the filled green station with `N today`. On the Workflow that does not hold the Project's retro Step, Done carries the chip `↗ Retrospective › Retro` (a Parent's end files its Retrospective there).
- **Also starts here (vf-1).** A light hairline group beside the start Step's row, to its right, with an arrow pointing back at Start: the parked hold (`Backlog` · `hold` pill · ⓘ with the hold hover · its count · the mark `⇢ Build`) and the breakdown Step (`Plan` · ⓘ with `filesHint` · Skill tag · median · takers · its held chips · the marks `● Done`, `↳ Build`). On a phone and in the 512 card the group follows the start Step's rows instead (vf-10).
- **When a Parent ends (vf-2).** On a Workflow that still holds the Steps carrying `acceptance`, `retro` or `skill-review` (today's seed; the owner's MAIN), they are a quiet row under a divider headed `When a Parent ends ⓘ` (hover: `AFTER_HINT`), drawn as their own small line with thinner, lighter strokes and their own Done; nothing joins it to the main Done.
- **Tasks at a Step (vf-4).** A Step shows its HELD Tasks as chips (holder avatar · key · age), at most three, then one count pill `13 waiting ›` (a control) that opens the Step's list in place under the pill: the waiting Tasks' rows (glyph · key · title · age), the first five then `8 more Tasks` (a link to the Tasks list filtered to the Step). A Step with nothing shows nothing. The scope's "+N outside the scope" stays the shipped faint `+N` beside the count. Blocked held Tasks keep the red `blocked by DARK-27` line.
- **Selected Task (vf-7).** Selecting a chip puts a strip above the line: `DARK-21's way` pill · holder avatar · key · age · `next: pass → Review` · the chain's first move (Answer / Claim button, as the shipped callout carried) · ×. Its way in and what can happen next stay dark; everything else fades to about 25%. The Connector hover is the shipped popover (`outcomeHint`).
- **The list page (vf-8).** `/projects/:key/workflows` draws each Workflow as its own vertical line, side by side in columns (stacked on a phone), each column headed by the grip · name · `N Tasks` and the shipped acts (✎ edit, the ⋯ with order and delete; `+ Workflow` on row 2). Each column's Start, Steps, chips, counts, marks are the line's own at that width; "Also starts here" follows the start Step inside the column. A column's name opens the Workflow's page.
- **Editing (vf-9).** The same line with fields in place: a grip and the name as an input per Step, the Skill tag as a select (`no Skill ⌄` makes a hold), each outcome editable (`↩ fail → Build` with its target as a select, × to remove) and `+ Outcome` last under each Step; `+ Step` at the left of row 2; `3 changes ⌄` · Cancel · Save at the right; a changed or added Step or outcome drawn in the changed colour (`--ring`), never a state hue; the "Also starts here" group editable the same way. Everything the draft model does today stays: the Changes chip's count and list, delete asks where Tasks go, a clashing name refused on the field with where it is taken, Taken-by reach confirm, "where New Tasks start" said under the list when the draft moves it, nothing sent until Save, one PUT.
- **Phone (vf-10).** The same line at 390: the group under the start Step, chips wrapping, the panels under the line as today.

---

## Task 1 — The line is vertical at every width, drawn to the final composition

**Files:** `web/src/components/workflowLine/Vertical.tsx` (evolve), `WorkflowLine.tsx` (always vertical; the `orientation`, `verticalBelow`, `density` props go, `compactHeads`/`fold`/`noBranch` reviewed), `layout.ts` (`brackets` → lanes/tracks with the inner-lane rule; keep `lineTopology`, `chipsAt`, `railX`), `Token.tsx`, `words.ts` (`START_LABEL = "Start"`, the Skill and median hovers), `draw.ts`; tests `vertical.test.tsx`, `entry.test.ts`, `crossing.test.tsx`, `layout.test.ts`; callers `screens/workflow/Live.tsx`, `screens/task/TaskLine.tsx`, `screens/task/Subtasks.tsx`, `screens/workflow/edit/Preview.tsx` (drop the props they pass; `grep -rn "orientation=\|verticalBelow=\|density=" web/src` without a glob).

**Build to:** vf-1 (g2), vf-2 (g1), vf-3, vf-5 (12 Steps on one rail, 1 crossing at most, the card scrolls), vf-6 (the hold on the line, the dotted by-hand segment). The ACME fixture (`fixture.json` projects.ACME) and `fixtures.ts`'s BIG are the heavy case.

**Steps:**
1. Read the five PNGs and `frag-vfinal.html` for the exact words, sizes (station 18px filled for Start, 12px hollow for a Step, the green Done), lane widths and the chip vocabulary (`● ↗ ⇢ ↩ ↳`).
2. Write the failing tests first in `vertical.test.tsx`: the start station is first in the DOM and carries "Start"; each segment has an outcome label and an arrowhead; a return track exists per target with the `↩ needs changes` label; the hold on the line renders dashed with `by hand` on the dotted segment; the "When a Parent ends" row holds the Steps carrying `branchSkills` and no Connector reaches the main Done from it; the `↗ Retrospective › Retro` chip at Done appears only on a Workflow that does not hold the retro Step and the Project has one.
3. Evolve `VerticalLine` to pass; the SVG rail and tracks are drawn from measured station ys as today (`dots`/`ys`); lanes computed in `layout.ts` (`tracks(t)`: one per target, nested by span, the longer inner).
4. `WorkflowLine` renders `VerticalLine` always; remove the horizontal branch and the width-based `fits`/`tooTight`; keep the font-ready measure only if the vertical layout needs it (it should not).
5. Update the callers; keep `TaskLine`'s and `Subtasks`' line drawing vertically (this departs from the dogfood board's Task-page frames: log it).
6. `npm run typecheck && npm run lint && npx vitest run src/components/workflowLine` green; `npm run lab -- e2e/workflow.lab.ts` and look at `web/e2e/screenshots/workflow-*.png` beside vf-1/vf-3.

**Verification:** the tests above; the lab screenshots read like the frames (Start first, labels on the rail, tracks beside it); no console error; no sideways scroll at 390.

## Task 2 — Tasks at a Step: held chips and one count, the list in place; live moments on the rail

**Files:** `Vertical.tsx`, `Token.tsx` (a `Count` control), a new `StepList.tsx` under `workflowLine/` (the in-place list: rows glyph · key · title · age, five then `N more Tasks` linking to the Tasks list filtered to the Step — check `screens/tasks` for the filter param the list page reads, `filter.step=` or its spelling), `useLiveFlow.ts` (the pickup "now" tag and a move travelling down the rail: keep the shipped behaviour; `livePage.test.tsx` and the Playwright "live moments, phone" test already assert the vertical case), tests.

**Build to:** vf-4 (the busy Build: one held chip, `13 waiting ›`, the list open), vf-1 (`1 waiting ›` closed), the scope's `+N` beside the count.

**Steps:** failing tests (at most three held chips; the count's noun; opening the count lists the waiting Tasks oldest first and says `N more Tasks`; a Step with no Tasks renders no chip row); implement; the count opens on click (not hover), moves the rows below it down (allowed: it is a click), closes on a second click or Escape; one open per line.

**Verification:** `npx vitest run src/components/workflowLine src/screens/workflow`; the lab's live-moments screens still pass; a lab screenshot with the `busy` data beside vf-4 (add the busy data to `e2e/lineMock.ts` or `workflowMock.ts` from `fixture.json`'s `projects.DARK.busy`).

## Task 3 — The selected Task's strip

**Files:** `Vertical.tsx`, `Callout.tsx` (retire the floating callout; the strip takes its content: the chain's `first` move and its Answer/Claim button via `actionFor`), `Live.tsx` (the strip above the line), tests `vertical.test.tsx`, `livePage.test.tsx`.

**Build to:** vf-7.

**Verification:** selecting a chip shows the strip with `DARK-21's way`, the holder, the age, `next: pass → Review`, the button when the chain has a first move; × and Escape clear it; everything off the Task's way is dimmed (`data-dim`); the Connector hover is unchanged.

## Task 4 — The Workflows list as vertical lines side by side

**Files:** `screens/workflow/WorkflowsList.tsx` (the table goes; one column per Workflow, `useLineData(project.key, workflow.id, null)` per column or one read of the Project's line data split by `shown`/`drawnSteps` — check `useLineData` reads once per Project and derive per Workflow from it; never N requests), `workflowRows.ts` (keep the counts for the column head), `workflowsList.test.tsx`, Playwright `e2e/workflows.spec.ts`.

**Build to:** vf-8 (three columns at 1184; stacked at 390). The acts stay exactly as shipped (`useWorkflowActs.ts`: one PUT each, toasts, the last Workflow's delete off with its reason).

**Verification:** the list test asserts one column per Workflow in position order with its Start and Steps, the acts present for an admin and absent for a Member; `workflows.spec.ts` green; a lab screenshot beside vf-8.

## Task 5 — Editing on the line

**Files:** `screens/workflow/Editing.tsx` (the page: row 2 = `+ Step` left, `N changes ⌄` · Cancel · Save right, as today), a new `edit/OnLine.tsx` rendering the draft on the line (names as inputs, Skill select, outcomes with target selects and ×, `+ Outcome`, grips for order, the group editable), retire the rendering of `edit/Preview.tsx`, `edit/StepList.tsx`, `edit/StepPanel.tsx`, `edit/TakenBy.tsx`, `edit/Outcomes.tsx`, `edit/StepOptions.tsx` while KEEPING `edit/draft.ts`, `edits.ts`, `bind.ts`, `edit/SkillPicker.tsx`, `edit/DeleteWorkflow.tsx`, `edit/WorkflowName.tsx` and every rule they carry; `edits.test.ts` stays green untouched; `workflow.test.tsx`'s editing cases are rewritten against the new rendering.

**Build to:** vf-9 (QA added after Review in the changed colour; 3 changes; Save on).

**Steps:** list the behaviours the old rendering carried (grep each `edit/*.tsx` for what it asks the draft: rename, move, delete with "where do its Tasks go", Skill change with the Taken-by reach confirm, outcome add/retarget/remove, the clash refusal, the start-moved note) and write a failing test per behaviour against `OnLine`; implement; the changed colour is `--ring`.

**Verification:** `npx vitest run src/screens/workflow`; Playwright `e2e/workflow.spec.ts` "editing: nothing is sent until Save; then the new Skill, then one PUT" green; a lab screenshot beside vf-9.

## Task 6 — Retire the horizontal line

**Files:** delete `Horizontal.tsx`, `pinned.test.ts` + `__layouts__/`, `e2e/line.lab.ts`, `e2e/lineBoxes.ts`, `e2e/dense.lab.ts`; strip `layout.ts` of the horizontal placement (`horizontal`, `placeHeads`, `stationsX`, `zoneOf`, `densityFor`, `handRoute`, `leaveRoute`, `chipRoute`, `placeArrivals`, `placeExits`, `lineLayout`) and `measure.ts` if only the horizontal used it; `dense.test.ts`, `layout.test.ts` trimmed to what remains (`lineTopology`, `topologyCrossings`, `tracks`); `README`/comments that describe the horizontal line.

**Decisions line:** "The line is vertical at every width (the owner's pick, 2026-10-10); the horizontal line and its pinned layouts are retired — the 'pinned layouts are a change detector' line of Named Workflows no longer applies."

**Verification:** `make web-check` green; `grep -rn "Horizontal\|horizontal(" web/src` finds nothing but prose.

## Task 7 — Screenshots against the mockups

**Files:** `web/e2e/compare.mjs` (adapt: the mockups are `dir-e/vf-N.png`; the seed is the fixture), a new `scripts/seed-fixture.sh` or a Node seeder that builds the scratch Install's record from `fixture.json` through `/v1` (Members with their Skills, Projects DARK on g2 via `darkory workflow set --file`, plus the `busy` Tasks; NEWS; ACME with its Skills first; and the owner's MAIN shape from `docs/build/model-v2-plan.md` "The default Workflow" / `fixtures.ts` MAIN), `web/e2e/compare.notes.json`.

**Steps:** `make build` into the worktree's `bin/`; `darkory init` a scratch Install under the scratchpad (never the owner's `.dev`), serve on a free port with `--runner=off`; seed; shoot every vf frame's state at 1440 (light) and the phone at 390: vf-1 (DARK › Implementation on g2), vf-2 (a second Project on g1), vf-3, vf-4 (busy Build, the count open), vf-5 (ACME), vf-6 (NEWS), vf-7 (DARK-21 selected), vf-8 (the list), vf-9 (editing with QA added, unsaved), vf-10; lay each beside its mockup in `screenshots/compare/index.html`; compare element by element (Start first; labels on the rail; tracks; marks; chips ≤ 3 + count; the group's place; words); fix in the code; re-shoot; write what stays different and why into `compare.notes.json`; log departures.

**Verification:** the compare page with every pair and its notes; the lead looks at it once before the gate.

## Task 8 — Gate, PR A; PR B (the seed) opened

**PR A (this branch):** `make check`, `make web-check`, `make e2e`, `make e2e-pg`, `cd web && npm run e2e` all green at the head; decisions.md lines (vertical at every width; held chips + one count; the horizontal retired; D3 Text view as C's outline is a follow-up); `docs/build/status.md` paragraph; PR body with the final design's link, the compare page's path and the departures; merge to main; then in the main checkout `git pull` and `cd web && npm ci` so devrun rebuilds the owner's `.dev`.

**PR B (`seed-retrospective`, a worktree off main after A merges):** `internal/core/workflow.go` `defaultWorkflows`: Implementation = Backlog · Plan · Build · Review; a third Workflow Retrospective = Retro · Skill review at position 3 (Retro done → Done, propose → Skill review; Skill review publish → Done, needs changes → Retro); every pinned test and mock updated (`init_test`, `fixture_test`, `workflow_test`, `runner_test`, `mvp_test`, `projects_test`, `mcp`, `cli/phase2_test`, `e2e/harness_test`, `web/e2e/workflowMock.ts`, the specs `init`, `workflow`, `flow`, `settings`, `avatar`); ADR 0019's Consequences gain a line; decisions.md line "D1: a new Project starts with three Workflows (the owner's call pending)"; the full gate green; PR opened and NOT merged. The lead's final message names it as the one open call.

---

## Decisions to record (decisions.md, one line each)

- The Workflow line runs top to bottom at every width; the horizontal line and its pinned layouts are retired. Why: the owner's pick on the vertical final design, 2026-10-10.
- A Step on the line shows its held Tasks (at most three) and one count of the rest, which opens the Step's list in place. Why: "you cannot show all tasks running on that because it's a lot of tasks."
- The line's words are one word where one will do (Start; the Skill tag; a bare median), the sentence behind a hover or ⓘ. Why: "no one wants to read a lot of text."
- The editor renders the draft on the line (fields in place) over the same draft model. Why: the same idiom edits (vf-9); the rules did not move.
- Follow-up, not built: the Text view as the outline (D3).
