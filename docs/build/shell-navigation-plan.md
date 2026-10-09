# Shell and navigation (round 3) — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task, a fresh subagent per task and a code review after each.

**Goal:** The web app after the owner's review of list-first (main d59c069): the shell after Linear (the sidebar flat on the window ground, the page a bordered card), the bar in two lines (where you are, then what the page does), a Project's Workflows always a list that carries its own acts with the editor in the app, and a Project's settings under the Project (the mockup board's direction B, https://claude.ai/artifact/DNm5PuVXwRj6rJPnCLXFA9).

**Architecture:** Web only; nothing changes in `api/openapi.yaml` or in Go. The sidebar kit's `inset` variant gives the shell; `TopBar` keeps its props and draws a second row inside the same `<header>`; the Workflows list page absorbs Settings' list and its acts (each one `PUT …/workflow` of the whole graph, as today); the four Project settings pages move to `/projects/:key/settings/<page>` inside the app frame with a tab row on the bar's second line; every old address redirects.

**Tech Stack:** React 19, react-router 7, TanStack Query, Tailwind 4 + shadcn kit (`web/src/components/ui/sidebar.tsx`), Vitest + Testing Library (jsdom), Playwright against the real binary (`cd web && npm run e2e`).

**Worktree:** `/Users/tuongaz/dev/darkory-wt/shell-nav`, branch `shell-nav` from main d59c069. `web/node_modules` is installed there. Work only there; `main` receives the merge at the end.

**Standing rules (from CLAUDE.md and memory):** never weigh implementation cost; the glossary's words (`CONTEXT.md`) are the only words on screen; terse UI (icons + plain labels, no explanatory sub-lines, hover never moves things); never `go build` at a checkout root without `-o`, never `git add -A`; commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; decisions go in `docs/build/decisions.md`, one line each with the reason; when the build departs from a board frame, log it in `.claude/skills/mockup/SKILL.md` (Corrections log) before changing either.

**How to run things (from the worktree):**
- Unit tests, one file: `cd web && npx vitest run src/app/TopBar.test.tsx`
- All web checks: `cd web && npm run typecheck && npm run lint && npm test` (= `make web-check` from the repo root)
- Playwright, one spec: `cd web && npm run build && npx playwright test e2e/workflows.spec.ts` (the build embeds the web into the binary that `e2e/server.ts` builds; screenshots land in `web/e2e/screenshots/<area>/`, which is git-ignored)
- Playwright, all: `cd web && npm run e2e`

---

## The board, in words (what each task builds to)

- **Shell.** The sidebar sits flat on the window ground (`--sidebar`), with no border. The page is a card: `--background`, a 1px `--border`, radius `rounded-lg`, inset 8px at the top, right and bottom, from `md` up. On a phone the sidebar is a sheet and the page fills the screen (no inset, no radius). App and Settings alike.
- **Bar.** One `<header>` of two rows. Row 1 (44px): the sidebar button on a phone, then the crumbs; the Workflow chip is a crumb (it says which Workflow). Row 2 (40px, only when the page has something for it): the view switch and the scope at the left, the actions and the one primary at the right; a hairline under row 2. A page with nothing for row 2 keeps the hairline under row 1. A phone keeps both rows: the view switch and scope as chips, the actions as icon buttons (labels `hidden sm:inline`), no fold.
- **Workflows.** `/projects/:key/workflows` is always a list, a Project of one included: Workflow · Steps · Waiting · Working · Done today, and for an admin ‹ › (order), ✎ (edit) and 🗑 (delete) on each row from `sm` up, folded into one ⋯ menu per row below `sm`; `+ Workflow` is row 2's primary. Each act is written at once (one `PUT`), said in a toast, as Settings' list did. A row opens the Workflow's page; ✎ opens `/projects/:key/workflows/:workflow/edit`, the editor as built, inside the app frame, with the Changes chip at the left of row 2 and Cancel · Save at the right. Save and Cancel land on the Workflow's page.
- **Project settings.** The sidebar's Settings under a Project opens `/projects/:key/settings/general`; the pages General · Members · Labels · Workspaces are tabs on row 2 (a `<nav aria-label="Project settings">`), the page's actions and primary at the right of the same row. Settings proper (`/settings/*`) keeps Account and the Organisation and loses its Projects group; `/settings/projects/…` redirects.

---

## Task 1: The shell — a flat sidebar and a page card

**Files:**
- Modify: `web/src/app/Shell.tsx` (`Frame`)
- Modify: `web/src/app/AppSidebar.tsx` (the `<Sidebar>` gets `variant="inset"`)
- Modify: `web/src/screens/settings/SettingsLayout.tsx` (its `<Sidebar>` too)
- Modify: `web/src/globals.css` (the dark `--sidebar`)
- Test: `web/src/app/Shell.test.tsx`

**Background.** `web/src/components/ui/sidebar.tsx` is shadcn's sidebar. With `variant="inset"` the provider's wrapper gets `has-data-[variant=inset]:bg-sidebar` (the window ground), the sidebar draws no border, and `SidebarInset` gets `md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm`. The board wants a border, not a shadow, and radius `rounded-lg`.

**Step 1: Write the failing test** — append to `web/src/app/Shell.test.tsx`, inside `describe("the shell", …)`:

```tsx
  it("draws the page as a bordered card beside a flat sidebar, from md up", async () => {
    mockApi(signedIn());
    renderApp("/inbox");
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    expect(sidebar).toHaveAttribute("data-variant", "inset");
    const main = document.querySelector('[data-slot="sidebar-inset"]')!;
    expect(main.className).toMatch(/md:peer-data-\[variant=inset\]:border\b/);
    expect(main.className).toMatch(/md:peer-data-\[variant=inset\]:rounded-lg\b/);
    expect(main.className).not.toMatch(/shadow-sm/);
  });
```

(Use the file's existing helpers — `mockApi`, `signedIn`, `renderApp` are already imported there; check the top of the file and the role the `<Sidebar aria-label="Sidebar">` renders with: shadcn's sidebar is a `<div data-slot="sidebar" …>`, so if `findByRole("complementary")` finds nothing, query `document.querySelector('[data-slot="sidebar"]')` instead.)

**Step 2: Run it** — `cd web && npx vitest run src/app/Shell.test.tsx`. Expected: FAIL (`data-variant` is `sidebar`).

**Step 3: Implement.**

`AppSidebar.tsx`: `<Sidebar aria-label="Sidebar">` → `<Sidebar aria-label="Sidebar" variant="inset">`. `SettingsLayout.tsx`: `<Sidebar aria-label="Settings">` → `<Sidebar aria-label="Settings" variant="inset">`.

`Shell.tsx`, `Frame`:

```tsx
export function Frame({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <>
      {sidebar}
      {/* The page is a card on the window ground from md up: a border, not the kit's shadow; on a phone it fills the screen. */}
      <SidebarInset className="min-w-0 overflow-hidden md:peer-data-[variant=inset]:rounded-lg md:peer-data-[variant=inset]:border md:peer-data-[variant=inset]:shadow-none">
        <UpdateBanner />
        <div id="main" className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </SidebarInset>
    </>
  );
}
```

Check that `cn`/tailwind-merge in `SidebarInset` lets `rounded-lg` and `shadow-none` win over the kit's `rounded-xl` and `shadow-sm` (same variant prefix, so twMerge replaces them). If the kit's classes still apply, edit `SidebarInset` in `sidebar.tsx` to `md:peer-data-[variant=inset]:rounded-lg md:peer-data-[variant=inset]:border` and drop `shadow-sm` there instead — the kit is ours to change, and say so in the commit.

Then look at the shell in the sidebar's collapsed state and the phone sheet: the sidebar's own `bg-sidebar` must still paint the sheet. Run the app (`cd web && npm run dev` against the owner's server is not allowed; use a scratch Install: `go build -o /tmp/dk-shell ./cmd/darkory` after `npm run build`, `init --data <tmp> --no-agents`, `serve --data <tmp> --listen 127.0.0.1:0 --runner=off --no-browser`), or rely on Task 5's visual pass. At least run Playwright `e2e/session.spec.ts` to catch a broken sheet.

**Dark theme.** `.dark` has `--background: oklch(0.145 0 0)` and `--sidebar: oklch(0.205 0 0)`: the ground would be lighter than the card, the inverse of the Linear reference (dark ground, lighter card). Change the dark `--sidebar` to `oklch(0.1 0 0)` so the card is the raised surface, keep `--sidebar-accent: oklch(0.269 0 0)` (the hover fill, visible on both), and note it in the decisions line of Task 5. Check the dark look in Task 5's visual pass (`page.emulateMedia({ colorScheme: "dark" })`).

**Step 4: Run tests** — `npx vitest run src/app/Shell.test.tsx`; then `npm run typecheck && npm run lint`.

**Step 5: Commit** — `git add web/src/app/Shell.tsx web/src/app/AppSidebar.tsx web/src/screens/settings/SettingsLayout.tsx web/src/globals.css web/src/app/Shell.test.tsx` and commit: "Web: the sidebar sits flat on the window ground and the page is a bordered card (the shell after Linear)".

---

## Task 2: The bar in two rows; the fold goes

> **Built (7d9339e + review fixes):** row 2 is `<div role="group" aria-label="Page">`, not a `toolbar` (the row implements no toolbar keyboard pattern and holds a `<nav>` of links in Task 4); tests and e2e query `getByRole("group", { name: "Page" })`. Its view wrapper is `min-w-0 flex-1 overflow-x-auto` so a long view scrolls inside itself and the actions stay at the right. The Workflow page's `LineViewSwitch` is the same three segments at every width (its phone menu went with the fold). Where the text below says toolbar, read group.

**Files:**
- Modify: `web/src/app/TopBar.tsx`
- Delete: `web/src/components/BarFold.tsx`, `web/src/components/useFolded.tsx`
- Modify: `web/src/components/filters/FilterBar.tsx` (`FilterMenuButton` loses `fold`), `web/src/components/filters/ViewsMenu.tsx` (loses `fold`), `web/src/screens/board/ViewMenus.tsx` (`ViewSwitch` loses `fold`; `DisplayMenu` loses `fold`), `web/src/screens/board/TasksPage.tsx` (no `BarFold`, no `more`/`barFold`)
- Modify: labels of the bar's buttons that must hide on a phone: in `ViewsMenu.tsx` the Views button's text, in `FilterBar.tsx` the Filter button's text, in `ViewMenus.tsx` `BarButton`'s label — wrap each visible label in `<span className="hidden sm:inline">` (the `aria-label` stays; check `BarButton` already takes `label` for both), as `File Task` and `Edit` already do.
- Test: `web/src/app/TopBar.test.tsx`, `web/src/screens/board/tasks.test.tsx` (its phone fold cases), `web/src/components/primitives.test.tsx` if it covers the fold
- Playwright: `web/e2e/workflows.spec.ts` test 9 (the fold on a phone) and test 10; `web/e2e/tasks.spec.ts` and `web/e2e/session.spec.ts` where they locate bar buttons

**Step 1: Write the failing tests** in `TopBar.test.tsx` (new `describe("TopBar in two rows", …)`):

```tsx
  it("draws the view, the actions and the primary on a second row inside the header, under the crumbs", () => {
    render(
      <MemoryRouter>
        <SidebarProvider>
          <TopBar crumbs={[{ label: "Inbox" }]} view={<span>View</span>} actions={<button type="button">Filter</button>} primary={<button type="button">Save</button>} />
        </SidebarProvider>
      </MemoryRouter>,
    );
    const header = screen.getByRole("banner");
    const toolbar = within(header).getByRole("toolbar", { name: "Page" });
    expect(toolbar.compareDocumentPosition(within(header).getByRole("navigation", { name: "Breadcrumb" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(toolbar).getByText("View")).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("has no second row when the page has nothing for it", () => {
    render(
      <MemoryRouter>
        <SidebarProvider>
          <TopBar crumbs={[{ label: "Inbox" }]} />
        </SidebarProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
```

**Step 2: Run** — `npx vitest run src/app/TopBar.test.tsx`. Expected: FAIL (no toolbar).

**Step 3: Implement `TopBar`.** Keep the props and the crumb logic (`wide`, `whole`, the phone mark) exactly as they are. Change the markup to:

```tsx
  const second = !!(view || actions || primary);
  return (
    <header className="flex flex-none flex-col border-b">
      <div className={cn("flex h-11 items-center gap-2 px-4", second && "border-b-0")}>
        <SidebarTrigger className="-ml-1.5 text-muted-foreground md:hidden" />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {/* …the crumbs exactly as today… */}
        </nav>
      </div>
      {second && (
        <div role="toolbar" aria-label="Page" className="flex h-10 items-center gap-2 px-4">
          {view && <div className="flex min-w-0 flex-none items-center gap-2">{view}</div>}
          {(actions || primary) && (
            <div className="ml-auto flex flex-none items-center gap-1.5">
              {actions}
              {primary}
            </div>
          )}
        </div>
      )}
    </header>
  );
```

Update the doc comment: "The bar over every screen: where you are on the first row (the crumbs; on a phone the button that opens the sidebar), then, when the page has any, a second row of what the page does: the view switch and the scope at the left, the actions and the one primary at the right." Keep `Content` as is.

**Step 4: Remove the fold.** Delete `BarFold.tsx` and `useFolded.tsx`. In `FilterBar.tsx`, `ViewsMenu.tsx`, `ViewMenus.tsx` remove the `fold` prop, `useFolded`, `foldAnchor`, `foldHide`, `foldClose`, and the `ViewSwitch` fold branch (it is always the two icons / two labels now). In `TasksPage.tsx` remove `more`, `setMore`, `barFold`, the `<BarFold …>`, and pass no `fold`. Grep: `grep -rn "fold\|Fold" web/src --include='*.tsx' --include='*.ts'` must return only `FilterBar.tsx`'s own `folded` (the Filter menu's field list, unrelated) and `AppSidebar.tsx`'s Project folds. Update `web/src/components/README.md` if it names `BarFold`.

Phone labels: `ViewsMenu` "Views", `FilterMenuButton` "Filter", `DisplayMenu` "Display" show the icon alone below `sm` (`<span className="hidden sm:inline">`), their `aria-label`s unchanged (`FilterMenuButton`'s name carries the count — keep that in the `aria-label`, check `filterName` in `web/src/components/filters/names.ts`).

**Step 5: Fix the tests that knew the fold.** `tasks.test.tsx`: find the cases that open the "More" menu (`getByRole("button", { name: /More/ })`) and rewrite them to assert the three buttons are in the toolbar with their labels hidden below `sm` (`hidden sm:inline` on the label span), as `TopBar.test.tsx` does with `phoneHidden`. `primitives.test.tsx`: remove fold cases if any. Run `npx vitest run` (all) and `npm run typecheck && npm run lint`.

**Step 6: Playwright.** `workflows.spec.ts` test 9: replace the fold steps (the `More` menu, `phone-board-filter-folded`) with: on a phone the bar's second row shows the view switch and the Views, Filter, Display icon buttons by name (`getByRole("button", { name: "Views" })` etc. visible) and the File Task primary; shoot `phone-board-bugs` as before. Test 10 stays (the switch is two icons at 390). Then `npm run build && npx playwright test e2e/workflows.spec.ts e2e/tasks.spec.ts e2e/session.spec.ts`. Expected: green.

**Step 7: Commit** — add the changed and deleted files by name (`git add -u web/src web/e2e` is fine here since no binary can be among them; never `-A`) and commit: "Web: the bar is two rows, where you are then what the page does; the phone fold goes".

---

## Task 3: Workflows is always a list with its acts; the editor lives in the app

> **Built (bb81728, 136e5c3, 200aa4b + review fixes):** two calls the plan left open were made at review. (1) A Workflow's page of a Project of one shows its Workflow's name as a plain crumb (Project › Workflows › Work), no chip; before, its last crumb was "Workflows", a link away from itself, while the editor named the Workflow. (2) An address of a Project of one that carries the line's parameters (`view`, `scope`, `step`, `filter.*`) lands on that Workflow's page, in `FromWorkflow` and on the list itself, since round 2 served the page at the list's address and such bookmarks exist. Also: `web/e2e/compare.mjs` (the owner's screenshot script against a seeded Install) resolves the Workflow id via `/v1` and opens the Workflow's page and `/edit`; StepPeek's Edit is named `Edit <step>`; `useWorkflowActs` returns no `workflows`.

**Files:**
- Modify: `web/src/screens/workflow/index.tsx` (`WorkflowsPage`, `WorkflowPage`, the editor pages), `web/src/screens/workflow/WorkflowsList.tsx` (the acts), `web/src/screens/workflow/routeWorkflow.ts` if needed
- Create: `web/src/screens/workflow/useWorkflowActs.ts` (the `act`/`add`/`move`/`delete` logic lifted from `WorkflowsSettings.tsx`)
- Delete: `web/src/screens/workflow/WorkflowsSettings.tsx` (merged into the list)
- Modify: `web/src/app/currentProject.ts` (`workflowsSettingsPath` → `workflowEditPath`; `ProjectSettingsPage` loses `"workflows"`), `web/src/app/routes.tsx` (routes and redirects), `web/src/screens/workflow/StepPeek.tsx`, `web/src/screens/workflow/edit/useEditorWorkflow.ts`, `web/src/screens/settings/SettingsLayout.tsx` (`projectPages` loses Workflows), `web/src/app/CommandMenu.tsx` if it names the editor, `web/src/components/README.md` (screens table rows for `src/screens/workflow/`)
- Test: `web/src/screens/workflow/workflowsList.test.tsx`, `web/src/screens/workflow/workflow.test.tsx`, `web/src/app/workflowsAddresses.test.tsx`
- Playwright: `web/e2e/workflows.spec.ts` tests 6, 12, 13, 14 (and any `goto` of `/settings/projects/…/workflows`)

**Callers that mean "the list" today and must be checked first** (the grep on d59c069):
- `web/src/screens/workflow/index.tsx:126` — the "Workflows" crumb back to the list: keep.
- `web/src/screens/workflow/index.tsx:222` — Save's navigate: `saved && reply.workflows.length > 1 ? workflowsPath(project, saved.id) : workflowsPath(project)` → always `workflowsPath(project, saved?.id ?? shown.id)` (the Workflow's page).
- `web/src/app/CommandMenu.tsx:88`, `web/src/app/shortcuts.ts:189` (G then W), `web/src/screens/inbox/Activity.tsx:415` — "Workflows" means the list: keep.
- `web/src/app/routes.tsx` `FromWorkflow`: a lone `?scope=` goes to the Task's Workflow only `several`; make it go there whenever the Task's `workflow_id` names a Workflow of the Project (drop the `several` condition), since the list no longer stands in for the one Workflow's page. A lone `?step=` already resolves by the Step. With neither, the list.
- Anything else that links to `/projects/:key/workflows` meaning one Workflow's page: `grep -rn 'workflows"' web/src` and read each.

**Step 1: Write the failing tests.**

`workflowsList.test.tsx`: replace `it("is that Workflow's page in place: no list, no chip")` with, under a `describe("the Workflows page of a Project of one")`:

```tsx
  it("lists its one Workflow, with + Workflow and the acts for an admin", async () => {
    serve([], workflowsFixture("one")); // check fixtures.ts for how a one-Workflow graph is built; the old test did it
    renderApp("/projects/WEB/workflows");
    const t = await table();
    expect(within(t).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Page" })).toHaveTextContent("Workflow"); // the + Workflow primary
    expect(within(t).getByRole("button", { name: /^Delete /, hidden: true })).toBeDisabled(); // the last stays
  });
```

And in the `several` describe:

```tsx
  it("adds a Workflow at once and opens its editor with the name to type", async () => { /* click + Workflow; expect one PUT …/workflow whose body.workflows has one more entry named "Workflow 3"; expect the route to be /projects/WEB/workflows/<new id>/edit */ });
  it("moves a Workflow later at once and says where New Tasks start when that changes", async () => { /* ‹ › write one PUT; toast text */ });
  it("asks before deleting, then writes once", async () => { /* 🗑 opens the dialog (DeleteWorkflowDialog); confirm → one PUT */ });
  it("shows a Member who is not an admin the figures and no acts", async () => { /* signedIn(nonAdmin) → no buttons in rows, no primary in the group named Page */ });
  it("opens a Workflow's editor from its row's pencil", async () => { /* ✎ → /projects/WEB/workflows/<id>/edit */ });
```

Port the assertions from the Settings list's existing tests (search `workflow.test.tsx` and `workflowsAddresses.test.tsx` for `/settings/projects/WEB/workflows` and the toast texts "Moved … later", "New Tasks start at …", "Added Workflow", "Deleted …") rather than inventing new wording.

`workflow.test.tsx`: every `renderApp("/settings/projects/WEB/workflows/…")` → `renderApp("/projects/WEB/workflows/<id>/edit…")`; the crumbs assertion becomes `Web/Workflows/<name>` (the Project crumb, then Workflows, then the Workflow); the non-admin case ("shows a Member who is not an admin the list and the panel read-only") keeps its note and its link to the Workflow's page; Cancel and Save land on `/projects/WEB/workflows/<id>`.

`workflowsAddresses.test.tsx`: "lead to Settings' list of the Workflows" → `/settings/projects/WEB/workflows` redirects to `/projects/WEB/workflows`; "carry ?workflow= into the editor's address" → `/settings/projects/WEB/workflow?workflow=…&step=…` lands on `/projects/WEB/workflows/<id>/edit?step=…`; "open a lone ?step= in its own Workflow's editor" likewise; the lone `?scope=` of a Project of one → that Workflow's page (new); "is Workflows in the sidebar, the page's crumb, Settings' nav and the Edit button" → Settings' nav has no Workflows now; the Edit button on a Workflow's page is named `Edit <name>` and leads to `/edit`.

**Step 2: Run** — `npx vitest run src/screens/workflow src/app/workflowsAddresses.test.tsx`. Expected: FAIL.

**Step 3: Implement.**

`currentProject.ts`:
```ts
export type ProjectSettingsPage = "general" | "members" | "labels" | "workspaces";
/** The address of one Workflow's editor (`/projects/:key/workflows/:workflow/edit`), with what else the address says (`step`). */
export function workflowEditPath(project: Pick<Project, "key">, workflow: string, params: Record<string, string> = {}): string {
  return withSearch(`${workflowsPath(project, workflow)}/edit`, params);
}
```
Remove `workflowsSettingsPath`; fix every import (`StepPeek.tsx` → `workflowEditPath(project, step.workflow_id, { [stepParam]: step.id })`; `useEditorWorkflow.ts` → `useGoToWorkflow((w) => workflowEditPath(project, w), …)`).

`useWorkflowActs.ts` — lift from `WorkflowsSettings.tsx` lines 40–110 (`write`, `sending`, `act`, `add`, `move`, the delete handler, `busy`), returning `{ busy, add, move, remove: (w, moves, repoint) => …, graph, workflows, skillMap }`; `add` navigates to `workflowEditPath(project, saved.id)` with `state: { rename: true }`. Keep the comments that explain the one-write-at-a-time guard and the "New Tasks start" toast.

`WorkflowsList.tsx` — takes `admin` and the acts. Columns from `sm` up for an admin: `grid-cols-[minmax(0,1fr)_80px_80px_80px_96px_64px_72px]` (Workflow · Steps · Waiting · Working · Done today · Order · acts), the acts cell holding ✎ (`aria-label="Edit <name>"`, a `Link` to `workflowEditPath`) and 🗑 (`Delete <name>`, disabled when one Workflow remains), the order cell ‹ › as `IconButton`s moved over from `WorkflowsSettings.tsx` (`Move <name> earlier|later`). Below `sm` the Order and acts columns are hidden (`hidden sm:flex`) and one `MoreMenu` (`@/screens/settings/parts`, size `icon-xs`, `aria-label="More for <name>"`) sits in a last 32px column with items Edit · Move earlier · Move later · Delete, the same disabled states. Keep the whole-row link (`after:absolute after:inset-0`) on the name and `relative z-10` on the act cells, as Settings' list did. The header row: `<span className="sr-only">Order</span>`-style headers for the act columns.

`index.tsx` — `WorkflowsPage`: drop `if (graph && graph.workflows.length < 2) return <WorkflowPage />`; keep the `?workflow=` redirect; the bar: `crumbs=[projectCrumb(project), { label: "Workflows" }]`, `primary={admin && <Button onClick={acts.add} disabled={!graph || acts.busy}><PlusIcon />Workflow</Button>}` (its accessible name "Workflow" as Settings' had — check what `workflows.spec.ts` test 6 clicks); no Edit button. Render `<DeleteWorkflowDialog>` as Settings' list did. `WorkflowPage`: `several` may be 1 → no chip for a Project of one (as today); the "Workflows" crumb always links back to the list (`to: workflowsPath(project)`); Edit → `workflowEditPath(project, shown.id)` named `Edit ${shown.name}`. The editor pages: rename `WorkflowSettingsPage` → `WorkflowEditPage` (export both names until routes.tsx is updated in this task, then drop the old), `editorCrumbs` → `[projectCrumb(project), { label: "Workflows", to: workflowsPath(project) }, { label: shown.workflow?.name ?? "…" }]`; `view={<ChangesChip editor={editor} />}` stays (it lands on row 2's left); Cancel → `navigate(workflowsPath(project, shown.id))`, Save → `navigate(workflowsPath(project, saved?.id ?? shown.id))`; the Discard dialog's `onSubmit` likewise. `ReadingPage`'s note keeps linking to `workflowsPath(project, shown.id)`.

`routes.tsx` — under `projects/:key`: add `<Route path="workflows/:workflow/edit" element={<WorkflowEditPage />} />` (import from `@/screens/workflow`). Under `settings/projects/:key`: replace the two workflows routes and the `workflow` route with redirects:
```tsx
<Route path="workflows" element={<ToProjectWorkflows />} />
<Route path="workflows/:workflow" element={<ToProjectWorkflows edit />} />
<Route path="workflow" element={<FromWorkflow settings />} />
```
where `ToProjectWorkflows({ edit })` navigates (replace, keeping `search`) to `/projects/:key/workflows` or `/projects/:key/workflows/:workflow/edit`; and `FromWorkflow` with `settings` resolves as today, then goes to `/projects/:key/workflows/<w>/edit` when it has a Workflow, else the list. `FromAdmin` `"workflow"` → `<ToCurrentProject area="workflows" />`. Drop the `several` condition on the lone `?scope=`.

`SettingsLayout.tsx` — `projectPages` loses `{ page: "workflows", label: "Workflows" }`. `screens/workflow/index.tsx` stops exporting `WorkflowsSettingsPage`; delete `WorkflowsSettings.tsx`.

`README.md` (components) — the `src/screens/workflow/` row: `WorkflowsPage` (`/projects/:key/workflows`, the list with its acts), `WorkflowPage` (`/projects/:key/workflows/:workflow`), `WorkflowEditPage` (`/projects/:key/workflows/:workflow/edit`).

**Step 4: Run** — `npx vitest run` (all), `npm run typecheck && npm run lint`.

**Step 5: Playwright `workflows.spec.ts`.** Test 6 opens `/projects/ACC/workflows` (not Settings), clicks `+ Workflow` (`getByRole("button", { name: "Workflow" })`), expects the URL `/projects/ACC/workflows/[^/]+/edit`, and so on through rename, move, delete with the same assertions; screenshots `list-acts`, `editor-rename`, `editor-outcome-groups`, `list-moved`, `list-delete-asks` (replace the `settings-*` names). Test 12: the crumb back to the list; the Edit button leads to `/edit`. Test 13 becomes "a Project of one Workflow lists it, with + Workflow": one row, the primary, and the row opens the page with no chip. Test 14: the phone list at `/projects/ACC/workflows` has no sideways scroll and a ⋯ per row (`getByRole("button", { name: /^More for / })`) — drop the Settings list shot. Run `npm run build && npx playwright test e2e/workflows.spec.ts`.

**Step 6: Commit** — files by name: "Web: Workflows is always a list that carries its acts; one Workflow's editor lives at /edit in the app; Settings' Workflows pages redirect".

---

## Task 4: A Project's settings live under the Project

**Files:**
- Modify: `web/src/app/routes.tsx` (routes under `projects/:key/settings/*`; `/settings/projects/*` redirects; `FromAdmin` teams/workspaces)
- Modify: `web/src/app/currentProject.ts` (`ProjectArea` gains `"settings"`; `projectSettingsPath` → `/projects/:key/settings/<page>`)
- Create: `web/src/screens/settings/ProjectFrame.tsx` (`ProjectSettingsFrame`)
- Modify: `web/src/screens/settings/ProjectPages.tsx`, `web/src/screens/settings/WorkspacesPage.tsx`, `web/src/screens/settings/LabelsPage.tsx` (`ProjectLabelsPage`) — use the new frame
- Modify: `web/src/screens/settings/SettingsLayout.tsx` (no Projects group, no New Project; `shown`/`open`/`ProjectItem` go), `web/src/screens/settings/index.tsx` (exports), `web/src/app/AppSidebar.tsx` (the Settings `PlaceLink` is `projectSettingsPath(project)` already — confirm it matches `here` for every tab), `web/src/app/CommandMenu.tsx` (`Settings › <project>` → `<project> › Settings`), `web/src/screens/inbox/Agents.tsx:127` (→ `projectSettingsPath(project, "members")`), `web/src/components/README.md` (the `src/screens/settings/` row and the "The Project" paragraph)
- Test: `web/src/screens/settings/project.test.tsx`, `web/src/screens/settings/labels.test.tsx`, `web/src/app/Shell.test.tsx` (the Settings nav cases around line 693, the sidebar's Settings link), `web/src/screens/settings/organisation.test.tsx` (the nav cases at 405/415)
- Playwright: `web/e2e/settings.spec.ts` (every `/settings/projects/…` goto; scenario 10's door, redirects and Mai's nav), `web/e2e/avatar.spec.ts` and `web/e2e/init.spec.ts` where they visit Project settings

**Step 1: Write the failing tests.** In `project.test.tsx` change every `renderApp("/settings/projects/WEB/<page>")` to `renderApp("/projects/WEB/settings/<page>")`, the breadcrumb assertion to `toHaveTextContent("WebSettings")` (the Project crumb's text is its name; check how `projectCrumb` renders — the mark has no text), and add:

```tsx
  it("shows the pages as tabs on the bar, the current one marked", async () => {
    mockApi(routes());
    renderApp("/projects/WEB/settings/members");
    const tabs = await screen.findByRole("navigation", { name: "Project settings" });
    expect(within(tabs).getAllByRole("link").map((l) => l.textContent)).toEqual(["General", "Members", "Labels", "Workspaces"]);
    expect(within(tabs).getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "Labels" })).toHaveAttribute("href", "/projects/WEB/settings/labels");
  });
  it("lands the old Settings address on the Project's", async () => {
    mockApi(routes());
    renderApp("/settings/projects/WEB/workspaces");
    await screen.findByRole("navigation", { name: "Project settings" });
    expect(window.location.pathname).toBe("/projects/WEB/settings/workspaces"); // or however renderApp exposes the router's location; see other redirect tests in workflowsAddresses.test.tsx
  });
```

In `Shell.test.tsx` the Settings-nav cases: Settings' nav lists Account and the Organisation's pages and **no** Projects group (`queryByRole("list", { name: "Projects" })` is null), for an admin and for a Member who is not; the sidebar's Settings link under a Project has `href="/projects/WEB/settings/general"`.

**Step 2: Run** — `npx vitest run src/screens/settings src/app/Shell.test.tsx`. Expected: FAIL.

**Step 3: Implement.**

`currentProject.ts`:
```ts
export type ProjectArea = "tasks" | "workflows" | "agents" | "activity" | "settings";
/** The address of a Project's settings (`/projects/:key/settings/<page>`), its General page unless another is named. */
export function projectSettingsPath(project: Pick<Project, "key">, page: ProjectSettingsPage = "general"): string {
  return `${projectPath(project, "settings")}/${page}`;
}
```

`ProjectFrame.tsx`:
```tsx
const pages: { page: ProjectSettingsPage; label: string }[] = [
  { page: "general", label: "General" }, { page: "members", label: "Members" }, { page: "labels", label: "Labels" }, { page: "workspaces", label: "Workspaces" },
];
/** A Project's settings page: Project › Settings on the bar, its pages as tabs on the second row, the page's acts at the right. */
export function ProjectSettingsFrame({ project, page, actions, primary, pad = true, children }: { project: Project; page: ProjectSettingsPage; actions?: ReactNode; primary?: ReactNode; pad?: boolean; children: ReactNode }) {
  return (
    <>
      <TopBar
        crumbs={[projectCrumb(project), { label: "Settings" }]}
        view={
          <nav aria-label="Project settings" className="flex items-center gap-0.5">
            {pages.map((p) => (
              <Link key={p.page} to={projectSettingsPath(project, p.page)} aria-current={p.page === page ? "page" : undefined}
                className={cn("rounded-md px-2.5 py-1 text-sm font-medium text-muted-foreground hover:text-foreground", p.page === page && "bg-muted text-foreground")}>
                {p.label}
              </Link>
            ))}
          </nav>
        }
        actions={actions}
        primary={primary}
      />
      <Content pad={pad}>{children}</Content>
    </>
  );
}
```
(`projectCrumb` from `@/app/crumbs`; the tab style follows the view switch's `bg-muted` pill — check `ViewSwitch` in `ViewMenus.tsx` and reuse its classes so the two read as one family.)

Replace `SettingsFrame crumbs={crumbs(project, "General")}` etc. with `<ProjectSettingsFrame project={project} page="general">` in `ProjectPages.tsx` (General; Members' loading and loaded frames), `WorkspacesPage.tsx` (`page="workspaces"`, keep `pad={false}` and the primary), `LabelsPage.tsx` `ProjectLabelsPage` (`page="labels"`). Delete the local `crumbs()` helper. The tabs share row 2 with the page's actions and primary at 390px, so every action/primary label on these pages (Members' New agent and Add Member, Workspaces' primary, Labels') hides below `sm` (`<span className="hidden sm:inline">`, the icon and `aria-label` stay), as `File Task` does; the tab `<nav>` wraps nothing and may scroll inside the view wrapper, which is `overflow-x-auto` (and so clips vertically too: give the nav the pill's `p-0.5` so the links' focus rings draw inside it, as the view switches do).

`routes.tsx` — under `projects/:key`:
```tsx
<Route path="settings" element={<Navigate to="general" replace />} />
<Route path="settings/general" element={<ProjectGeneralPage />} />
<Route path="settings/members" element={<ProjectMembersPage />} />
<Route path="settings/labels" element={<ProjectLabelsPage />} />
<Route path="settings/workspaces" element={<ProjectWorkspacesPage />} />
```
Under `settings`: `projects` → `<ToCurrentProject path={(key) => \`/projects/${key}/settings/general\`} />`; `projects/:key` → `<ProjectScope>` with children: `index` → `<Navigate to="general" />`-equivalent redirect to the app (`<ToProjectSettings page="general" />`), `general|members|labels|workspaces` → `<ToProjectSettings page=… />` (replace, keep `search`), plus Task 3's workflows redirects. `FromAdmin`: `teams` → `/projects/<record>/settings/general` or `<ToCurrentProject path={(k) => \`/projects/${k}/settings/general\`} />`; `workspaces` → the Project's `settings/workspaces`. Keep `ProjectScope` for the redirects so a key in another case is still rewritten.

`SettingsLayout.tsx` — remove the Projects group, `ProjectItem`, `useProjects`, `inUrl`/`open`, the New Project item and `sendIntent` import if unused; the comment becomes "Settings' nav: Back to the app page you came from, then Account; the Organisation's pages for admins. A Project's own settings are under the Project in the app."

`CommandMenu.tsx:106` → `{ id: "project-settings", title: \`${project.name} › Settings\`, … run: go(projectSettingsPath(project)) }`.

`README.md` (components): the `src/screens/settings/` row names the Project pages at `/projects/:key/settings/<page>`; the "The Project" paragraph: `projectPath(project, "tasks" | "workflows" | "agents" | "activity" | "settings")`, `projectSettingsPath(project, "general" | "members" | "labels" | "workspaces")`.

**Step 4: Run** — `npx vitest run`, `npm run typecheck && npm run lint`.

**Step 5: Playwright `settings.spec.ts`.** Every `${base}/settings/projects/<KEY>/<page>` → `${base}/projects/<KEY>/settings/<page>`. Scenario 10: the door step expects `/projects/WEB/settings/general` and the tab `General` with `aria-current="page"` (`getByRole("navigation", { name: "Project settings" })`), and no Back step (the sidebar is still the app's; assert the sidebar's Settings link has `aria-current="page"`); the redirects table: `/admin/teams` → `/projects/WEB/settings/general`, `/admin/teams/OPS` → `/projects/OPS/settings/general`, `/admin/workflow` → `/projects/WEB/workflows`, `/admin/workspaces` → `/projects/WEB/settings/workspaces`, `/settings/projects/WEB/workflow` → `/projects/WEB/workflows`, add `/settings/projects/WEB/members` → `/projects/WEB/settings/members`; Mai's step: `nav(mai.page)` has Account and no `list` named Organisation and **no** button named Web; then `mai.page.goto(\`${base}/projects/WEB/settings/general\`)` shows her the settings as text (the existing non-admin rendering) — shoot `17-non-admin-settings` there. Check `avatar.spec.ts` and `init.spec.ts` for Project settings addresses and update. Run `npm run build && npx playwright test e2e/settings.spec.ts e2e/avatar.spec.ts e2e/init.spec.ts`.

**Step 6: Commit** — "Web: a Project's settings live under the Project, its pages as tabs on the bar; Settings keeps the Account and the Organisation; the old addresses redirect".

---

## Task 5: Decisions, docs, the gate, the visual pass, PR and merge

**Files:**
- Modify: `docs/build/decisions.md` (a "Round 3" block under "Named Workflows", plus the strike-through), `docs/build/named-workflows-plan.md` (a "Round 3" pointer paragraph at the end), this plan's "State" line, `web/src/components/README.md` if anything is left

**Step 1: decisions.md.** Strike the Round 2 line that begins `- **A Project of one Workflow shows that Workflow's page at `/projects/:key/workflows`, in place, with no list and no chip…` through with `~~…~~` and append ` Reverted (the owner's call, 2026-10-09): a plural item opens a list, one row included, so the way to a second Workflow is on the page; see Round 3.` — the file's own way (see the Claude-config line near 298). Then add, after the Round 2 lines, one line each with its reason:
- Round 3 (2026-10-09): the shell after Linear — the sidebar flat on the window ground (`--sidebar`), no border; the page a bordered card (radius `rounded-lg`, inset 8px top/right/bottom from `md`); the kit's `inset` variant with a border in place of its shadow; in dark the ground `--sidebar` is darker than the card. Why: the owner's reference ("the content page will have border background while the navigation is not").
- The bar is two rows in one header: where you are, then what the page does; the Workflow chip is a crumb; a page with nothing for row 2 has row 1 alone; a phone keeps both rows with icon-only actions, and the fold of round 2 is gone. Why: "all page related stuff must be on the 2nd line".
- Workflows is always a list and carries its acts (+ Workflow on the bar; ‹ ›, ✎, 🗑 on the row from `sm`, one ⋯ menu per row below), each written at once; the editor is `/projects/:key/workflows/:workflow/edit` in the app; Save and Cancel land on the Workflow's page; a Project of one shows its Workflow's name as a plain crumb on the Workflow's page (no chip, nothing to pick); an address of a Project of one carrying the line's parameters (`view`, `scope`, `step`, `filter.*`) lands on the Workflow's page, not the list; Settings has no Workflows pages, its addresses redirect. Why: the acts lived only in Settings, read as organisation-level, and a plural item landed on one Workflow; the page and its editor must name the same Workflow; round-2 bookmarks of a Project of one carried the line's parameters at the list's address.
- A Project's settings are under the Project at `/projects/:key/settings/<page>`, General · Members · Labels · Workspaces as tabs on row 2 (`nav` "Project settings"); Settings proper is Account + Organisation, its Projects group gone; `/settings/projects/…` and `/admin/teams|workspaces` redirect. Why: a Project's pages in two navs, one swapping the whole sidebar, was the confusion the owner named; one place per Project, Settings for what sits above Projects.

**Step 2: named-workflows-plan.md** — append `## Round 3 (2026-10-09): the shell, the bar, the Project's pages` with two sentences and a pointer to `docs/build/shell-navigation-plan.md`.

**Step 3: The gate, from the worktree root.** `make web-check` (green), `cd web && npm run e2e` (green, all specs), `make check` (green). Go: `git diff --stat main -- '*.go' api/openapi.yaml` must be empty; write that in the PR ("no Go or spec file changed, `make e2e` and `make e2e-pg` results unchanged from d59c069"), or run them.

**Step 4: The visual pass** (the controller does this, not a subagent): build the binary with the web embedded into the scratchpad (`cd web && npm run build && cd .. && go build -o <scratchpad>/bin/darkory ./cmd/darkory`), start a scratch Install (`init --no-agents`, `scripts/seed-workflows.sh` for ACC with five, MAIN with one), sign in with Playwright and shoot at 1440 and 390, light and dark (`emulateMedia`): MAIN › Workflows (one row, + Workflow), MAIN › Workflows › Work (the name as a plain crumb), ACC › Workflows (five, acts; also as a Member who is not an admin, whose phone grid keeps other column widths than the admin's: make them one), the phone list's ⋯ menu open, ACC › Workflows › Bugs (bar rows), ACC › Workflows › Bugs › edit (at 390 too: the Changes chip, Cancel · Save), ACC › Tasks board, MAIN › Settings › General and Members (tabs), Settings › Members (no Projects), the Inbox (row 1 alone), the phone bar on every page that now has a row 2 (Inbox, My work, Agents, Activity, the Task page, the setup checklist, the placeholder, Settings' frame); dark for the editor's Preview and the Blocking graph (they paint `bg-muted` since Task 1's review); the Settings sheet on a phone. Compare with the board frames; log any departure in `.claude/skills/mockup/SKILL.md` before fixing it.

**Step 5: PR and merge.** `git push -u origin shell-nav`; `gh pr create --title "Shell and navigation: a flat sidebar and a page card, a two-row bar, Workflows with its acts in the app, a Project's settings under the Project (round 3)" --body-file <scratchpad>/pr3.md` (the body: the board link, what changes, the checks table, "for the owner" notes, ending with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`); from the main checkout `git merge --no-ff shell-nav -m "Merge shell-nav: …"`, `git push`. The owner's `make dev` needs no migration (web only).

---

## State

Plan written 2026-10-09 on `shell-nav`. Tasks 4–5 pending.

- **Task 3 landed** as bb81728 (+ 136e5c3, 200aa4b for init/avatar specs) + 095aed7 (review fixes). Review: nothing Critical. Important: `web/e2e/compare.mjs` had been left dead on a wrong premise (it can resolve a Workflow id via `/v1`), now fixed; two plan gaps decided by the controller (see the Built note under Task 3: the name crumb for a Project of one; line parameters land on the Workflow's page). Minor, fixed: StepPeek's Edit named `Edit <step>` with a test; stale Settings comments; dead code (`RowActs` component holds the act cells; WorkflowPage's unreachable no-segment fallback dropped, a missing segment is Not found); `useSkills({ enabled })` so non-admins read no Skills; tests for the ⋯ menu's Delete of a Project of one, Save of a Project of one, the `/settings/projects/:key/workflows/:id` → `/edit` row. Findings outside this round, for the PR: `StepPeek` is mounted by nothing since 72aa983 on main (an orphan component; its test renders it directly). The line-parameters rule (`asksForTheLine` in `pickedWorkflow.ts`) is to include `legacyTaskKeys` too (the by-name `?skill=` family meant the line as well); Settings' legacy `/settings/projects/:key/workflow?view=` of a Project of one goes to the list (line parameters mean nothing in the editor), asserted by a test. Unit 1116, Playwright settings/workflow/workflows 24 passed.

- **Task 2 landed** as 7d9339e (the two-row bar, the fold gone) + 5fcf7e0 (review fixes). Review found one Important item: the Workflow page's `LineViewSwitch` still folded into a "View: …" menu below `sm` (its reason, room for the crumbs, was gone), now the same three segments at every width. Minor, all fixed: row 2 is `role="group" aria-label="Page"` (no toolbar keyboard pattern backs a toolbar role, and Task 4 puts a `<nav>` in it); the view wrapper is `min-w-0 flex-1 overflow-x-auto` so a long view scrolls inside itself; a dead `border-b-0` dropped; the components README describes the two rows. Also removed as fold-only: `foldName`, `FilterCount`, the Views/Display controlled open state. Noted: the `<header>` sits inside `<main>` so it is not a banner landmark in the app (pre-existing); e2e and tests find row 2 by `group` named Page. Task 5's 390px pass should look at every page that now has a row 2: Inbox, My work, Agents, Activity, the Task page, the setup checklist, the placeholder, Settings' frame, the Workflows pages.

- **Task 1 landed** as 9d612e5 (the shell) + 173c22c (review fixes). The kit stayed untouched: twMerge lets the Frame's `rounded-lg`/`border`/`shadow-none` win. Review found one Important item: the darker dark `--sidebar` also sat under three in-card surfaces (the editor's Preview strip, the Blocking graph's bands and band labels), which went from raised to sunken; they now paint `bg-muted`, a page surface. Minor: the shell test now covers the Settings shell and pins the inset classes exactly. Noted for later: the desktop collapsed sidebar is unreachable (no keyboard handler, the only trigger is `md:hidden`); Task 5's dark pass should look at the editor Preview and the Blocking graph, and the Settings sheet on a phone.
