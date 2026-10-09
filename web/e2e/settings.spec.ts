import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall, type Install } from "./server";

// The Settings area and a Project's settings against the real binary (docs/build/model-v2-plan.md,
// scenario 10, and the journeys Admin had: New Project, Members, Skills, agents, Workspaces), on an
// Install of its own with init's MAIN only. Every step leaves a screenshot in e2e/screenshots/settings/.
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/settings/", import.meta.url));

let install: Install;
let base = "";
let adaState: Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Calls /v1 with a token and a Session it names; a refusal throws with its status and body. */
async function call<T = unknown>(token: string, session: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(token, session, method, path, body);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

function send(token: string, session: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Darkory-Session": session, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ada = <T = unknown>(method: string, path: string, body?: unknown) => call<T>(install.token, "e2e-settings-ada", method, path, body);

/** A browser signed in as `member` through a login link ada asks /v1 for. */
async function signIn(browser: Browser, member: string) {
  const { url } = await ada<{ url: string }>("POST", `/v1/members/${member}/login-links`);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base}/inbox`);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  install = await startInstall();
  base = install.base;
  adaState = await signIn(browser, "ada");
});

test.afterAll(async () => {
  await install?.stop();
});

/** A page signed in (as ada unless told), collecting what it logs as an error (a CSP refusal shows there). */
async function open(browser: Browser, state = adaState, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ storageState: state, viewport });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, errors };
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: `${shots}${name}.png`, animations: "disabled" });
}

async function noSidewaysScroll(page: Page, what: string) {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, `${what} scrolls sideways`).toBe(client);
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Settings pages" });
/** The Organisation's button at the head of the app's sidebar. */
const orgButton = (page: Page) => page.locator("[data-slot=sidebar-header]").getByRole("button", { name: "E2E Organisation" });

test("New Project from the sidebar, then Members and Skills from Settings", async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);

  await test.step("the sidebar's New Project creates Web; its settings open on General", async () => {
    await page.goto(`${base}/settings`);
    await expect(page).toHaveURL(`${base}/settings/account`);
    await shot(page, "01-settings-fresh-install");
    // Settings is the Account's and the Organisation's: a Project is made from the app's sidebar.
    await expect(nav(page).getByRole("button", { name: "New Project" })).toHaveCount(0);
    await page.goto(`${base}/projects/MAIN/tasks`);
    await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "New Project" }).click();
    const dialog = page.getByRole("dialog", { name: "New Project" });
    await dialog.getByLabel("Name", { exact: true }).fill("Web");
    // The key is offered from the name.
    await expect(dialog.getByLabel("Key", { exact: true })).toHaveValue("WEB");
    await shot(page, "02-new-project");
    await dialog.getByRole("button", { name: "Create Project" }).click();
    await expect(page).toHaveURL(new RegExp(`${base}/projects/WEB/`));
    await page.goto(`${base}/projects/WEB/settings/general`);
    await expect(page.getByRole("group", { name: "General settings of Web" })).toBeVisible();
    await shot(page, "03-project-general");
  });

  await test.step("New Member: a human gets a Sign-in link, shown once", async () => {
    await page.goto(`${base}/settings/organisation/members`);
    await page.getByRole("button", { name: "New Member" }).click();
    const dialog = page.getByRole("dialog", { name: "New Member" });
    await expect(dialog.getByRole("radio", { name: "Human" })).toHaveAttribute("aria-checked", "true");
    await dialog.getByLabel("Name", { exact: true }).fill("Mai Tran");
    await dialog.getByLabel("Email").fill("mai@acme.test");
    // In the Project Settings was opened in, unless taken out.
    await expect(dialog.getByRole("checkbox", { name: "Web" })).toBeChecked();
    await shot(page, "04-new-member-human");
    await dialog.getByRole("button", { name: "Create Member" }).click();
    const link = page.getByRole("dialog", { name: "Sign-in link for Mai Tran" });
    await link.getByRole("button", { name: "Issue link" }).click();
    await expect(link.getByRole("textbox", { name: "Sign-in link" })).toHaveValue(/\/v1\/login-links\//);
    await expect(link.getByText("It will not be shown again.")).toBeVisible();
    await shot(page, "05-sign-in-link");
    await link.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "Mai Tran", exact: true })).toBeVisible();
    await shot(page, "06-member-page");
  });

  await test.step("on Mai's page: Add to Project, Reports to", async () => {
    await ada("POST", "/v1/projects", { key: "BOOKS", name: "Books", members: ["ada"] });
    await page.getByRole("button", { name: "Add to Project" }).click();
    await page.getByRole("option", { name: /Books/ }).click();
    await expect(page.getByRole("button", { name: "Remove from Books" })).toBeVisible();
    await page.getByRole("combobox", { name: "Reports to" }).click();
    await page.getByRole("option", { name: "ada" }).click();
    await expect(page.getByRole("combobox", { name: "Reports to" })).toHaveText(/ada/);
    await shot(page, "07-member-human");
  });

  await test.step("a Project's Members: its creator is in it; Add Member lists who is not and adds Mai", async () => {
    await ada("POST", "/v1/projects", { key: "DOCS", name: "Docs", members: ["ada"] });
    await page.goto(`${base}/projects/DOCS/settings/members`);
    const members = page.getByRole("table", { name: "Members of Docs" });
    await expect(members.getByRole("row", { name: "ada" })).toBeVisible();
    await page.getByRole("button", { name: "Add Member" }).click();
    await shot(page, "08-project-add-member");
    await page.getByRole("option", { name: /Mai Tran/ }).click();
    await expect(members.getByRole("row", { name: "Mai Tran" })).toBeVisible();
    await shot(page, "09-project-members");
  });

  await test.step("New Skill: a generic one, then a company one building on it", async () => {
    await page.goto(`${base}/settings/organisation/skills`);
    await page.getByRole("button", { name: "New Skill" }).click();
    let dialog = page.getByRole("dialog", { name: "New Skill" });
    await dialog.getByLabel("Name", { exact: true }).fill("bookkeeping");
    await dialog.getByLabel("Text", { exact: true }).fill("Keep the books.");
    await dialog.getByRole("button", { name: "Create Skill" }).click();
    await expect(page).toHaveURL(`${base}/settings/organisation/skills/bookkeeping`);

    await page.goto(`${base}/settings/organisation/skills`);
    await page.getByRole("button", { name: "New Skill" }).click();
    dialog = page.getByRole("dialog", { name: "New Skill" });
    await dialog.getByLabel("Name", { exact: true }).fill("web-engineer");
    await dialog.getByRole("radio", { name: "Company" }).click();
    await dialog.getByRole("combobox", { name: "Builds on" }).click();
    await page.getByRole("option", { name: "engineer", exact: true }).click();
    await dialog.getByLabel("Text", { exact: true }).fill("1. Reuse the cart component.\n2. Ship behind a flag.");
    await shot(page, "10-new-skill");
    await dialog.getByRole("button", { name: "Create Skill" }).click();
    await expect(page).toHaveURL(`${base}/settings/organisation/skills/web-engineer`);
    await expect(page.getByRole("region", { name: "Current text" })).toContainText("1. Reuse the cart component.");
    await expect(page.getByRole("link", { name: "engineer", exact: true })).toHaveAttribute("href", "/settings/organisation/skills/engineer");
    await shot(page, "11-skill");
  });

  await test.step("Grant Skill on Mai's page shows on the Skills list", async () => {
    await page.goto(`${base}/settings/organisation/members`);
    await page.getByRole("link", { name: /Mai Tran/ }).click();
    await page.getByRole("button", { name: "Grant Skill" }).click();
    await page.getByRole("option", { name: /^web-engineer/ }).click();
    await expect(page.getByRole("button", { name: "Take away web-engineer" })).toBeVisible();
    await page.goto(`${base}/settings/organisation/skills`);
    await expect(page.getByRole("row", { name: "web-engineer" })).toContainText("1 Member");
    await shot(page, "12-skills");
  });

  expect(errors).toEqual([]);
  await ctx.close();
});

test("scenario 10: a Project's settings under it, Settings from the Organisation menu, old addresses land, a non-admin sees Account only", async ({ browser }) => {
  // OPS is a second Project, with ada in it but not Mai: an empty one, a Project of one Workflow.
  await ada("POST", "/v1/projects", { key: "OPS", name: "Operations", members: ["ada"], workflow: "empty" });
  const { ctx, page, errors } = await open(browser);

  await test.step("the Project's Settings in the sidebar opens its General page, its pages as tabs on the bar", async () => {
    await page.goto(`${base}/projects/WEB/tasks`);
    // The current Project unfolds in the sidebar's Projects onto its places, Settings last.
    const settings = page.getByRole("navigation", { name: "Projects" }).getByRole("list", { name: "Web" }).getByRole("link", { name: "Settings" });
    await settings.click();
    await expect(page).toHaveURL(`${base}/projects/WEB/settings/general`);
    const tabs = page.getByRole("navigation", { name: "Project settings" });
    await expect(tabs.getByRole("link")).toHaveText(["General", "Members", "Labels", "Workspaces"]);
    await expect(tabs.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
    // The app's sidebar stays, its Settings marked; Settings' own nav is not drawn.
    await expect(settings).toHaveAttribute("aria-current", "page");
    await expect(nav(page)).toHaveCount(0);
    await shot(page, "13-door-project");
    await tabs.getByRole("link", { name: "Members" }).click();
    await expect(page).toHaveURL(`${base}/projects/WEB/settings/members`);
    await expect(tabs.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
    await expect(settings).toHaveAttribute("aria-current", "page");
  });

  await test.step("the Organisation menu opens Settings, Invite and manage Members, and Account settings", async () => {
    const organisation = orgButton(page);
    await organisation.click();
    await shot(page, "14-door-organisation-menu");
    // An admin's Settings opens on the Organisation.
    await page.getByRole("menuitem", { name: /^Settings/ }).click();
    await expect(page).toHaveURL(`${base}/settings/organisation/members`);
    await page.getByRole("link", { name: "Back" }).click();
    await organisation.click();
    await page.getByRole("menuitem", { name: /^Switch Organisation/ }).press("ArrowRight");
    await page.getByRole("menuitem", { name: "Account settings" }).click();
    await expect(page).toHaveURL(`${base}/settings/account`);
    await page.getByRole("link", { name: "Back" }).click();
    await organisation.click();
    await page.getByRole("menuitem", { name: "Invite and manage Members" }).click();
    await expect(page).toHaveURL(`${base}/settings/organisation/members`);
    await shot(page, "15-door-organisation");
  });

  await test.step("every /admin address lands on its Settings page", async () => {
    const mai = (await ada<{ items: { id: string; name: string }[] }>("GET", "/v1/members")).items.find((m) => m.name === "Mai Tran")!;
    // WEB, made here on the dialog's Default, has the two Workflows a new Project starts with.
    const workflowsOf = async (key: string) =>
      [...(await ada<{ workflows: { id: string; name: string; position: number }[] }>("GET", `/v1/projects/${key}/workflow`)).workflows].sort((a, b) => a.position - b.position);
    const workflows = await workflowsOf("WEB");
    expect(workflows.map((w) => w.name)).toEqual(["Implementation", "Bug triage"]);
    const work = `/projects/WEB/workflows/${workflows[0].id}`;
    // OPS, empty, has one: Work.
    const opsWorkflows = await workflowsOf("OPS");
    expect(opsWorkflows.map((w) => w.name)).toEqual(["Work"]);
    const opsWork = `/projects/OPS/workflows/${opsWorkflows[0].id}`;
    const redirects: [string, string][] = [
      ["/admin", "/settings/organisation/members"],
      ["/admin/members", "/settings/organisation/members"],
      [`/admin/members/${mai.id}`, `/settings/organisation/members/${mai.id}`],
      ["/admin/skills", "/settings/organisation/skills"],
      ["/admin/skills/web-engineer", "/settings/organisation/skills/web-engineer"],
      ["/admin/teams", "/projects/WEB/settings/general"],
      ["/admin/workflow", "/projects/WEB/workflows"],
      ["/admin/workspaces", "/projects/WEB/settings/workspaces"],
      // Settings' pages of a Project: the same page under the Project, its key in the Project's case.
      ["/settings/projects", "/projects/WEB/settings/general"],
      ["/settings/projects/WEB", "/projects/WEB/settings/general"],
      ["/settings/projects/WEB/members", "/projects/WEB/settings/members"],
      ["/projects/WEB/settings", "/projects/WEB/settings/general"],
      // The one Workflow's addresses before a Project had several: its Workflows' now.
      ["/settings/projects/WEB/workflow", "/projects/WEB/workflows"],
      // Settings' Workflows list: the Project's list in the app, which carries its acts.
      ["/settings/projects/WEB/workflows", "/projects/WEB/workflows"],
      // Settings' one Workflow: its editor in the app.
      [`/settings/projects/WEB/workflows/${workflows[0].id}`, `${work}/edit`],
      // An address saying the line's view, of a Project of several: its Workflows' list.
      ["/projects/WEB/workflow?view=text", "/projects/WEB/workflows?view=text"],
      ["/projects/WEB/workflows?view=text", "/projects/WEB/workflows?view=text"],
      ["/account", "/settings/account"],
      // Last: a page under OPS makes OPS the current Project. An address saying the line's view,
      // of a Project of one: that Workflow's page.
      ["/projects/OPS/workflow?view=text", `${opsWork}?view=text`],
      ["/projects/OPS/workflows?view=text", `${opsWork}?view=text`],
      ["/admin/teams/OPS", "/projects/OPS/settings/general"],
      ["/settings/projects/ops/labels", "/projects/OPS/settings/labels"],
      // A Project's settings page makes that Project current: /admin/teams now lands on OPS's.
      ["/admin/teams", "/projects/OPS/settings/general"],
    ];
    // The current Project is the one last shown: WEB.
    await page.goto(`${base}/projects/WEB/tasks`);
    for (const [from, to] of redirects) {
      await page.goto(`${base}${from}`);
      await expect(page, `${from} lands on ${to}`).toHaveURL(`${base}${to}`);
    }
    await shot(page, "16-admin-redirected");
  });

  await test.step("Mai, not an admin: Account alone in Settings, her Project's settings as text, and the Organisation's pages refused", async () => {
    const mai = await open(browser, await signIn(browser, "Mai Tran"));
    await mai.page.goto(`${base}/settings`);
    await expect(mai.page).toHaveURL(`${base}/settings/account`);
    const pages = nav(mai.page);
    await expect(pages.getByRole("link", { name: "Account" })).toBeVisible();
    await expect(pages.getByRole("list", { name: "Organisation" })).toHaveCount(0);
    await expect(pages.getByRole("list", { name: "Projects" })).toHaveCount(0);
    await expect(pages.getByRole("button", { name: "Web" })).toHaveCount(0);
    await expect(pages.getByRole("button", { name: "New Project" })).toHaveCount(0);
    await mai.page.goto(`${base}/projects/WEB/settings/general`);
    const general = mai.page.getByRole("group", { name: "General settings of Web" });
    await expect(general).toContainText("KeyWEB");
    await expect(general.getByRole("textbox")).toHaveCount(0);
    await expect(general.getByRole("switch")).toHaveCount(0);
    await expect(mai.page.getByRole("navigation", { name: "Project settings" }).getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
    await shot(mai.page, "17-non-admin-settings");
    await mai.page.goto(`${base}/settings/organisation/members`);
    await expect(mai.page.getByRole("heading", { name: "Admins only" })).toBeVisible();
    await shot(mai.page, "18-non-admin-refused");
    await mai.page.goto(`${base}/admin/members`);
    await expect(mai.page.getByRole("heading", { name: "Admins only" })).toBeVisible();
    // Her Organisation menu has no Invite and manage Members.
    await mai.page.goto(`${base}/inbox`);
    await orgButton(mai.page).click();
    await expect(mai.page.getByRole("menuitem", { name: /^Settings/ })).toBeVisible();
    await expect(mai.page.getByRole("menuitem", { name: "Invite and manage Members" })).toHaveCount(0);
    await shot(mai.page, "19-non-admin-organisation-menu");
    expect(mai.errors).toEqual([]);
    await mai.ctx.close();
  });

  expect(errors).toEqual([]);
  await ctx.close();
});

test("an agent: its token shown once; deactivating it ends its live Claim and its token stops working", async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);
  let secret = "";

  await test.step("New agent: its token's secret is shown once", async () => {
    await page.goto(`${base}/settings/organisation/agents`);
    await page.getByRole("button", { name: "New agent" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await dialog.getByLabel("Name", { exact: true }).fill("builder-1");
    await dialog.getByRole("checkbox", { name: "Web" }).check();
    await shot(page, "20-new-agent");
    await dialog.getByRole("button", { name: "Create agent" }).click();
    const once = page.getByRole("dialog", { name: "Token for builder-1" });
    const field = once.getByRole("textbox", { name: /^Secret of / });
    await expect(field).toHaveValue(/^dk_/);
    secret = await field.inputValue();
    await expect(once.getByText("It will not be shown again.")).toBeVisible();
    await shot(page, "21-token-once");
    await once.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "builder-1" })).toBeVisible();
    // Never again: the page lists the token by its prefix only.
    await expect(page.getByRole("list", { name: "Tokens" }).getByRole("listitem")).toHaveCount(1);
    expect(await page.content()).not.toContain(secret);
  });

  let key = "";
  await test.step("the agent claims a Task aimed at it, through /v1 with its token", async () => {
    const filed = await ada<{ task: { key: string } }>("POST", "/v1/tasks", { project: "WEB", title: "Write the parser", aim: "builder-1" });
    key = filed.task.key;
    const claim = await send(secret, "sess-builder-1", "POST", `/v1/tasks/${key}/claim`, { heartbeat_timeout_seconds: 600, model_label: "claude-opus-5-5" });
    expect(claim.status).toBe(200);
  });

  await test.step("its page shows the Session holding it; Deactivate counts what it stops", async () => {
    await page.reload();
    const session = page.getByRole("row", { name: "Session sess-builder-1" });
    await expect(session.getByRole("link", { name: key })).toBeVisible();
    await expect(session).toContainText("Open");
    // Its whole id, with a copy button that shows on hover.
    const copy = session.getByRole("button", { name: "Copy Session id" });
    await session.getByText("sess-builder-1").hover();
    await expect(copy).toBeVisible();
    // In the page's last card, with Paused: the agent's Runner settings came with it.
    await page.getByRole("region", { name: "Pause and deactivate" }).getByRole("button", { name: "Deactivate builder-1" }).click();
    const confirm = page.getByRole("dialog", { name: "Deactivate builder-1?" });
    await expect(confirm).toContainText("1 token");
    await expect(confirm).toContainText("1 Session");
    await expect(confirm).toContainText(key);
    await shot(page, "22-deactivate");
    await confirm.getByRole("button", { name: "Deactivate" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText("Deactivated", { exact: true }).first()).toBeVisible();
  });

  await test.step("the Claim ended and the token answers 401", async () => {
    const detail = await ada<{ task: { claim?: unknown }; claims: { how_ended?: string }[] }>("GET", `/v1/tasks/${key}`);
    expect(detail.task.claim).toBeUndefined();
    expect(detail.claims.at(-1)?.how_ended).toBe("member_deactivated");
    expect((await send(secret, "sess-builder-1", "GET", "/v1/me")).status).toBe(401);
  });

  await test.step("the Agents list keeps the row, dimmed, saying why", async () => {
    await page.goto(`${base}/settings/organisation/agents`);
    await expect(page.getByRole("row", { name: "builder-1" })).toContainText("Deactivated");
    await shot(page, "23-agents");
  });

  await test.step("Account: my token, this browser, the CLI line", async () => {
    await page.goto(`${base}/settings/account`);
    await expect(page.getByRole("row", { name: "This browser" }).getByRole("button", { name: "Log out" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^More for token / }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
    await expect(page.getByText("darkory login ada")).toBeVisible();
    await shot(page, "24-account");
  });

  expect(errors).toEqual([]);
  await ctx.close();
});

test("a Workspace, a Project's default, an agent's model and Paused", async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);
  type Workspace = { id: string; name: string; path: string; mode: string; default_branch: string };

  await test.step("New Workspace adds a git Workspace in pull-request mode; its default branch is edited in place", async () => {
    await page.goto(`${base}/projects/WEB/settings/workspaces`);
    await expect(page.getByRole("heading", { name: "No Workspaces yet" })).toBeVisible();
    await shot(page, "25-no-workspaces");
    await page.getByRole("button", { name: "New Workspace" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New Workspace" });
    await dialog.getByLabel("Name", { exact: true }).fill("shop");
    await dialog.getByLabel("Path", { exact: true }).fill("/srv/src/shop");
    await dialog.getByRole("radio", { name: "Pull request" }).click();
    await expect(dialog.getByLabel("Default branch", { exact: true })).toHaveValue("main");
    await shot(page, "26-new-workspace");
    await dialog.getByRole("button", { name: "Create Workspace" }).click();
    await expect(dialog).toHaveCount(0);

    const row = page.getByRole("table", { name: "Workspaces" }).getByRole("row", { name: "shop" });
    await expect(row.getByRole("combobox", { name: "Mode of shop" })).toHaveText(/Pull request/);
    await row.getByRole("button", { name: "Change default branch of shop" }).click();
    await row.getByRole("textbox", { name: "Default branch of shop" }).fill("trunk");
    await page.keyboard.press("Enter");
    await expect(row.getByRole("button", { name: "Change default branch of shop" })).toHaveText("trunk");
    await expect
      .poll(async () => (await ada<{ items: Workspace[] }>("GET", "/v1/workspaces")).items.map((w) => `${w.name} ${w.path} ${w.mode} ${w.default_branch}`))
      .toEqual(["shop /srv/src/shop pull_request trunk"]);
    await shot(page, "27-workspaces");
  });

  await test.step("the Project's General page sets its default Workspace and Auto-complete", async () => {
    await page.goto(`${base}/projects/WEB/settings/general`);
    const general = page.getByRole("group", { name: "General settings of Web" });
    await general.getByRole("combobox", { name: "Default Workspace" }).click();
    await page.getByRole("option", { name: /shop/ }).click();
    await expect(general.getByRole("combobox", { name: "Default Workspace" })).toHaveText(/shop/);
    await general.getByRole("switch", { name: "Auto-complete" }).click();
    await expect(general.getByRole("switch", { name: "Auto-complete" })).toBeChecked();
    await shot(page, "28-project-defaults");
    const shop = (await ada<{ items: Workspace[] }>("GET", "/v1/workspaces")).items[0];
    await expect
      .poll(async () => {
        const p = (await ada<{ project: { default_workspace_id?: string; auto_complete: boolean } }>("GET", "/v1/projects/WEB")).project;
        return [p.default_workspace_id, p.auto_complete];
      })
      .toEqual([shop.id, true]);
  });

  await test.step("New agent asks its model; its page edits the model and pauses it", async () => {
    await page.goto(`${base}/settings/organisation/agents?new=1`);
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await dialog.getByLabel("Name", { exact: true }).fill("planner-1");
    await expect(dialog.getByLabel("Model", { exact: true })).toHaveValue("claude-sonnet-5-5");
    await dialog.getByLabel("Model", { exact: true }).fill("claude-opus-5-5");
    await dialog.getByRole("button", { name: "Create agent" }).click();
    const once = page.getByRole("dialog", { name: "Token for planner-1" });
    await expect(once.getByRole("textbox", { name: /^Secret of / })).toHaveValue(/^dk_/);
    await once.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "planner-1" })).toBeVisible();

    type Agent = { member: { agent?: { command: string; model: string; paused: boolean } } };
    const card = page.getByRole("group", { name: "Agent settings of planner-1" });
    await expect(card.getByLabel("Model", { exact: true })).toHaveValue("claude-opus-5-5");
    await expect(card.getByLabel("Command", { exact: true })).toHaveValue("claude");
    expect((await ada<Agent>("GET", "/v1/members/planner-1")).member.agent).toMatchObject({ command: "claude", model: "claude-opus-5-5", paused: false });

    await card.getByLabel("Model", { exact: true }).fill("claude-haiku-4-5-20251001");
    await page.keyboard.press("Enter");
    // The Install runs --runner=off: the setting is In use, and nothing runs the agent now.
    await expect(card).toContainText("In use");
    await expect(card).toContainText("Not running: no Runner runs beside this server, so nothing starts this agent's command until one does.");
    const stop = page.getByRole("region", { name: "Pause and deactivate" });
    await stop.getByRole("switch", { name: "Paused" }).click();
    await expect(stop.getByRole("switch", { name: "Paused" })).toBeChecked();
    await expect.poll(async () => (await ada<Agent>("GET", "/v1/members/planner-1")).member.agent).toMatchObject({ model: "claude-haiku-4-5-20251001", paused: true });
    await shot(page, "29-agent");

    await page.goto(`${base}/settings/organisation/agents`);
    const row = page.getByRole("row", { name: "planner-1" });
    await expect(row).toContainText("Paused");
    await expect(row).toContainText("claude-haiku-4-5-20251001");
    await shot(page, "30-agents");
  });

  await test.step("Stop using the Runner, behind the Agent card's ⋯, says what it clears and clears it", async () => {
    await page.goto(`${base}/settings/organisation/agents`);
    await page.getByRole("row", { name: "planner-1" }).getByRole("link", { name: "planner-1" }).click();
    await page.getByRole("button", { name: "More for the Agent settings of planner-1" }).click();
    await page.getByRole("menuitem", { name: "Stop using the Runner" }).click();
    const confirm = page.getByRole("dialog", { name: "Stop using the Runner for planner-1?" });
    await expect(confirm).toContainText("claude-haiku-4-5-20251001");
    await shot(page, "31-stop-runner");
    await confirm.getByRole("button", { name: "Stop using the Runner" }).click();
    await expect(confirm).toHaveCount(0);
    const card = page.getByRole("group", { name: "Agent settings of planner-1" });
    await expect(card).toContainText("Not in use");
    await expect(card.getByRole("button", { name: "Use the Runner" })).toBeVisible();
    expect((await ada<{ member: { agent?: unknown } }>("GET", "/v1/members/planner-1")).member.agent).toBeUndefined();
    await shot(page, "32-agent-own-sessions");
  });

  await test.step("at 390px none of them scrolls sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const screens: [string, () => ReturnType<Page["getByRole"]>][] = [
      ["/projects/WEB/settings/workspaces", () => page.getByRole("row", { name: "shop" })],
      ["/projects/WEB/settings/general", () => page.getByRole("group", { name: "General settings of Web" })],
      ["/projects/WEB/settings/members", () => page.getByRole("table", { name: "Members of Web" })],
      ["/projects/WEB/settings/labels", () => page.getByRole("button", { name: "New Label" })],
      ["/settings/organisation/members", () => page.getByRole("table", { name: "Members" })],
      ["/settings/organisation/agents", () => page.getByRole("table", { name: "Agents" })],
      ["/settings/account", () => page.getByRole("row", { name: "This browser" })],
    ];
    for (const [path, shown] of screens) {
      await page.goto(`${base}${path}`);
      await expect(shown()).toBeVisible();
      await noSidewaysScroll(page, path);
      await shot(page, `33-phone${path.replaceAll("/", "-")}`);
    }
  });

  expect(errors).toEqual([]);
  await ctx.close();
});

test("an ⓘ explains on hover, focus and tap, and moves nothing", async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);
  /** Where every box of `root` sits: what an ⓘ opening must leave alone. */
  const boxes = (root: string) =>
    page.locator(root).evaluate((el) => [el, ...el.querySelectorAll("*")].map((e) => JSON.stringify(e.getBoundingClientRect())));

  await test.step("a Project's Settings › General: hovering Colour's ⓘ opens its explanation over the page", async () => {
    await page.goto(`${base}/projects/MAIN/settings/general`);
    const form = page.getByRole("group", { name: "General settings of Main" });
    await expect(form).toBeVisible();
    await expect(form).not.toContainText("The colour of its mark");
    const before = await boxes('[role="group"][aria-label="General settings of Main"]');
    await form.getByRole("button", { name: "About Colour" }).hover();
    const tip = page.getByRole("dialog").filter({ hasText: "The colour of its mark beside its name." });
    await expect(tip).toBeVisible();
    expect(await boxes('[role="group"][aria-label="General settings of Main"]')).toEqual(before);
    await shot(page, "40-infotip-hover");
    // The pointer leaving closes it.
    await page.mouse.move(5, 5);
    await expect(tip).toHaveCount(0);
  });

  await test.step("File a Task: the keyboard opens Auto-complete's ⓘ, a click pins it, Esc closes it, and nothing in the dialog moves", async () => {
    await page.goto(`${base}/projects/MAIN/tasks`);
    await page.getByRole("button", { name: "File Task" }).first().click();
    const dialog = page.getByRole("dialog", { name: "File a Task" });
    await expect(dialog.getByRole("group", { name: "Subtasks" })).toBeVisible();
    // Measured once the dialog has finished opening (it zooms in).
    await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const before = await boxes('[role="dialog"][aria-labelledby]');
    const about = dialog.getByRole("button", { name: "About Auto-complete" });
    await dialog.getByRole("switch", { name: "Auto-complete" }).focus();
    await page.keyboard.press("Tab");
    await expect(about).toBeFocused();
    const tip = page.getByRole("dialog").filter({ hasText: "Completes itself when its last Subtask ends Done." });
    await expect(tip).toBeVisible();
    expect(await boxes('[role="dialog"][aria-labelledby]')).toEqual(before);
    await about.click();
    await page.mouse.move(5, 5);
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    await expect(dialog).toBeVisible();
  });

  await ctx.close();

  await test.step("on a touch screen a tap opens it and a tap elsewhere closes it", async () => {
    const touch = await browser.newContext({ storageState: adaState, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const phone = await touch.newPage();
    await phone.goto(`${base}/projects/MAIN/settings/general`);
    const about = phone.getByRole("button", { name: "About Key" });
    await about.tap();
    const tip = phone.getByRole("dialog").filter({ hasText: "Starts each Task key" });
    await expect(tip).toBeVisible();
    await phone.locator("h1").tap();
    await expect(tip).toHaveCount(0);
    await touch.close();
  });
  expect(errors).toEqual([]);
});
