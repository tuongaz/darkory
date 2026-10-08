# Web app: the shell, the folders, the primitives

The app is rebuilt for model v2 (`docs/build/model-v2-plan.md`, Web): Projects, Tasks with
Subtasks, Workflows of Steps. M4a laid the shell, the API layer and Settings; M4b–M4d build the
screens, each in its own folder. Use these pieces rather than drawing your own, and the words of
`CONTEXT.md` only: Feature, Team, Status, Ship, Quick and Admin are gone.

## Who owns what

| Folder | Owner | Pages it exports from `index.tsx` |
|---|---|---|
| `src/screens/board/` | M4b Tasks | `TasksPage` (`/projects/:key/tasks?view=list\|board`), `BoardDialogs` (File a Task, for the `file-task` intent; mounted once by the shell) |
| `src/screens/task/` | M4b Task | `TaskPage` (`/tasks/:task`), `TaskPeek` (`?task=<key>` over any page). Both must call `useReportProject(task.project_id)`. The Session panel, its terminal and `terminal.ts` are already here. |
| `src/screens/workflow/` | M4c Workflow | `WorkflowPage` (`/projects/:key/workflow`, live), `WorkflowSettingsPage` (`/settings/projects/:key/workflow`, editing, drawn inside Settings' frame) |
| `src/screens/inbox/` | M4d Inbox | `InboxPage` (`/inbox`, after the Install checklist), `MyWorkPage` (`/my-work`), `AgentsPage` (`/projects/:key/agents`, `?agent=<name>` opens one), `ActivityPage` (`/projects/:key/activity`) |
| `src/screens/settings/` | M4a Settings | `SettingsLayout` (`/settings/*`, its own nav), the Account, Organisation and Project pages |
| `src/app/`, `src/api/`, `src/components/`, `src/lib/` | M4a | the shell, the route table, the API layer, the primitives |

`src/app/routes.tsx` is the only file that imports the screens. Keep each export's name; put
anything else a screen needs (sub-components, hooks, its own queries, its tests) inside its folder.
If a screen needs a new route or a change to the shell, say so rather than editing `src/app`.

The model-v1 screens live in git history: `git show db4be19:web/src/screens/board/TaskBoard.tsx`
and so on. What their R3 phase added (`docs/build/agents-plan.md`) carries over in v2 words:

| Screen | Holds |
|---|---|
| Settings › a Project › Workspaces | Each Workspace: name, kind, path (cut in the middle so its folder shows), mode (Local or Pull request), default branch, the Projects it is the default of, the open Tasks naming it. |
| Settings › Agents, an agent | The Agent card: command (its placeholders under it), arguments, model, environment, progress file, Paused, Unattended; each saved alone (`PATCH /v1/members/{member}/agent`). |
| File a Task (`BoardDialogs`) | Workspaces (`MultiCombobox`, chips), starting at the Project's default (a Subtask: its Parent's); not shown while the Install has none. |
| A Task's properties (`task/`) | The Task's Workspaces and branch (`taskBranch` in `@/lib/branch`, `main-7-support-emoji`, the plan's name until M3's Runner lands). |

## The sidebar

`AppSidebar` (`src/app/`), after Linear's: no footer.

- **Top row**: the Organisation's button (its mark, its name, ▾) opening the Organisation menu, a
  dot beside it for the Activity stream (green Connected, amber Connecting… / Reconnecting…, grey
  Offline; the words on hover and in its `role="status"`), then Search (opens ⌘K) and File a Task
  (the `file-task` intent for the current Project), as Linear's search and compose.
- **The Organisation menu**: Settings (G then S: an admin's Organisation,
  `/settings/organisation/members`; anyone else's Account), Invite and manage Members (admins,
  `/settings/organisation/members`), Switch Organisation (O then W) and Log out (⌥⇧Q), each key
  in muted text at the right. Switch Organisation's submenu heads with the Member's email, lists
  `me.organisations` (Local, which leaves it out, shows the current one), the current one ticked and
  the others disabled since /v1 has no switch; then, after a line, Account settings (`/settings/account`).
- **Inbox, My work**, then **Projects**: the Projects the Member is in (`me.projects`), and the
  current Project when the Member is not in it, each a row (mark, name, chevron) unfolding onto
  Tasks, Workflow, Agents (its live count), Activity, Settings. The current Project unfolds whenever
  it becomes current; what else is unfolded or folded is remembered by the browser
  (`darkory.sidebar.projects`). "+ New Project" ends the group for admins. The address decides the
  current Project; ⌘K lists every Project to switch to.
- On a phone the same sidebar is the sheet the TopBar's button opens; a link followed in it, or in
  its menus, closes it.

## Page frame

Every page renders `TopBar` first, then `Content`, from `@/app/TopBar`. A Project's pages lead
with the Project (`projectCrumb(project)` from `@/app/crumbs`):

```tsx
<TopBar
  crumbs={[projectCrumb(project, false), { label: "Tasks" }]}
  view={<ListBoardSwitch />}            // the segmented switcher, after the crumbs
  actions={<><FilterButton /><DisplayButton /></>}
  primary={<Button><PlusIcon />File Task<Kbd>C</Kbd></Button>}   // the screen's one primary
/>
<Content pad>…</Content>                 // scrolls; `pad` is the kit's 20px × 24px
```

A Task's page: `[projectCrumb(project), { label: "Tasks", to: projectPath(project, "tasks"), wide: true }, { label: key }]`.
Settings' pages: `[{ label: "Settings" }, { label: project.name }, { label: "Workflow" }]`.

The first crumb reads strong (the area), the rest muted. On a phone the TopBar carries the button
that opens the sidebar (Settings' nav, in Settings). Nothing may make the page scroll sideways at
390px: let wide things (a kanban, a canvas) scroll inside `Content`, and give text
`min-w-0`/`truncate`.

## Shell services

- **The Project** (`@/app/currentProject`): under `/projects/:key/…` and
  `/settings/projects/:key/…` a page calls `useRouteProject()` (the `Project`; `ProjectScope` has
  already refused a key that names none). Anywhere, `useCurrentProject()` is the Project the app is
  in: the address's, else the one a Task's page or peek reported, else the one last shown in this
  browser, else the Member's first, else the Organisation's first. A Task's page and peek call
  `useReportProject(task.project_id)` so the current Project follows the record. Addresses:
  `projectPath(project, "tasks" | "workflow" | "agents" | "activity", view?)`,
  `projectSettingsPath(project, "general" | "workflow" | "members" | "labels" | "workspaces")`,
  `findProject(projects, idOrKey)`.
- **Intents** (`@/app/intents`): `sendIntent(intent)`, `useIntent(kind, handler)`; the DOM event
  is `darkory:intent`.
  - `{ kind: "file-task", project?, step?, parent?, title? }`: C, ⌘K and the Install checklist
    send it with the current Project's key; a board column's + adds `step` (a Step id), a Parent's
    "Add Subtask" `parent` (a key), ⌘K's unmatched words `title`. `BoardDialogs` answers it.
  - `{ kind: "new-project" }`: "+ New Project" under the sidebar's Projects, ⌘K, Settings and the
    checklist; the shell's New Project dialog answers it.
  - `{ kind: "focus-projects" }` (G P: the current Project's row in the sidebar takes the focus),
    `{ kind: "switch-organisation" }` (O W: the Organisation menu opens on Switch Organisation),
    `{ kind: "log-out" }` (⌥⇧Q and the menu's Log out; the shell answers it), `{ kind: "search" }`
    (the sidebar's Search button), `{ kind: "filter" }` (F, a page's Filters menu).
- **Peek** (`@/app/peek`): `usePeekLink()(key)` is a `To` for the current page with `?task=key`
  added (other parameters stay); link a row to it. The shell mounts `TaskPeek` while the parameter
  is there; `usePeek()` gives `{ taskKey, close }`. A link with the hash `sessionAnchor`
  (`#session`) opens the Task scrolled to its Session panel, and the location state
  `{ join: true }` joins an admin to its terminal (the agent's peek's Join).
- **Toasts**: `import { toast } from "sonner"`; the shell mounts the Toaster. A refused drag is a
  toast naming the rule ("Only builder, or whoever may take it back, moves WEB-17").
- **Keys** (`shortcutList` in `@/app/shortcuts`, which the ? sheet lists), and no others: ⌘K /
  Ctrl K search, C file a Task, G then P the current Project's row in the sidebar, G then I / M the
  Inbox and My work, G then T / B / W / A the current Project's Tasks, board, Workflow and Agents,
  G then S Settings (an admin's Organisation, anyone else's Account), O then W Switch Organisation, ⌥⇧Q (Alt Shift Q) Log out, ? the shortcuts;
  on a list of Tasks J / ↓ and K / ↑ move the ring, Enter opens the ringed Task's peek, Esc closes
  it and returns the focus to its row, and with the peek open J and K move it along the list. They
  are ignored while typing, while a dialog or a menu is open, and while a card is carried; the
  peek is not modal and does not count. An element marked `ownsKeysAttr` (`data-owns-keys`,
  `@/lib/keys`), the Session panel's terminal, takes every key while it has the focus, ⌘K and Esc
  included: the shell ignores them and the Peek does not close.
- **Selection** (`@/app/selection`): a page joins the walk by marking each Task row or card
  `data-task={key}` inside `#main`, in the order it shows them, and drawing the ring
  (`ring-2 ring-ring`) where `useSelectedTask() === key`: the Task walked to or focused, or the
  one whose peek is open.
- **Live data**: every query key's first element names what it reads (`src/api/queries.ts`); an
  Activity entry marks the matching queries stale, so open views refetch without reloading. Put a
  new query under an existing root (`["tasks", …]`) and it stays live. Screens share one cache:
  a key holds one shape everywhere. Reading the same endpoint into a different shape takes its
  own key under the root (`[...keys.takeable, { ids: true }]`) or `select`, never the shared key
  with another `queryFn`. Which subject refreshes which roots:

  | Subject | Roots it marks stale |
  |---|---|
  | `task` | `tasks`, `task`, `takeable`, `workflow` (a Step's open and worked counts), `runner` |
  | `workflow` | `tasks`, `task`, `takeable`, `workflow` |
  | `label` | `labels`, `tasks`, `task` |
  | `project` | `me`, `members`, `member`, `tokens`, `projects`, `project`, `skills`, `skill`, `skill-versions`, `takeable`, `workflow` |
  | `member`, `skill` | the same, and `task` (`member` also `runner`) |
  | `token`, `session` | all of those (`session` also `runner`) |
  | `workspace` | all of those, and `workspaces` |
  | `login_link` | nothing |

  `activity` and `health` are never marked stale; `views` only by this tab's own writes. A
  mutation run through `useMutation` refetches every other query on success (`queryClient.ts`).
- **Shared reads** in `@/api/queries` (key in brackets):
  `useMe` (`["me"]`), `useMembers` (`["members"]`), `useMember(ref)` (`["member", ref]`),
  `useTokens(member)` (`["tokens", member]`), `useMemberSessions(member)` (`["member", member, "sessions"]`),
  `useProjects` (`["projects"]`, every Project by name), `useProject(ref)` (`["project", ref]`, with its Members),
  `useWorkflow(project)` (`["workflow", project]`, the Steps with `tasks`, `working`, `takers`, `median_ms`, and the Connectors),
  `useLabels()` (`["labels"]`, the Organisation's), `useLabels(project)` (`["labels", { project, carried: true }]`, the Project's own then the Organisation's),
  `useProjectLabels(project)` (`["labels", { project }]`, its own),
  `useSkills` (`["skills"]`), `useDirectory()` (Members, Projects and Skills by id, and as lists),
  `useTasks(query)` (`["tasks", query]`, every page; `query` is `GET /v1/tasks`'s parameters, `filter` tokens included),
  `useOpenTasks` (`["tasks", { state: "open" }]`), `useAllTasks(enabled)` (`["tasks", { all: true }]`, ⌘K),
  `useAnyTask` (`["tasks", { any: true }]`, the checklist), `useTask(ref)` (`["task", ref]`, the `TaskDetail`),
  `useTakeable` (`["takeable"]`), `useActivity(query)` (`["activity", query]`, the newest page),
  `useViews(entity, project?)` (`["views", { entity, project }]`), `useWorkspaces` (`["workspaces"]`),
  `useRunnerSessions` (`["runner", "sessions"]`: `{ runner, items }`) and `useRunnerSession(taskId)`.
  Name Projects by key in keys (the route's), Members and Skills by id.
- **Writes** in `@/api/writes`, one per /v1 operation, for every screen: Projects (`createProject`, `updateProject`, `addProjectMember`, `removeProjectMember`), `setWorkflow`, Members (`createMember`, `updateMember`, `deactivateMember`, `reactivateMember`, `grantSkill`, `revokeSkill`, `setManager`, `clearManager`), `createSkill`, agents (`setAgentSettings`, `clearAgentSettings`), credentials (`issueToken`, `revokeToken`, `issueLoginLink`, `closeSession`), Workspaces (`createWorkspace`, `updateWorkspace`, `removeWorkspace`), Labels (`createLabel`, `updateLabel`, `deleteLabel`), `fileTask`, `logout`. A Task's own actions stay with its screens. `ApiError.detailList("outcomes")`
  reads the outcomes `no_connector` and `use_advance` carry; `isRefusal(err, ...codes)`.
- `@/work`: `liveClaim`, `boundTo`, `atHold` (a Task at a Step with no Skill), `liveAgents`,
  `taskWorkGlyph(task, now, kindOf, session?)` (a Task record's WorkGlyph: ended, a Parent's
  progress from `subtask_counts`, its live Claim, blocked, at a hold, waiting), `kindLabel` (the
  pill on a Breakdown, an Acceptance or a Retrospective whose title does not say it).

## Tests' fixtures

`src/test/fixtures.ts`: Members `ada` (admin), `bob`, `builder` (agent); Projects `ops` (OPS) and
`web` (WEB); Skills `engineer`, `review`, and the builtin `breakdown`, `acceptance`, `retro`,
`skillReview`; `workflow(project?)`, `init`'s default Workflow with its compact layout, its Step
ids in `step` (`step.build` is `"st-build"`; another Project's are prefixed with its key); `label`,
`bug` (the Organisation's), `clientX` (WEB's); `task(n, extra)` (WEB-n waiting at Build),
`parentTask(n, counts)`, `subtask(n, parent)`, `detail(task, extra)` (a `TaskDetail` with its Step
and Connectors); `memberDetail(member, extra)` (in WEB, holding engineer); `skillVersion(skill, version?, body?)`;
`me(member, { organisations? })`; `signedIn(member)`, which answers every read the shell makes, each
Project's detail, Workflow and own Labels, each Member's record (no tokens or Sessions) and each
Skill with its version 1 included.

## Primitives (`src/components/`)

| Component | Kit | Use |
|---|---|---|
| `MemberAvatar member size working card` | `.av` | `sm` 20px (rows, cards), `md` 28px (sidebar), `lg` 40px (a Member page). Every Member round, initials on one of eight muted tints picked by its name (`tintOf` in `@/lib/members`), so two "RT"s differ, in a ring: a plain line for a human, the AI gradient (`--agent-gradient`) for an agent (`.avatar-tint` in `globals.css`); named for screen readers ("builder-1 (agent)"), `data-kind` says which. `working` is for a standalone mark (Agents page, a canvas or graph node) whose Member works: `running` turns an agent's ring (1.6 s), `waiting` / `stalled` / `ending` stop it amber / red / grey, `held` (a human's live Claim) is a still ring in the human ink. Reduced motion stops the turning. A row or a card says the same with its WorkGlyph instead. A mark whose Member has an `id` opens their hover card (`MemberCard`: kind and Admin, the Tasks they hold and their session state for how long, Skills, an agent's model, Reports to, Reports, Projects, an admin's Open profile) after 300 ms of hover, on focus or on a tap; standing alone it is a tab stop, inside a button or link it opens on hover only, inside a menu option or picker row never. Pass `card={false}` for a picker's icon or the Member's own page; `MemberCards` (`memberCards.ts`) turns cards off for a subtree of samples. |
| `WorkGlyph glyph label` | `.st` | A Task's derived state at 14px: `waiting` ○, `working` (an agent's AI-gradient ring turning while its session runs, stopped in the session's colour otherwise; a human's still ring with a dot), `blocked` ⊘, `hold` (dashed), `done` ✓, `dropped` ✕, `parent` (a progress ring: done green and dropped grey, of all its Subtasks). `glyphFor({state, held, holderKind, session, blocked, atHold, counts})` in `@/lib/work` picks it: ended, then Parent, then held, then blocked, then hold, then waiting; `taskWorkGlyph` in `@/work` reads it off a Task record. |
| `Pill tone` | `.badge` | `waiting · claimed · blocked · done · dropped · agent` (ink on a tint), `outline` (a Skill name), `secondary` (a Task kind, a fact), `destructive`. At most two words; a dimmed row's pill says why. |
| `Key to?` | `.key` | `WEB-3` in mono; a link with `to`. |
| `ProjectMark project size` | `.team-dot` | A Project's lettered square, coloured by its key: `sm` 14px (rows, crumbs), `md` 20px, `lg` 28px. |
| `PageHeader title mark meta actions` | `.page-h1` | The head of a record page. `SectionHeader title count actions` heads a section. |
| `PropertiesRail compact` + `Property label stack` + `PropertyButton` | `.props`, `.prop-btn` | A record's facts: label column, value column. `compact` for the 300px rail. |
| `Peek open onOpenChange label heading menu actions` | `.sheet` | The 560px sheet from the right with the key, the ⋯ menu (pass `DropdownMenuItem`s as `menu`) and ×. Not modal: no scrim, the page beside it keeps working; Esc and × close it. |
| `FormDialog title description hint submitLabel onSubmit pending error size` + `FormRows`, `FormRow label htmlFor help` | `.dialog`, `.dform` | A dialog that does one thing: one label column, one control column (320px), Cancel and the one primary; the refusal shows above the footer. `size` `sm` 480 · `md` 560 · `lg` 600. |
| `Timeline` + `TimelineDay` + `TimelineRow who when` + `SystemMark` | `.tl` | Activity and a Task's record. `SystemMark` stands for Darkory when no Member acted (a lapse). |
| `EmptyState icon title action` | `.empty` | A heading of at most three words and the one next thing. |
| `InfoPopover label anchor side align` | `.info` | ⓘ: where explanations go, so the screen stays label + number + pill. `anchor` (a ref), `side` and `align` open it beside what it explains rather than over it. |
| `HeartbeatMeter claim variant` | `.hb` | `bar` (peek, Agents): "lapses in 15 min" with the time left as a bar; `compact` (a card, a row): pulse + "lapses in 15 min". The exact lapse time on hover. No expiry, Lapsed. |
| `Refusal error`, `Loaded query` | | A refusal with its stable code; a query's data, skeleton or refusal. |
| `Time`, `ClockTime`, `DayTime what`, `RelativeTime` | | "6 Oct 2026, 22:18"; "22:18"; a table's time column, "22:18" today and "6 Oct" before, its hover naming the field ("Waiting since …"); "in 4 minutes". |
| `Copy value label` | | Any value with a copy button at its end: the button shows on hover or keyboard focus in space kept for it (nothing moves), copies `value`, and shows a check for 1.5 s; aria-label "Copy <label>". Inline or in a table cell, where the value wraps. Use it for every id, token or key a person copies; children show the value (itself by default). |
| `CopyValue value what`, `SessionId id` | | `CopyValue`, older: a value in mono that copies itself on click, whole on hover (a branch). `SessionId` shows a Session id whole, in mono, in a `Copy`. Ids are short (22 characters, ADR 0017), so they are never cut. |
| `LabelPill label`, `LabelPills ids labels`, `LabelDot label` | | A Label: its colour as a dot (the record's own colour, through the CSSOM), then its name in a round outline; `LabelPills` draws a Task's by name, those that still exist. Rows, cards, a Task's head, Settings › Labels, the Filter. |
| `PillsFit names` | `.badge` | Skill pills on one line: as many whole ones as fit, then "+N" naming the rest on hover. |
| `RunnerSessionBadge session bare state` | | The Runner's session on a Task as one line: "Session [Running] started 04:25 · mac-mini"; `bare` leaves out "Session" under a Session column, `state={false}` the pill beside a State column (Agents). |
| `SessionFacts session agent` | | A runner session's facts in one line: the agent, started, its state, the host, `tmux dk-WEB-12` or "no tmux". |
| `SessionStatePill state` | `.badge` | A runner session's state: Running (done tone: working, Heartbeats going), Waiting (claimed: its turn ended without a decision and the Runner nudges it, or it shows a dialog a person answers by joining), Stalled (blocked: no progress, no more Heartbeats, the Claim lapsing; the Heartbeat meter empties), Ending (dropped). Its title says which. |

## Canvases (`src/components/workflow/`)

Model v2's Workflow drawn on React Flow (`@xyflow/react` 12, its `base.css` bundled from
`globals.css`, its look from the tokens in `globals.css`). Presentational: the parent holds the
record and sends every change; the canvases read only these shapes (`model.ts`, `graph.ts`), which
M4 binds `/v1` to.

| Component | Use |
|---|---|
| `WorkflowCanvas workflow mode` | `Workflow = {steps, connectors}`; `Step = {id, name, skill?: {id, name}, position, x, y, takers: {id, name, kind, working?}[], tasks, working, medianMs?}`; `Connector = {id, from, to: stepId or null (Done), name, position}`. A Step node shows its name, Skill (or "Hold", drawn dashed), takers as stacked marks, "N waiting · M working", and "No Member has it" in amber when it carries a Skill nobody holds; Done and Dropped stand fixed right of the Steps, Dropped with a dashed "from any Step" arrow. Connectors are routed at right angles round the nodes (`route.ts`), the outcome named where the line leaves its Step; a Connector back leaves by the left and enters from below or above. `live` (Project › Workflow): read-only, takers ringed by `working`. `edit` (Settings › Workflow): `onSelect(step or null)`, `onMove(step, x, y)` on a drop or an arrow key, `onAddStep(from, at?)` from "+" or a connection let go on the canvas, `onAddConnector({from, to})`, `onConnectorChange(connector, {from, to})` when an end is dragged, `onDeleteStep(step, moveTo?)`, `onDeleteConnector(connector)`, `onLayout(positions)` from Tidy up (`tidy` in `layout.ts`: dagre, left to right, 240px between ranks, a Step node 208×88). What `/v1` would refuse (into Dropped, into its own Step, deleting a Step whose Tasks have nowhere to go) is said in words and not sent (`connectProblem`, `deleteProblem`). Its own minimal panel (name, Skill, Connectors out, Delete) stands in for M4's. |
| `SubtaskGraph steps subtasks onOpen` | A Parent's Subtasks over its Project's Steps: `GraphSubtask = {id, key, title, stepId or null, state, holder?, working?, aimedAt?, blockedBy (open blockers' ids), kind}`. A column per Step holding an open Subtask, in the Workflow's order, then "With <member>" per Member one is aimed at, then Done · Dropped; inside a column, a Subtask one layer right of what blocks it there; one row grid, a Subtask on its blocker's row when free (`layoutSubtasks` in `graph.ts`). Blocking arrows at right angles through gutters and row gaps, never across a node. Takeable now (open, unheld, unblocked, at a Step with a Skill or aimed at a Member) highlighted and marked Takeable; worked as is, its holder's mark ringed; the rest dimmed. Drawn full size, scrolling sideways in its box; a click is `onOpen(id)`. |

`/dev/design` (served by `npm run dev` only, no sign-in) draws the marks, the WorkGlyph set, both
canvas modes and a Subtask graph from `samples.ts`; the editing canvas lists the callbacks it
receives. `npm run lab` (Playwright against `vite dev`) shoots it at 1440×900 and 390×844 in light
and dark into `e2e/screenshots/`, and checks the drags, the turning ring and the phone width.
`e2e/settings.lab.ts`, in the same run, shoots the shell and every Settings page on a mocked `/v1`
(`page.route`, the Activity stream held open by a stand-in) and fails on a console error or a
page wider than the phone.

shadcn/ui components are in `src/components/ui/` (sidebar, button, badge, avatar, sheet, dialog,
dropdown-menu, popover, command, tabs, table, switch, select, input, textarea, tooltip, hover-card, separator,
scroll-area, skeleton, kbd, sonner, collapsible, label, checkbox, radio-group), tuned to the kit's density: buttons are
32px (`default`), 36px (`md`, a dialog's primary), 26px (`xs`, inside rows); `icon`, `icon-xs`.
Add more with `npx shadcn@latest add <name>` from `web/`, then check its imports use `@/lib/utils`
(it may write `from "cn"` and add a `cn` package to `package.json`: undo both).

## The Session panel and its terminal

While the Runner (`CONTEXT.md`) runs an agent's session on a Task, the Task's peek and page show
a **Session panel** (`src/screens/task/SessionPanel.tsx`) between the facts and the record:

- **Facts** (`SessionFacts`), then the **shell line** `darkory join WEB-12` with a copy button (the
  clipboard, or, where the browser refuses it, the line selected and "Selected · press ⌘C").
- **The terminal**: xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, pinned), loaded in its own chunk
  when a panel first shows one, 13px mono, coloured from the tokens (`--background`,
  `--foreground`, `--ring` for the selection) and following light and dark. Under it a 36px line
  says what it is doing: Connecting…, "Read-only · admins can join" (not an admin), "Read-only ·
  Join to type" (an admin), "Joined · your keys go to the session", or "The terminal closed"
  with Reconnect. A session without tmux opens no terminal and says it cannot be joined.
- **Join and Leave** (admins, the section's one button): Join reconnects read-write and gives
  the terminal the focus; Leave reconnects read-only. The ⋯ menu gains **Nudge** and **Stop
  session** for admins (`SessionActions.tsx`; Stop confirms, naming the Claim's release).
- **Keys**: the terminal is marked `data-owns-keys`. Focused, it takes every key: watching, Esc
  gives the focus back to the page; joined, Esc goes to the session. Unfocused, J, K, Esc and
  the rest work as everywhere.

The panel shows only while `useRunnerSessions` lists a session on the Task. That read
(`GET /v1/runner/sessions`, `{items, runner}`) is asked every 5 s and on Task, Member and Session
Activity; `runner: false` (no Runner attached) stops it for the page's life, since a Runner
starts only with the server. Nudge, Stop and the terminal still answer `no_runner` then.

**The WebSocket** (`api/openapi.yaml`, `runnerTerminal`; `src/screens/task/terminal.ts`):

| | |
|---|---|
| Address | `ws(s)://<this origin>/v1/runner/sessions/{task key}/terminal`, `?readonly=1` to watch. Same origin, so the cookie authenticates and the server checks the Origin. |
| Who types | Everyone connects with `?readonly=1` first; an admin's Join connects without it. The server keeps every non-admin read-only whatever the URL says. |
| Server → browser | Binary frames: the terminal's bytes (`binaryType = "arraybuffer"`), written to xterm. Text frames are ignored. |
| Browser → server | Binary frames: keys and mouse reports, joined only. A text frame `{"cols": n, "rows": n}` on connecting and after every fit, in both modes. |
| Lifetime | One socket per mode and Reconnect, each from a cleared screen (tmux redraws on attach). Closing the peek, J or K to another Task, or Leave closes it. Refusals come before the upgrade (`no_runner`, `not_found`, `conflict` for no tmux, `forbidden`), which a browser sees only as a close. |

**The CSP.** xterm.js writes the CSS it computes (its theme, the cell size) into `<style>`
elements and a truecolor cell's colour into a `style` attribute, both of which `style-src 'self'`
refuses. `noInjectedStyles` in `vite.config.ts` turns its `<style>` elements into a constructed
stylesheet the document adopts and its style attribute into a CSSOM write, which the policy
allows; xterm's own CSS is in `globals.css`. `csp.test.tsx` fails if the terminal adds either, and
`e2e/session.spec.ts` draws truecolor output under the real policy with no console error. The same
spec runs a real session (`startRunnerInstall` in `e2e/server.ts`: `serve --runner=on` with
`tools/fakeagent` as builder's command): in tmux it watches, joins, types a line the agent reads
and stops it; as a child process it shows the session cannot be joined and stops it.

## Tokens

`src/globals.css` holds the board's `tokens.css` verbatim, shadcn's `.dark` theme with the Darkory
colours lifted for a dark ground (the app follows the system), and the type scale: `text-sm` is
13px (body), `text-xs` 12px, `text-2xs` 11px. Colours are utilities on tokens only, never hex:
`bg-state-blocked-bg text-state-blocked`, `bg-agent-bg text-agent`,
`text-on-solid` (on a solid state fill), `bg-chart-1…5`, `shadow-soft`, `shadow-pop`, `bg-scrim`.
`--agent-gradient` is the AI gradient, a conic gradient of `--agent-stops`; a ring that turns
composes `conic-gradient(from var(--spin), var(--agent-stops))` where it is drawn, with
`animation: mark-spin` turning the registered `--spin`.
Light is the design; check a new screen in dark too.

## Tests

`npm test` (Vitest) renders the whole app with `renderApp(path)` and a mocked `/v1`
(`src/test/api.ts`, `fixtures.ts`; `signedIn()` answers what every page reads). Push Activity with
`FakeEventSource.latest().emit("activity", entry, seq)`. Play the Runner's terminal with
`FakeWebSocket` (`src/test/webSocket.ts`): `latest().open()`, `receive(bytes)`, `serverClose()`,
and read `sent`, `textFrames()` and `typed()`. `npm run e2e` builds the app and runs
`e2e/` against the real binary; it fails on any console error, which is how a refusal by the
Install's Content-Security-Policy shows (no inline `<style>`, no external fonts or scripts).
