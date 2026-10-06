# Web app: the shell, the folders, the primitives

The app is rebuilt to the mockup board (`docs/build/ui-plan.md`, phase W). W1 laid the stack, the
shell and the shared pieces below; W2–W5 build the screens, each in its own folder. Use these
pieces rather than drawing your own, and the words of `CONTEXT.md` only.

## Who owns what

| Folder | Owner | Pages it exports from `index.tsx` |
|---|---|---|
| `src/screens/board/` | W2 Board | `TeamTasksPage` (`/teams/:team/tasks?view=list\|board`), `TeamFeaturesPage` (`/teams/:team/features`), `BoardDialogs` (File Task, File Feature; mounted once by the shell) |
| `src/screens/task/` | W3 Task and Feature | `TaskPage` (`/tasks/:task`), `FeaturePage` (`/features/:feature`), `TaskPeek` (`?task=<key>` over any page) |
| `src/screens/inbox/` | W4 Inbox | `InboxPage` (`/inbox`), `MyWorkPage`, `AgentsPage`, `ActivityPage` |
| `src/screens/admin/` | W5 Admin | `AdminLayout` (`/admin/*`, admins only), `MembersPage`, `MemberPage`, `TeamsPage`, `TeamPage`, `SkillsPage`, `SkillPage`, `WorkflowPage`, `AccountPage` (`/account`) |
| `src/app/`, `src/components/`, `src/lib/`, `e2e/` | W1 | the shell, the route table, the primitives, the smoke suite |

`src/app/routes.tsx` is the only file that imports the screens. Keep each export's name; put
anything else a screen needs (sub-components, hooks, its own queries, its tests) inside its folder.
If a screen needs a new route or a change to the shell, say so rather than editing `src/app`.

The old views live in git history: `git show 07e64b4:web/src/views/TaskView.tsx` and so on.

## Page frame

Every page renders `TopBar` first, then `Content`, from `@/app/TopBar`:

```tsx
<TopBar
  crumbs={[{ label: team.name, icon: <TeamMark team={team} /> }, { label: "Tasks" }]}
  view={<ListBoardSwitch />}            // the segmented switcher, after the crumbs
  actions={<><FilterButton /><DisplayButton /></>}
  primary={<Button><PlusIcon />File Task<Kbd>C</Kbd></Button>}   // the screen's one primary
/>
<Content pad>…</Content>                 // scrolls; `pad` is the kit's 20px × 24px
```

The first crumb reads strong (the area), the rest muted. On a phone the TopBar carries the button
that opens the sidebar. Nothing may make the page scroll sideways at 390px: let wide things
(a kanban) scroll inside `Content`, and give text `min-w-0`/`truncate`.

## Shell services

- **Intents** (`@/app/intents`): `sendIntent({ kind: "file-task", team, status?, feature? })` (a
  Status id and a Feature key or id to start in) and `{ kind: "file-feature", team }`.
  The shell sends `file-task` for the C key and ⌘K; the Install checklist and ⌘K send
  `file-feature`. `useIntent("file-task", (i) => …)` receives them; `BoardDialogs` answers both.
  The DOM event is `darkory:intent`.
- **Peek** (`@/app/peek`): `usePeekLink()(key)` is a `To` for the current page with `?task=key`
  added (other parameters stay); link a row to it. The shell mounts `TaskPeek` while the parameter
  is there; `usePeek()` gives `{ taskKey, close }`.
- **Current Team** (`@/app/currentTeam`): `useCurrentTeam()` (the Team in the URL or of the
  record shown, else the one last shown in this browser); a Task's or Feature's page calls
  `useReportTeam(team.key, "tasks" | "features")` so the sidebar opens that Team and marks the
  list the record sits in; `teamTasksPath(team, "board")`,
  `teamFeaturesPath(team)`.
- **Toasts**: `import { toast } from "sonner"`; the shell mounts the Toaster. A refused drag is a
  toast naming the resolving action ("Claim WEB-17").
- **Keys** (`shortcutList` in `@/app/shortcuts`, which the ? sheet lists), and no others: ⌘K /
  Ctrl K search, C file a Task, G then I / M / A / B the Inbox, My work, Agents and the last
  Team's board, ? the shortcuts; on a list of Tasks J / ↓ and K / ↑ move the ring, Enter opens the
  ringed Task's peek, Esc closes it and returns the focus to its row, and with the peek open J and
  K move it along the list. They are ignored while typing, while a dialog or a menu is open, and
  while a card is carried; the peek is not modal and does not count.
- **Selection** (`@/app/selection`): a page joins the walk by marking each Task row or card
  `data-task={key}` inside `#main`, in the order it shows them, and drawing the ring
  (`ring-2 ring-ring`) where `useSelectedTask() === key`: the Task walked to or focused, or the
  one whose peek is open.
- **Live data**: every query key's first element names what it reads (`src/api/queries.ts`); an
  Activity entry marks the matching queries stale, so open views refetch without reloading. Put a
  new query under an existing root (`["tasks", …]`) and it stays live. Screens share one cache:
  a key holds one shape everywhere. Reading the same endpoint into a different shape takes its
  own key under the root (`[...keys.takeable, { ids: true }]`) or `select`, never the shared key
  with another `queryFn`.
- **Shared reads** in `@/api/queries`: `useMe`, `useMembers`, `useTeams`, `useSkills`,
  `useDirectory` (by id), `useOpenTasks` (every open Task: the sidebar's live count),
  `useAllTasks`, `useAllFeatures` (⌘K). `@/work`: `liveClaim`, `boundTo`, `liveAgents`,
  `taskGlyph` (by state, until Statuses reach `/v1`).

## Primitives (`src/components/`)

| Component | Kit | Use |
|---|---|---|
| `StatusGlyph glyph` | `.st` | `backlog · todo · inprogress · inreview · done · dropped`. `glyphFor(kind, nthOfKind)` in `@/lib/status` maps a Status kind to a glyph: the first In-progress Status draws half full, later ones (In review) three quarters. |
| `MemberAvatar member size` | `.av` | `sm` 20px (rows, cards), `md` 28px (sidebar), `lg` 40px (a Member page). Round initials for a human, square violet for an agent; named for screen readers ("builder-1 (agent)"). |
| `Pill tone` | `.badge` | `waiting · claimed · blocked · done · dropped · agent` (ink on a tint), `outline` (a Skill name), `secondary` (a Task kind, a fact), `destructive`. At most two words; a dimmed row's pill says why. |
| `Key to?` | `.key` | `WEB-3` in mono; a link with `to`. |
| `TeamMark team size` | `.team-dot` | A Team's lettered square, coloured by its key. |
| `PageHeader title mark meta actions` | `.page-h1` | The head of a record page. `SectionHeader title count actions` heads a section. |
| `PropertiesRail compact` + `Property label stack` + `PropertyButton` | `.props`, `.prop-btn` | A record's facts: label column, value column. `compact` for the 300px rail. |
| `Peek open onOpenChange label heading menu actions` | `.sheet` | The 560px sheet from the right with the key, the ⋯ menu (pass `DropdownMenuItem`s as `menu`) and ×. Not modal: no scrim, the page beside it keeps working; Esc and × close it. |
| `FormDialog title description hint submitLabel onSubmit pending error size` + `FormRows`, `FormRow label htmlFor help` | `.dialog`, `.dform` | A dialog that does one thing: one label column, one control column (320px), Cancel and the one primary; the refusal shows above the footer. `size` `sm` 480 · `md` 560 · `lg` 600. |
| `Timeline` + `TimelineDay` + `TimelineRow who when` + `SystemMark` | `.tl` | Activity and a Task's record. `SystemMark` stands for Darkory when no Member acted (a lapse). |
| `EmptyState icon title action` | `.empty` | A heading of at most three words and the one next thing. |
| `InfoPopover label` | `.info` | ⓘ: where explanations go, so the screen stays label + number + pill. |
| `HeartbeatMeter claim variant` | `.hb` | `bar` (peek, Agents): "in 15 min" with the time left as a bar; `compact` (a card): pulse + "15 min". No expiry, Lapsed. |
| `Refusal error`, `Loaded query` | | A refusal with its stable code; a query's data, skeleton or refusal. |
| `Time`, `ClockTime`, `RelativeTime` | | "6 Oct 2026, 22:18"; "22:18"; "in 4 minutes". |

shadcn/ui components are in `src/components/ui/` (sidebar, button, badge, avatar, sheet, dialog,
dropdown-menu, popover, command, tabs, table, switch, select, input, textarea, tooltip, separator,
scroll-area, skeleton, kbd, sonner, collapsible, label), tuned to the kit's density: buttons are
32px (`default`), 36px (`md`, a dialog's primary), 26px (`xs`, inside rows); `icon`, `icon-xs`.
Add more with `npx shadcn@latest add <name>` from `web/`, then check its imports use `@/lib/utils`.

## Tokens

`src/globals.css` holds the board's `tokens.css` verbatim, shadcn's `.dark` theme with the Darkory
colours lifted for a dark ground (the app follows the system), and the type scale: `text-sm` is
13px (body), `text-xs` 12px, `text-2xs` 11px. Colours are utilities on tokens only, never hex:
`bg-state-blocked-bg text-state-blocked`, `bg-agent-bg text-agent`, `border-agent-border`,
`text-on-solid` (on a solid state fill), `bg-chart-1…5`, `shadow-soft`, `shadow-pop`, `bg-scrim`.
Light is the design; check a new screen in dark too.

## Tests

`npm test` (Vitest) renders the whole app with `renderApp(path)` and a mocked `/v1`
(`src/test/api.ts`, `fixtures.ts`; `signedIn()` answers what every page reads). Push Activity with
`FakeEventSource.latest().emit("activity", entry, seq)`. `npm run e2e` builds the app and runs
`e2e/` against the real binary; it fails on any console error, which is how a refusal by the
Install's Content-Security-Policy shows (no inline `<style>`, no external fonts or scripts).
