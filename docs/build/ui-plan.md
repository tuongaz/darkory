# UI redesign build plan

The web app is rebuilt to the mockup board of 2026-10-06 (https://claude.ai/artifact/JAXxat25iP88anBMuSAfCX): Linear-like, shadcn/ui on Radix, one shell for every screen. The board's three decisions are taken as drawn and recorded in [ADR 0012](../adr/0012-tasks-have-a-status.md). Read [`plan.md`](plan.md) for the layout and the invariants, which still hold; this file adds the phases, the rules of the build, and the scenarios that prove it.

The design sources (brief, kit, fixture, fragments) live in the session scratchpad `…/scratchpad/mock/`; `brief.md` there is the designer's contract and the `frag-*.html` files are the screens. The mock is the spec; where the mock and `/v1` differ, `/v1` wins and the difference is listed under "Found while building" below.

## Rules of this build

- **Worktrees only.** The human's `make dev` runs from the main checkout (devrun watches `cmd`, `internal`, `client`, `api`; Vite watches `web/src`). Every agent works in `git worktree add -b <branch> /Users/tuongaz/dev/darkory-wt/<name>`; main receives merges only. After the merge that carries migration 0003, their `.dev` Install needs `darkory migrate --data .dev` (serve refuses to start with migrations pending).
- **Both engines.** `make check` (SQLite + Postgres at `postgres://dk@localhost:54329`, the `dk-pg` Docker container) before every merge, then `make web-check`, `make e2e`, `make e2e-pg`, `cd web && npm run e2e`.
- **Spec first.** `api/openapi.yaml` changes, then `make gen` and `cd web && npm run gen`, and the generated code is committed (`gen-check`).
- **Decisions** go in [`decisions.md`](decisions.md), one line each with the reason; **CONTEXT.md** words are the only words on screen.
- Commit and push per phase with the session's attribution lines.

## Phases

### S — Status model (server, API, CLI, MCP)

1. Migration `0003_task_status` (split files for both engines, as 0002): `statuses` (id, org_id, name, kind CHECK IN (backlog, todo, in_progress, done, dropped), position, created_at; unique (org_id, name)); `tasks.status_id` referencing it. Seed the six defaults for every existing Organisation; backfill Tasks by rule: done → Done, dropped → Dropped, open with a live Claim → In progress, else Todo. `darkory init` seeds the six for a new Organisation.
2. Rules, inside the existing conditional UPDATEs (invariant 2 and 4): Takeable adds `status kind IN (todo, in_progress)`; claim sets the first in_progress Status when the kind is todo; complete → first done; drop (and the Feature-drop cascade) → first dropped; every other Claim end (release, lapse record, take-back, token revoke, Session close, Member deactivation) → first todo when the kind is in_progress. Handover takes an optional `status`. Test both orders: lapse → sweep → claim and lapse → claim → sweep.
3. `/v1`: `status_id` on Task; `GET /v1/statuses`; `PUT /v1/statuses` (admin; whole list with ids for existing rows; refused `invalid` when a kind among todo/in_progress/done/dropped would be missing; a deleted Status that Tasks are in needs `moves: {from: to}` or is refused `status_in_use`); `POST /v1/tasks/{task}/status {status}` (any Member of the Feature's Team; done/dropped kinds refused with `use_complete` / `use_drop`); `status` filter on `GET /v1/tasks`; Activity kinds `task.status_set {from, to}` and `statuses.changed`; `member`, `kind` and `team` query filters on `GET /v1/activity`.
4. CLI `darkory status <task> <status>`, `darkory workflow` (list), `show`/`tasks` print the Status; MCP tool `set_status` and Status in `show_task`/`list_tasks`; `handover --status`.
5. Tests on both engines: rule tests per move, the migration upgrade from a 0002 database, the race suite still green, the pgx round-trip count unchanged on the hot paths, e2e text updated.

### W — web app, rebuilt

W1 first, then W2–W5 in parallel in their own worktrees, touching only their own folders.

- **W1 skeleton:** Tailwind v4 + shadcn/ui on Vite (`@tailwindcss/vite`, `components.json`, `@/` alias), `globals.css` = the mock's `tokens.css` verbatim plus shadcn's `.dark` block, lucide-react, cmdk, sonner, `@dnd-kit`. The shell (Sidebar, top bar, ⌘K, keyboard shortcuts C and G B), the route table with a placeholder page per screen, shared primitives (StatusGlyph, Avatar with the agent mark, pills, Key, PageHeader, PropertiesRail, Peek sheet, Dialog form layout, Timeline), the signed-out page, the empty-Install checklist, the update banner. Deletes the old views and tests it replaces; owns `web/e2e/` and the Playwright config. Keeps two invariants from the old suite: live updates appear without reload; the board at 390 px has `scrollWidth === clientWidth`.
- **W2 Board:** Team › Tasks as list (grouped) and board (kanban, drag between Statuses, refused drags as toasts naming the resolving action), Display options, Team › Features ranked with drag, File Feature and File Task dialogs.
- **W3 Task and Feature:** Task peek and page, Hand over / Take back / Complete / Release / Drop dialogs, Notes, Observations, Evidence, Blockers, the proposal diff on a Retrospective, Feature page with Ship (and its refusal), Pass ownership, Drop Feature.
- **W4 Inbox, My work, Agents, Activity:** Inbox sections by rule, My work, Agents table and peek (Sessions per agent through `session list`), Activity grouped by time with Member/Kind/Team filters and Load older.
- **W5 Admin and Account:** Members (grouped), New Member with the token shown once, Member page (Teams, Skills, Reporting line, tokens, Sessions, Deactivate), Teams, Skills with versions and proposals, Workflow (Statuses), Account.

### T — proof

- **Bots** in the Go `e2e/` harness: planner (takes Break downs, files Tasks into Backlog and Todo), two builders (`next` → heartbeat → Note → Evidence → a question that blocks → handover or complete), reviewer (takes `review` and `skill-review`, publishes a proposal), a lapsing bot (2 s timeout, exits), a stuck bot (heartbeats until taken back; the CLI must exit 3). One bot proves Backlog is never offered by `next`.
- **Human journeys** in Playwright, each scenario = seed through `/v1` → act in the UI → assert → screenshot into a gitignored folder. Scenarios: see below.
- **Review:** an artifact pairing each scenario's screenshot with its mockup frame; a reviewer agent that did not build it scores the screens against the mockups and Linear's conventions (density, sidebar, peek, keyboard, drag); fixes; re-shoot; republish.

## Scenarios

1. A live Claim by a bot appears on the Board without reload; the card shows the holder and the Heartbeat countdown.
2. Dragging a Task from Backlog to Todo makes it takeable: the builder bot's next `next` returns it.
3. Dragging a Task to Done without holding it is refused with the toast naming Claim; the card snaps back.
4. A Member outside the Feature's Team cannot drag its cards.
5. Ship is refused with the open Tasks named; after the bots finish, Ship succeeds and the Retrospective appears.
6. Take back on a Task a bot holds while it heartbeats: the bot's CLI exits 3, the Task returns to Todo, the Activity shows the take-back.
7. A lapse: the lapsing bot's Task shows Lapsed on Agents and returns to Todo; the Activity entry has no actor.
8. An admin edits the Workflow (renames In review, adds a Status) while the Board is open; the columns update live.
9. Deactivating an agent ends its live Claim; the Agents page shows it; its token no longer works.
10. A builder bot's question aimed at Mai lands in Mai's Inbox; answering it (Claim, Note, Complete) unblocks the builder's Task.
11. The reviewer bot publishes a proposal; the Skills page shows version 2 and the Retrospective shows it published.
12. The signed-out page, the login link, sign in, the empty-Install checklist, Create Team → Add Member → File Feature.
13. ⌘K finds a Task by key and by words; C opens File Task; G B opens the board.
14. The board at 390 px does not scroll sideways.
15. The Task peek opens from the Board, list, Inbox and Activity; the page opens from the peek.

## State at the end of the build (2026-10-07)

- **Shipped on main** (6639efd): the Status model (migration 0003, rules, `/v1`, CLI, MCP), the rebuilt web app (shell, Board list and kanban, Features, Task peek and page, Feature page, Inbox, My work, Agents, Activity, Admin with Workflow, Account, sign-in), the agent bots (`tools/bots`, `e2e/bots_test.go`).
- **Reviewed:** an independent reviewer scored each screen against its mockup frame and Linear's conventions on a live Install; its 15 defects (an unstyled login-link page, no J/K keyboard model, ⌘K ranking an exact key last, and twelve smaller ones) were fixed and the screens re-shot.
- **Verified:** `make check` on SQLite and Postgres (32 packages each); 165 Vitest tests; 15 Playwright scenarios against the real binary (`cd web && npm run e2e`); the Go end-to-end suites on both engines (`make e2e`, `make e2e-pg`: bots, lapse and recovery, MCP, two servers on one Postgres, the soak with the Status invariant). Evidence with screenshots: https://claude.ai/artifact/H3bog6Bsyv52FVKBD97xhf
- **Known limits:** the Lapsed mark on a list row reads the Team's latest 500 claim/lapse/complete Activity entries; "Takeable by" leaves out blocking and the no-self-review clause; Sessions and tokens of another Member are admin-only, so a non-admin's Agents page shows no Session ids; each Playwright spec starts its own Install (the binary is built once per spec).
- **For the human's `make dev`:** the Install in `.dev` was migrated to 0003 by the restarted server (backup `darkory.db.pre-0003.*.bak`); `make dev` now runs `npm ci` when the lockfile is newer than `node_modules`; `make serve` needs `make web` first (dist/app is not committed).

## Found while building

(Agents append here: anything the mock drew that `/v1` cannot give, and how it was resolved.)

### Filters (2026-10-07)

- **The bar is enably-v2's FilterBar, split in two** (`web/src/components/filters/`): the header's Filter button, beside Display, opens the Filters menu and shows a count while anything is set; `F` opens it too. The chips row renders under the header only while something is set, with Reset at its right. `filterState.ts` is enably's `use-filter-state` (the `field:op:v1,v2` wire format), `operators.ts` its operator rules, `FilterBar.tsx` the menu, the chips and the editors. `screens/board/filters.tsx` holds the Tasks' axes and the values each offers, read from the board's model; `derive.ts`'s `matches` says what a pill means for a Task, and the list and the board both filter through it in the browser.
- **Left out of the port:** the hover flyout (its pointer-aim cone and grace timers were a third of enably's component), so the menu drills in by a click, or the arrows and Enter, as on touch. Also left out: day marks, money ranges, pinned and default-shown axes, page-supplied rows, custom editors, chips and summaries, saved views, permission gating, search-first value lists fetched from an endpoint, the text editor (Search is the only text axis), and the result count (the list's footer already says "3 Tasks · Filtered hidden (5)").
- **Search is a pill**, `q:contains:<words>` in `?filter.tasks=`, not enably's own `?search=`, so the server's `filter` reads it with the rest. The Filters menu leads with its field, written as it is typed. enably also adds a field that narrows the axes past eight of them; it is left out where Search leads, since two fields in one menu read as one too many.
- **One value reads "is" and several "is one of", in both directions.** Unticking down to one value goes back to `is`; enably kept `in` there. An axis without `nin` (Aimed at, Feature owner, Filed by, Kind) cannot say "is none of", so under "is not" a pick replaces the value instead of adding one.
- **Statuses are grouped by kind with rules, not headings.** A heading over a lone Status of the same name ("Backlog" over Backlog) repeated it, and the glyph already says the kind. A group of values carries a heading only when it has a name of its own: Features are listed as the open ones by Rank, then "Shipped and dropped", since the board shows those Features' Tasks by default.
- **A Status pill beats the Display.** "Status is Done" shows the Done Tasks even while Display hides Done. On the board, the Done and Dropped columns still collapse as the Display says.
- **What each axis reads:**
  - Held by reads the live Claim, so a done Task is held by Nobody even though its card shows who completed it.
  - Aimed at reads `aimed_at_id` whether or not someone holds the Task.
  - Kind's Question is a work Task aimed at a Member, and Work a work Task aimed at nobody.
  - Blocked reads the record's flag, whatever the Task's own state.
  - Search matches the key or the title, not the description, as the server's `q` does, though the list record carries the description.
  - The Member values are the Organisation's active Members, the signed-in one first and marked Me, each named by id.
- **Old links** of the form `?skill=<name>&holder=<name>&blocked=1` are rewritten into `filter.tasks` once the Skills and Members load, in one write that drops the old parameters. A name that matches nothing is dropped.
- The address reads `filter.tasks=status%3Ain%3A…`: URLSearchParams percent-encodes the token's colons and commas, and each value is encoded once more inside the token. That is the wire format working as intended.
- **Dates on the wire** are RFC 3339 instants with the browser's offset, at millisecond precision (the record keeps Unix ms). A picked local day becomes its bounds, 00:00:00.000 and 23:59:59.999:
  - after:end(D)
  - before:start(D)
  - gte:start(D)
  - lte:end(D)
  - btw:start(A),end(B), inclusive at both ends. One day is btw of that day, since dates have no `is`.
  - last:7d|30d|90d

  Each bound carries its own offset. On 4 Oct 2026, the day Melbourne's daylight saving starts, the day runs from +10:00 to +11:00. Flipping the operator keeps the days and bounds them again. The chip reads each instant's day in the viewer's time zone: "after 4 Oct", "4 Oct – 6 Oct", "Last 7 days". The lead passed these tokens on to the `api-filters` branch.
- **Updated is not a filter axis.** The Task record carries no `updated_at`. The server derives one from the latest Activity, which the list cannot see, so the web never offers Updated and the two never disagree on a token. The list's Updated column keeps its own time (`updatedAt` in `derive.ts`). The Tasks' date axes are Filed (`created_at`) and Completed (the `ended_at` of a Task that ended done).
- **The tokens are the server's, word for word and meaning for meaning,** as merged at 4868921 (`api-filters` a145b81). The web's client-side `matches` reads every token as `GET /v1/tasks?filter=` and `GET /v1/features?filter=` do, and `POST /v1/views` checks a View's filters by that grammar. The words went through two rounds (42277cc had `retro`, `lapsed_24h`, `live_session`), and these are the final ones:
  - Kind `retrospective`.
  - Kind `question`: a work Task aimed at a Member.
  - Claim `held`: a live Claim.
  - Claim `unheld`: no live Claim, in any state, the same as Held by Nobody.
  - Claim `lapsed`: a Claim of the Task lapsed within the last 24 h, whether or not it was claimed again since, recorded or only past its expiry. The browser reads recorded lapses from the Claim trail the board already loads (`lastLapseAt`), so a lapse older than its 500 entries counts as none.
  - Claim `session`: the Runner beside the server runs a session for the Task. The browser reads `GET /v1/runner/sessions`, the Agents page's query, which polls every 5 s while a Runner is attached.
  - Blocked: the record's flag, whatever the Task's own state.

  Each axis is several values at once where more than one holds.

  The server also has `status_kind`, `team`, `blocks` and `model`, which the bar does not offer yet.
- **The Team pages still filter in the browser.** They hold every Task and Feature of the Team already. The pills are the server's tokens unchanged, so a paged or cross-Team list (My work, Inbox) can pass `?filter.<entity>=` straight through as `filter=` later.
- **Views (phase 3)** port enably's SavedViewsControl and useSavedFilters onto `/v1/views`. The header's Views control beside Filter lists the Member's Views of this list and Team (`GET /v1/views?entity=&team=`):
  - Choosing a row applies that View.
  - "Save as view…" asks for a name.
  - Each row has Overwrite and Delete; Delete asks nothing, and the PATCH's rename is not offered.
  - With none, it says so in plain words.

  What a View keeps:
  - Tasks: the filter tokens, the Display's order as `sort`, and the layout, the grouping and the Show toggles as `display`.
  - Features: the filter tokens, and "Shipped and dropped" as `display`.

  Applying a View writes its pills and `?view.<entity>=<id>` in one address write, sets the layout, and sets this browser's Display, which is kept per browser. A token the page can no longer apply is dropped. The chips row leads with the applied View's name, adding "edited" once the pills differ from its filters in any order. Reset leaves the View in the same write as the pills. A taken name (409) reads "You already have a View named “X” for this list." beside the field, and the field keeps the name. Views write no Activity, so the list is refetched after this tab's own writes; another tab sees the change on its next refetch.
- **The date editor draws one month**, with All and the windows beside it. enably's two-month calendar and its phone takeover sheet are left out: one month fits both a phone and the desktop popover.
- **The phone layout is CSS.** Under 640px each chip takes a line of its own with its value taking the slack, and the row's Reset goes, since the Filters menu keeps its own, as enably's stacked rail does. `stacked` forces the layout at any width.
- **Team › Features:**
  - The owner dropdown and its chip are gone, and Display's "Shipped and dropped" no longer shows as a chip.
  - State (Open, Shipped, Dropped) asked for by name beats the Display, as Status does on Tasks.
  - Old `?owner=<name>` links are rewritten.
  - "State" is the API's word for a Feature's open, shipped or dropped. CONTEXT.md's "avoid: State" is about a Task's Status.

### W2 Board, W3 Task and Feature, W4 Inbox and Agents, W5 Admin (2026-10-07)

- **Lapsed on a list row** has no field: `GET /v1/tasks` carries a Claim only while it is live and `how_ended` only in the Task detail. The Board derives the mark from one Activity read of the Team's latest 500 `task.claimed` / `task.lapsed` / `task.completed` entries joined with the stream; a lapse older than that window shows nothing. The Done card's avatar is the completer from the same read. A `last_claim_end` on the list record would replace it.
- **Status moves by Darkory record no Activity** (`decisions.md`); `task.status_set` comes only from a Member's move, so the Task record shows a Claim's start and end, not the moves they imply.
- **Who took a Claim back, who dropped a Task, and why** are in Activity only, not in the Task detail; the record reads "X's Claim was taken back" and "Dropped" without the actor. A Claim does not carry the Skill it was handed over to; the page takes it from the next Claim or the Task's current Skill.
- **`tasks_open` names no Tasks**: the Feature page re-reads the Feature and names its open Tasks in the toast.
- **Feature Evidence**: `GET /v1/features/{feature}` carries the Feature's own Evidence only; the page reads each Task's detail and merges, one request per Task.
- **"Takeable by"** is computed in the browser from the Team's Members' Skills (one request per Member) and leaves out blocking and the no-self-review clause; "N Tasks takeable" for an idle agent is not drawn (no per-Member takeable read for another Member). "No Session yet" is not drawn either: only the Member or an admin may list a Member's Sessions, and tokens and Sessions live at `/v1/members/{member}/sessions` and `/tokens`.
- **The proposal diff** is taken against the version it was based on (`GET /v1/skills/{skill}/versions`), and a stale base shows a warning in place of "Completing this review publishes version N".
- **File Task and `forbidden`**: the server checks Team membership only when filing a Feature, or a Task that blocks another; the dialog words both.
- **Live Statuses**: the shell's live-update map had no root for `statuses.changed`; the Board and the Workflow page refetch the list themselves (a `statuses` root is being added to the shell).
- **Intent** carries only `team`; the Board's column "+" and the Feature preset use a board-local event (an optional `status` / `feature` on the intent is being added to the shell).
- **Not shipped from the mock**: the "New" tag chips (review chrome); the Evidence count and "Proposal · version 2" line on cards (the list record lacks them); a × in a dialog header (Cancel and Esc close it).
- **Pass ownership** is offered to the owner only, although `/v1` also lets someone above the owner on the Reporting line pass it; Add blocker and Attach Evidence are offered to the owner and the Feature's Team when nobody holds the Task, as `/v1` allows.
- **Each e2e spec starts its own Install** (`startServer()` in `web/e2e/server.ts`, which also exports `DARKORY_E2E_ADMIN_TOKEN`), because spec files run alphabetically and the smoke spec needs a fresh Install with its startup link unused; `npm run e2e` therefore builds the binary once per spec.
- **Dev gotcha**: writes through the Vite proxy need the server's `--public-url` (or `DARKORY_PUBLIC_URL`) set to the Vite address, as `make dev` does; otherwise the Origin check answers `forbidden`.

### W1 skeleton

- **The app's CSP refuses Google Fonts and injected styles.** `appCSP` is `style-src 'self'; font-src 'self'`. Inter is served from the bundle (`@fontsource-variable/inter`, registered as "Inter" so `tokens.css` stays verbatim) rather than from Google Fonts, which also suits a Local Install with no internet. Sonner, Radix Select's viewport, Radix ScrollArea and react-style-singleton (Radix's scroll lock) add `<style>` elements at run time; the build turns that off (`noInjectedStyles` in `vite.config.ts`, which fails the build if any of them changes) and `globals.css` carries their CSS. Vitest runs those packages through the same patch, and `src/components/csp.test.tsx` fails if an open Select, a ScrollArea, a Dialog or a toast adds a `<style>`; the e2e suite fails on any console error, so a new CSP refusal shows.
- **Stream state reads "Connected"** (the lead's word) on the sidebar's Member row, not the mock's "Live"; the others are Connecting, Reconnecting, Offline. "N live" beside Agents keeps "live".
- **"N live" has no endpoint.** It counts the distinct agents holding a live Claim over `GET /v1/tasks?state=open` (every page), refetched when Task Activity arrives. Fine at this scale; an `agents` summary on `/v1` would replace it.
- **⌘K has no search endpoint.** Opening it reads every Task and Feature (`useAllTasks`, `useAllFeatures`) and matches keys and words in the browser. Choosing a Task opens its page.
- **The Install checklist stays until the Organisation has a Feature**, not only while it has no Team, so steps 2 and 3 are reachable from it (scenario 12); with no Feature there are no Tasks, so the Inbox would be empty anyway. Step 2 is done when the Organisation has a second Member. Create Team and Add Member go to `/admin/teams?new=1` and `/admin/members?new=1` (W5 opens the dialogs); File Feature sends the `file-feature` intent (W2). Filing needs the filer in the Team (`forbidden`), which W2's dialog must say.
- **No Organisation switcher.** Local holds exactly one Organisation, so the sidebar's Organisation row has no chevron and opens nothing.
- **The sidebar lists every Team** of the Organisation (`GET /v1/teams`), not only the Member's, so an admin who creates a Team without joining it still finds it.
- **Admin has no Install tab**: the mock did not draw it.
- **Statuses are not on `/v1` on this branch.** `StatusGlyph` takes a glyph, `glyphFor(kind, nth)` maps a Status kind to one, and `taskGlyph` derives a glyph from a Task's state and Claim until phase S merges.
- **The shadcn Sidebar's ⌘B toggle is removed**: ⌘K, C and G B are the only keys the design claims.
- **Account carries Sign out already** (placeholder), so a browser can leave before W5 lands.
- **`make dev` shows Connecting for up to 25 s**: through Vite's proxy the Activity stream's headers arrive only with its first bytes (the keep-alive comment). The binary is unaffected. Writing a comment when the stream opens would fix it.
- **The bundle is over Vite's 500 kB warning** (517 kB, 163 kB gzipped). Lazy-loading the screens in `routes.tsx` would split it once they are built.
### S — Status model

- **Phase S, the Status model.** `fileTask` takes an optional `status` (open kinds; default the first todo Status), so File Task's Status field and the planner bot's "file into Backlog" are one write. `TaskDetail` carries the whole `status`; a `Task` in a list carries only `status_id`, so the board reads `listStatuses` once for its columns and names. The web's live-update map needs the new subject type `statuses` (`statuses.changed`, subject id the Organisation's); the old app maps it to the work queries.
- Handover leaves the Status unless the holder names one, so a Task can sit in an in_progress Status with nobody holding it (after a Handover, or a lapse not yet recorded); the board must show the holder from `claim`, never infer it from the column.
- `setTaskStatus` works on held Tasks for any Member of the Feature's Team, the Feature's owner and the Task's holder (ADR 0012, D3), so dragging a held card between open columns succeeds and the Claim stays; a drop on a done or dropped column is `use_complete` or `use_drop`, anyone else `forbidden`, an ended Task `ended`. The refusal messages name the Status; there are no `details`.
- `setStatuses` refuses a Status that Tasks are in changing between an open kind, done and dropped (`status_in_use`), and a move that would change how a Task ended (`invalid`); Workflow's editor should offer moves only into a Status of the same ending.
- Activity's `team` filter keeps only entries about a Feature or a Task (by subject), so Member, Team, Skill, token and Session entries never show under a Team; `member` also keeps the lapses, take-backs and other Claim ends that name the Member as holder. The stream has no filters: a filtered Activity view refetches its page on a new entry.

### Filters, server side (2026-10-07)

- **`filter` on `GET /v1/tasks` and `GET /v1/features`** takes the web bar's tokens (`?filter.tasks=` in the page's URL, `filter=` on the wire): repeatable, each value percent-encoded inside the token, ids not names, several tokens AND, `in` and `nin` OR within one. The grammar is in the parameter's description in `api/openapi.yaml`, so `schema.gen.ts` carries it. It composes with the old parameters (`feature`, `team`, `state`, `skill`, `aimed_at`, `holder`, `status`). The fields are one SQL predicate each in `internal/core/filter.go`, the same on both engines; nothing is filtered in memory.
- **The vocabulary is the lead's final one** (decisions.md, "Filters and Views"): `kind` work · breakdown · retrospective · question; `claim` held · unheld · lapsed · session; no `updated_at`; `q` over key and title. The browser can match every field with the same meaning, except `claim:lapsed` once the lapse is older than the Activity the Board reads.
- **`claim:session`** is the Runner's, not the record's: the server reads its attached Runner's sessions (as `GET /v1/runner/sessions` lists them) and binds their Task ids into the query. With no Runner attached nothing is in a session.
- **`kind:question`** is a work Task aimed at a Member; the record has no question kind.
- **Names in a token are refused** (`status:is:Todo` is `invalid`): the bar must send ids, and an old `?skill=build` link must be turned into the Skill's id before it becomes a token.
- **The CLI and MCP** take the same tokens: `darkory tasks --filter holder:is:none --filter filed_at:last:7d`, `darkory feature list --filter quick:is:true`, `list_tasks {"filter": [...]}`.
- **Views** (`GET/POST /v1/views`, `PATCH/DELETE /v1/views/{view}`, migration 0005) save the bar's tokens with an opaque `sort` string and `display` object for one Member, per list (`entity: tasks | features`) and Team (`team_id`, absent across Teams). They write no Activity, so the stream sends nothing when one changes: a second tab refetches `listViews` itself after its own writes. Names are unique per list ignoring case (409 `conflict`), which "Save as view" must word; another Member's View is 404.
