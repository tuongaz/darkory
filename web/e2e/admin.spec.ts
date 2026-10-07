import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import startServer from "./server";

// Admin's journeys (scenarios 8, 9 and 12 of docs/build/ui-plan.md) against the real binary. They
// run on an Install of their own, started with e2e/server.ts as the shared one is: this file runs
// before flow.spec.ts, which needs the shared Install fresh (no Team, no Feature).
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/admin/", import.meta.url));
const envKeys = ["DARKORY_E2E_LOGIN_LINK", "DARKORY_E2E_BASE_URL", "DARKORY_E2E_DATA", "DARKORY_E2E_ADMIN_TOKEN"] as const;

let stop: (() => Promise<void>) | undefined;
let base = "";
let signedIn: Awaited<ReturnType<BrowserContext["storageState"]>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const saved = envKeys.map((k) => [k, process.env[k]] as const);
  let token: string;
  try {
    stop = await startServer();
    base = process.env.DARKORY_E2E_BASE_URL!;
    token = process.env.DARKORY_E2E_ADMIN_TOKEN!;
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  // Sign in once with a login link asked of /v1 with ada's token, as any spec can whatever became
  // of the startup link; every test starts from that browser's cookie.
  const issued = await fetch(`${base}/v1/members/ada/login-links`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Darkory-Session": "e2e-admin", "Idempotency-Key": crypto.randomUUID() },
  });
  expect(issued.status).toBe(201);
  const { url } = (await issued.json()) as { url: string };
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base}/inbox`);
  signedIn = await ctx.storageState();
  await ctx.close();
});

test.afterAll(async () => {
  await stop?.();
});

/** A page signed in as ada, collecting what it logs as an error (a CSP refusal shows there). */
async function open(browser: Browser) {
  const ctx = await browser.newContext({ storageState: signedIn });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, errors };
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: `${shots}${name}.png`, animations: "disabled" });
}

/** Reads or writes /v1 from inside the page, as ada: the browser sends the cookie and the Origin. */
async function v1<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.evaluate(
    async ([method, path, body]) => {
      const r = await fetch(path as string, {
        method: method as string,
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    },
    [method, path, body] as const,
  );
  if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${res.text}`);
  return (res.text ? JSON.parse(res.text) : undefined) as T;
}

/** Calls /v1 as an agent would: its token and a Session id it chose. */
function asAgent(secret: string, session: string, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Darkory-Session": session,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("scenario 12: Create Team, Add Member, New Skill from the admin pages", async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);

  await test.step("the checklist's Create Team opens New Team; creating it opens the Team", async () => {
    await page.goto(`${base}/inbox`);
    await page.getByRole("region", { name: "Set up E2E Organisation" }).getByRole("link", { name: "Create Team" }).click();
    const dialog = page.getByRole("dialog", { name: "New Team" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Name").fill("Web");
    // The key is offered from the name.
    await expect(dialog.getByLabel("Key")).toHaveValue("WEB");
    await shot(page, "new-team");
    await dialog.getByRole("button", { name: "Create Team" }).click();
    await expect(page).toHaveURL(`${base}/admin/teams/WEB`);
    await expect(page.getByRole("heading", { name: "Web" })).toBeVisible();
  });

  await test.step("Add Member lists the Members not in the Team and adds one", async () => {
    await page.getByRole("button", { name: "Add Member" }).click();
    await expect(page.getByText("Not in Web")).toBeVisible();
    await shot(page, "team-add-member");
    await page.getByRole("option", { name: /ada/ }).click();
    const members = page.getByRole("table", { name: "Members of Web" });
    await expect(members.getByRole("row", { name: "ada" })).toBeVisible();
    await expect(members.getByRole("rowheader", { name: "Humans 1" })).toBeVisible();
  });

  await test.step("the checklist's Add Member opens New Member; a human gets a Sign-in link, shown once", async () => {
    await page.goto(`${base}/inbox`);
    await page.getByRole("region", { name: "Set up E2E Organisation" }).getByRole("link", { name: "Add Member" }).click();
    const dialog = page.getByRole("dialog", { name: "New Member" });
    await expect(dialog.getByRole("radio", { name: "Human" })).toHaveAttribute("aria-checked", "true");
    await dialog.getByLabel("Name").fill("Mai Tran");
    await dialog.getByLabel("Email").fill("mai@acme.test");
    await shot(page, "new-member-human");
    await dialog.getByRole("button", { name: "Create Member" }).click();
    const link = page.getByRole("dialog", { name: "Sign-in link for Mai Tran" });
    await link.getByRole("button", { name: "Issue link" }).click();
    await expect(link.getByRole("textbox", { name: "Sign-in link" })).toHaveValue(/\/v1\/login-links\//);
    await expect(link.getByText("It will not be shown again.")).toBeVisible();
    await shot(page, "sign-in-link");
    await link.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "Mai Tran" })).toBeVisible();
  });

  await test.step("on Mai's page: Add to Team, Reports to", async () => {
    await page.getByRole("button", { name: "Add to Team" }).click();
    await page.getByRole("option", { name: /Web/ }).click();
    await expect(page.getByRole("button", { name: "Remove from Web" })).toBeVisible();
    await page.getByRole("combobox", { name: "Reports to" }).click();
    await page.getByRole("option", { name: "ada" }).click();
    await expect(page.getByRole("combobox", { name: "Reports to" })).toHaveText(/ada/);
    await shot(page, "member-human");
  });

  await test.step("New Skill: a generic one, then a company one building on it", async () => {
    await page.goto(`${base}/admin/skills`);
    await page.getByRole("button", { name: "New Skill" }).click();
    let dialog = page.getByRole("dialog", { name: "New Skill" });
    await dialog.getByLabel("Name").fill("engineer");
    await dialog.getByLabel("Text").fill("Build what the Task asks for.");
    await dialog.getByRole("button", { name: "Create Skill" }).click();
    await expect(page).toHaveURL(`${base}/admin/skills/engineer`);

    await page.goto(`${base}/admin/skills`);
    await page.getByRole("button", { name: "New Skill" }).click();
    dialog = page.getByRole("dialog", { name: "New Skill" });
    await dialog.getByLabel("Name").fill("web-engineer");
    await dialog.getByRole("radio", { name: "Company" }).click();
    await dialog.getByRole("combobox", { name: "Builds on" }).click();
    await page.getByRole("option", { name: "engineer" }).click();
    await dialog.getByLabel("Text").fill("1. Reuse the cart component.\n2. Ship behind a flag.");
    await shot(page, "new-skill");
    await dialog.getByRole("button", { name: "Create Skill" }).click();
    await expect(page).toHaveURL(`${base}/admin/skills/web-engineer`);
    await expect(page.getByRole("region", { name: "Current text" })).toContainText("1. Reuse the cart component.");
    await expect(page.getByRole("link", { name: "engineer", exact: true })).toHaveAttribute("href", "/admin/skills/engineer");
    await shot(page, "skill");
  });

  await test.step("Grant Skill on Mai's page shows on the Skills list", async () => {
    await page.goto(`${base}/admin/members`);
    await page.getByRole("link", { name: /Mai Tran/ }).click();
    await page.getByRole("button", { name: "Grant Skill" }).click();
    await page.getByRole("option", { name: /^web-engineer/ }).click();
    await expect(page.getByRole("button", { name: "Take away web-engineer" })).toBeVisible();
    await page.goto(`${base}/admin/skills`);
    await expect(page.getByRole("row", { name: "web-engineer" })).toContainText("1 Member");
    await shot(page, "skills");
  });

  expect(errors).toEqual([]);
  await ctx.close();
});

test("scenario 8: an admin renames In review and adds a Status; GET /v1/statuses says so", async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);
  // A second browser tab keeps the Workflow open, to see the change arrive without a reload.
  const watcher = await ctx.newPage();
  await watcher.goto(`${base}/admin/workflow`);
  await expect(watcher.getByRole("row", { name: "In review" })).toBeVisible();
  await watcher.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));

  await page.goto(`${base}/admin/workflow`);
  const table = page.getByRole("table", { name: "Statuses" });
  await expect(table.getByRole("row")).toHaveCount(7);

  // The ⓘ opens beside the Kind column it explains, wide enough for its lines, inside the window.
  await page.getByRole("button", { name: "About the kinds" }).click();
  const kinds = page.getByRole("dialog").filter({ hasText: "Reached by Drop only" });
  await expect(kinds).toBeVisible();
  const head = (await table.getByRole("columnheader", { name: /^Kind/ }).boundingBox())!;
  await expect.poll(async () => (await kinds.boundingBox())!.x).toBeGreaterThanOrEqual(head.x + head.width);
  const box = (await kinds.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(300);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await kinds.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await shot(page, "workflow-kinds");
  await page.keyboard.press("Escape");
  await expect(kinds).toHaveCount(0);

  await page.getByRole("button", { name: "Rename In review" }).click();
  await page.getByRole("textbox", { name: "Name of In review" }).fill("Code review");
  await page.keyboard.press("Enter");
  await expect(table.getByRole("row", { name: "Code review" })).toBeVisible();

  await page.getByRole("button", { name: "Add Status" }).click();
  await page.getByRole("textbox", { name: "Name of the new Status" }).fill("QA");
  await page.keyboard.press("Enter");
  await expect(table.getByRole("row", { name: "QA" })).toBeVisible();

  await expect
    .poll(async () => (await v1<{ items: { name: string; kind: string }[] }>(page, "GET", "/v1/statuses")).items.map((s) => `${s.name}:${s.kind}`))
    .toEqual(["Backlog:backlog", "Todo:todo", "In progress:in_progress", "Code review:in_progress", "QA:in_progress", "Done:done", "Dropped:dropped"]);

  // A kind change that leaves no Todo Status is refused in words, and nothing is sent.
  await page.getByRole("combobox", { name: "Kind of Todo" }).click();
  await page.getByRole("option", { name: "Backlog" }).click();
  await expect(page.getByRole("alert")).toContainText("The list needs a Todo Status.");
  await shot(page, "workflow");

  await expect(watcher.getByRole("row", { name: "Code review" })).toBeVisible();
  await expect(watcher.getByRole("row", { name: "QA" })).toBeVisible();
  expect(await watcher.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded)).toBe(true);

  expect(errors).toEqual([]);
  await ctx.close();
});

test("scenario 9: deactivating an agent ends its live Claim and its token stops working", async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);
  let secret = "";

  await test.step("New Member as an Agent: its token's secret is shown once", async () => {
    await page.goto(`${base}/admin/members?new=1&kind=agent`);
    const dialog = page.getByRole("dialog", { name: "New Member" });
    await expect(dialog.getByRole("radio", { name: "Agent" })).toHaveAttribute("aria-checked", "true");
    await dialog.getByLabel("Name").fill("builder-1");
    await dialog.getByRole("button", { name: "Create Member" }).click();
    const once = page.getByRole("dialog", { name: "Token for builder-1" });
    const field = once.getByRole("textbox", { name: "Secret of default" });
    await expect(field).toHaveValue(/^dk_/);
    secret = await field.inputValue();
    await expect(once.getByText("It will not be shown again.")).toBeVisible();
    await shot(page, "token-once");
    await once.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "builder-1" })).toBeVisible();
    // Never again: the page lists the token by its prefix only.
    await expect(page.getByRole("listitem", { name: "Token default" })).toBeVisible();
    expect(await page.content()).not.toContain(secret);
  });

  let key = "";
  await test.step("the agent claims a Task aimed at it, through /v1 with its token", async () => {
    await v1(page, "POST", "/v1/teams", { key: "AGT", name: "Agents" });
    await v1(page, "PUT", "/v1/teams/AGT/members/ada");
    const filed = await v1<{ feature: { key: string } }>(page, "POST", "/v1/features", { team: "AGT", title: "Agent work" });
    const task = await v1<{ task: { key: string } }>(page, "POST", "/v1/tasks", { feature: filed.feature.key, title: "Write the parser", aimed_at: "builder-1" });
    key = task.task.key;
    const claim = await asAgent(secret, "sess-builder-1", "POST", `/v1/tasks/${key}/claim`, { heartbeat_timeout_seconds: 600, model_label: "claude-opus-5-5" });
    expect(claim.status).toBe(200);
  });

  await test.step("the Member page shows the Session holding it; Deactivate counts what it stops", async () => {
    await page.reload();
    const session = page.getByRole("listitem", { name: "Session sess-builder-1" });
    await expect(session).toContainText(`Holding ${key}`);
    await expect(session).toContainText("claude-opus-5-5");
    await page.getByRole("button", { name: "More for builder-1" }).click();
    await page.getByRole("menuitem", { name: "Deactivate" }).click();
    const confirm = page.getByRole("dialog", { name: "Deactivate builder-1?" });
    await expect(confirm).toContainText("1 token");
    await expect(confirm).toContainText("1 Session");
    await expect(confirm).toContainText(`1 Claim${key}`);
    await shot(page, "deactivate");
    await confirm.getByRole("button", { name: "Deactivate" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText("Deactivated", { exact: true })).toBeVisible();
  });

  await test.step("the Claim ended and the token answers 401", async () => {
    const detail = await v1<{ task: { claim?: { ended_at?: string } }; claims: { how_ended?: string }[] }>(page, "GET", `/v1/tasks/${key}`);
    // No live Claim: the Task's Claim is gone or ended.
    expect(detail.task.claim === undefined || !!detail.task.claim.ended_at).toBe(true);
    expect(detail.claims.at(-1)?.how_ended).toBe("member_deactivated");
    const me = await asAgent(secret, "sess-builder-1", "GET", "/v1/me");
    expect(me.status).toBe(401);
  });

  await test.step("the Members list keeps the row, dimmed, saying why", async () => {
    await page.goto(`${base}/admin/members`);
    await expect(page.getByRole("row", { name: "builder-1" })).toContainText("Deactivated");
    await shot(page, "members");
  });

  await test.step("Account: my token, this browser, the CLI line", async () => {
    await page.goto(`${base}/account`);
    await expect(page.getByRole("listitem", { name: "This browser" }).getByRole("button", { name: "Sign out" })).toBeVisible();
    // At rest a token shows its ⋯, not Revoke.
    await expect(page.getByRole("button", { name: /^More for token / }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke" })).toHaveCount(0);
    await expect(page.getByText("darkory login ada")).toBeVisible();
    await shot(page, "account");
  });

  expect(errors).toEqual([]);
  await ctx.close();
});

test("agents plan R3: a Workspace, a Team's default, an agent's model and Paused", async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);
  type Workspace = { id: string; name: string; path: string; mode: string; default_branch: string };

  await test.step("New Workspace adds a git Workspace in pull-request mode; its default branch is edited in place", async () => {
    await page.goto(`${base}/admin/workspaces`);
    await expect(page.getByRole("heading", { name: "No Workspaces yet" })).toBeVisible();
    await page.getByRole("button", { name: "New Workspace" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New Workspace" });
    await dialog.getByLabel("Name").fill("shop");
    await dialog.getByLabel("Path").fill("/srv/src/shop");
    await dialog.getByRole("radio", { name: "Pull request" }).click();
    await expect(dialog.getByLabel("Default branch")).toHaveValue("main");
    await shot(page, "r3-new-workspace");
    await dialog.getByRole("button", { name: "Create Workspace" }).click();
    await expect(dialog).toHaveCount(0);

    const row = page.getByRole("table", { name: "Workspaces" }).getByRole("row", { name: "shop" });
    await expect(row.getByRole("combobox", { name: "Mode of shop" })).toHaveText(/Pull request/);
    await row.getByRole("button", { name: "Change default branch of shop" }).click();
    await row.getByRole("textbox", { name: "Default branch of shop" }).fill("trunk");
    await page.keyboard.press("Enter");
    await expect(row.getByRole("button", { name: "Change default branch of shop" })).toHaveText("trunk");
    await expect
      .poll(async () => (await v1<{ items: Workspace[] }>(page, "GET", "/v1/workspaces")).items.map((w) => `${w.name} ${w.path} ${w.mode} ${w.default_branch}`))
      .toEqual(["shop /srv/src/shop pull_request trunk"]);
  });

  await test.step("a Team's page sets its default Workspace and Ship when done; the Workspaces table counts it", async () => {
    await v1(page, "POST", "/v1/teams", { key: "PLAT", name: "Platform" });
    await page.goto(`${base}/admin/teams/PLAT`);
    const defaults = page.getByRole("group", { name: "Defaults of Platform" });
    await defaults.getByRole("combobox", { name: "Default Workspace" }).click();
    await page.getByRole("option", { name: /shop/ }).click();
    await expect(defaults.getByRole("combobox", { name: "Default Workspace" })).toHaveText(/shop/);
    await defaults.getByRole("switch", { name: "Ship when done" }).click();
    await expect(defaults.getByRole("switch", { name: "Ship when done" })).toBeChecked();
    await shot(page, "r3-team-defaults");
    const shop = (await v1<{ items: Workspace[] }>(page, "GET", "/v1/workspaces")).items[0];
    await expect
      .poll(async () => {
        const t = (await v1<{ team: { default_workspace_id?: string; ship_when_done: boolean } }>(page, "GET", "/v1/teams/PLAT")).team;
        return [t.default_workspace_id, t.ship_when_done];
      })
      .toEqual([shop.id, true]);

    await page.goto(`${base}/admin/workspaces`);
    await expect(page.getByRole("row", { name: "shop" })).toContainText("Platform");
    await shot(page, "r3-workspaces");
  });

  await test.step("New Member as an Agent asks its model; its page edits the model and pauses it", async () => {
    await page.goto(`${base}/admin/members?new=1&kind=agent`);
    const dialog = page.getByRole("dialog", { name: "New Member" });
    await dialog.getByLabel("Name").fill("planner-1");
    await expect(dialog.getByLabel("Model")).toHaveValue("claude-sonnet-5-5");
    await dialog.getByLabel("Model").fill("claude-opus-5-5");
    await dialog.getByRole("button", { name: "Create Member" }).click();
    const once = page.getByRole("dialog", { name: "Token for planner-1" });
    await expect(once.getByRole("textbox", { name: "Secret of default" })).toHaveValue(/^dk_/);
    await once.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "planner-1" })).toBeVisible();

    type Agent = { member: { agent?: { command: string; model: string; paused: boolean } } };
    const card = page.getByRole("group", { name: "Agent settings of planner-1" });
    await expect(card.getByLabel("Model")).toHaveValue("claude-opus-5-5");
    await expect(card.getByLabel("Command")).toHaveValue("claude");
    expect((await v1<Agent>(page, "GET", "/v1/members/planner-1")).member.agent).toMatchObject({ command: "claude", model: "claude-opus-5-5", paused: false });

    await card.getByLabel("Model").fill("claude-haiku-4-5-20251001");
    await page.keyboard.press("Enter");
    await card.getByRole("switch", { name: "Paused" }).click();
    await expect(card.getByRole("switch", { name: "Paused" })).toBeChecked();
    await expect
      .poll(async () => (await v1<Agent>(page, "GET", "/v1/members/planner-1")).member.agent)
      .toMatchObject({ model: "claude-haiku-4-5-20251001", paused: true });
    await shot(page, "r3-agent");

    await page.goto(`${base}/admin/members`);
    const row = page.getByRole("row", { name: "planner-1" });
    await expect(row).toContainText("Paused");
    await expect(row).toContainText("claude-haiku-4-5-20251001");
    await shot(page, "r3-members");
  });

  await test.step("Stop using the Runner, behind the Agent card's ⋯, says what it clears and clears it", async () => {
    await page.goto(`${base}/admin/members/planner-1`);
    await page.getByRole("button", { name: "More for the Agent settings of planner-1" }).click();
    await page.getByRole("menuitem", { name: "Stop using the Runner" }).click();
    const confirm = page.getByRole("dialog", { name: "Stop using the Runner for planner-1?" });
    await expect(confirm).toContainText("claude-haiku-4-5-20251001");
    await expect(confirm).toContainText("9 arguments");
    await shot(page, "r3-stop-runner");
    await confirm.getByRole("button", { name: "Stop using the Runner" }).click();
    await expect(confirm).toHaveCount(0);
    const card = page.getByRole("group", { name: "Agent settings of planner-1" });
    await expect(card).toContainText("the Runner does not start it");
    await expect(card.getByRole("button", { name: "Use the Runner" })).toBeVisible();
    expect((await v1<{ member: { agent?: unknown } }>(page, "GET", "/v1/members/planner-1")).member.agent).toBeUndefined();
  });

  await test.step("New Member as an Agent with Run with the Runner off has no agent settings", async () => {
    await page.goto(`${base}/admin/members?new=1&kind=agent`);
    const dialog = page.getByRole("dialog", { name: "New Member" });
    await dialog.getByLabel("Name").fill("bot-1");
    await dialog.getByRole("switch", { name: "Run with the Runner" }).click();
    await expect(dialog.getByLabel("Model")).toHaveCount(0);
    await shot(page, "r3-new-agent-own-session");
    await dialog.getByRole("button", { name: "Create Member" }).click();
    await page.getByRole("dialog", { name: "Token for bot-1" }).getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("group", { name: "Agent settings of bot-1" })).toContainText("the Runner does not start it");
    expect((await v1<{ member: { agent?: unknown } }>(page, "GET", "/v1/members/bot-1")).member.agent).toBeUndefined();
  });

  await test.step("at 390px none of them scrolls sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const screens: [string, () => ReturnType<Page["getByRole"]>][] = [
      ["/admin/workspaces", () => page.getByRole("row", { name: "shop" })],
      ["/admin/teams/PLAT", () => page.getByRole("group", { name: "Defaults of Platform" })],
      ["/admin/members/planner-1", () => page.getByRole("group", { name: "Agent settings of planner-1" })],
    ];
    for (const [path, shown] of screens) {
      await page.goto(`${base}${path}`);
      await expect(shown()).toBeVisible();
      const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(scroll, path).toBe(client);
    }
    await shot(page, "r3-agent-phone");
  });

  expect(errors).toEqual([]);
  await ctx.close();
});
