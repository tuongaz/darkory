import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startInstall, startRunnerInstall, type Install, type RunnerInstall } from "./server";

// Two journeys against the real binary, each on Installs of its own:
//
// - Signing in and setting up: the signed-out page, the startup login link, the Install
//   checklist in an empty Inbox (init's MAIN done, Add Member, File Task; another Project made from
//   the sidebar's New Project), then the shell around the first Task: live updates, ⌘K, the keys, the peek, a
//   phone.
// - The Session panel and the Agents page's Runner state (docs/build/agents-plan.md, R2). With no
//   Runner (serve --runner=off) the panel must be absent, and the terminal is played by Playwright
//   (page.route and page.routeWebSocket) to check it under the Install's CSP. Then Installs whose
//   server runs the Runner, with the fake agent (tools/fakeagent) as builder's command: once with
//   sessions in tmux, when the machine has it, and once as child processes.
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/session/", import.meta.url));

let install: Install | undefined;
let base = "";
let token = "";
let signedIn: Awaited<ReturnType<BrowserContext["storageState"]>>;
let taskKey = "";
let taskId = "";

/** Calls /v1 with a token and the Session it names; a refusal comes back as it is. */
function send(secret: string, session: string, method: string, path: string, body?: unknown) {
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

async function v1<T = Record<string, unknown>>(secret: string, session: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(secret, session, method, path, body);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Writes through /v1 from inside the page, as the signed-in Member: the browser sends the cookie and the Origin. */
async function write(page: Page, method: string, path: string, body: unknown = {}) {
  const res = await page.evaluate(
    async ([method, path, body]) => {
      const r = await fetch(path as string, {
        method: method as string,
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    },
    [method, path, body] as const,
  );
  if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${res.text}`);
}

async function markLoaded(page: Page) {
  await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));
}
async function notReloaded(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded)).toBe(true);
}
async function noSidewaysScroll(page: Page) {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBe(client);
}

/** The app's sidebar: on a phone it is a sheet, open only after the top bar's toggle. */
function sidebar(page: Page) {
  return page.locator("[data-slot=sidebar]").filter({ has: page.getByRole("navigation", { name: "Main" }) });
}

/** A row of the sidebar's Projects: a Project by name, or New Project. */
function projectRow(page: Page, name: string) {
  return sidebar(page).getByRole("navigation", { name: "Projects" }).getByRole("button", { name, exact: true });
}

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

test.describe("signing in and setting up an empty Install", () => {
  let fresh: Install | undefined;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    fresh = await startInstall();
  });

  test.afterAll(async () => {
    await fresh?.stop();
  });

  test("a browser with no cookie sees the signed-out page", async ({ page }) => {
    await page.goto(`${fresh!.base}/`);
    await expect(page.getByRole("heading", { name: "Sign in to Darkory" })).toBeVisible();
    await expect(page.getByText("darkory login <member>")).toBeVisible();
    // This Install does not email login links, so it offers no form for one.
    await expect(page.getByRole("heading", { name: "Get a link by email" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await shot(page, "01-signed-out");
  });

  test("the startup link signs in; the checklist leads to the first Task; the shell around it", async ({ page }) => {
    const at = fresh!.base;
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));

    await test.step("the startup link's page signs in on its button and lands on the Inbox", async () => {
      await page.goto(fresh!.link);
      await shot(page, "02-login-link");
      await page.getByRole("button", { name: /^Sign in as / }).click();
      await expect(page).toHaveURL(`${at}/inbox`);
      // Live updates arriving: the dot beside the Organisation says so.
      await expect(sidebar(page).getByRole("status")).toHaveText("Connected");
    });

    const setup = page.getByRole("region", { name: "Set up E2E Organisation" });
    await test.step("a fresh Install: init's MAIN is the first item, done; Add Member is next, File Task waits", async () => {
      await expect(setup).toBeVisible();
      await expect(setup.getByLabel("1 of 3, done")).toBeVisible();
      await expect(setup.getByLabel("2 of 3, done")).toHaveCount(0);
      // MAIN is there, named; New Project beside it makes another.
      await expect(setup).toContainText("Project: Main");
      await expect(setup.getByRole("button", { name: "New Project" })).toBeVisible();
      await expect(setup.getByRole("button", { name: "File Task" })).toBeDisabled();
      await expect(projectRow(page, "Main")).toHaveAttribute("aria-expanded", "true");
      await shot(page, "03-checklist-fresh");
    });

    await test.step("another Project, Web, from New Project under the sidebar's Projects", async () => {
      await projectRow(page, "New Project").click();
      const dialog = page.getByRole("dialog", { name: "New Project" });
      await dialog.getByLabel("Name").fill("Web");
      await expect(dialog.getByLabel("Key")).toHaveValue("WEB");
      await shot(page, "04-new-project");
      await dialog.getByRole("button", { name: "Create Project" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${at}/projects/WEB/`));
      await page.goto(`${at}/inbox`);
      // Web, last shown, is current: unfolded; Main folds.
      await expect(projectRow(page, "Web")).toHaveAttribute("aria-expanded", "true");
      await expect(projectRow(page, "Main")).toHaveAttribute("aria-expanded", "false");
      await shot(page, "05-web-made");
    });

    await test.step("Add Member opens New Member in Settings; once made, step 2 is done", async () => {
      await setup.getByRole("link", { name: "Add Member" }).click();
      await expect(page).toHaveURL(`${at}/settings/organisation/members?new=1`);
      const dialog = page.getByRole("dialog", { name: "New Member" });
      await dialog.getByRole("radio", { name: "Agent" }).click();
      await dialog.getByLabel("Name").fill("builder");
      await shot(page, "06-checklist-new-member");
      await dialog.getByRole("button", { name: /^Create / }).click();
      await page.getByRole("dialog", { name: "Token for builder" }).getByRole("button", { name: "Done" }).click();
      await page.goto(`${at}/inbox`);
      await expect(setup.getByLabel("2 of 3, done")).toBeVisible();
      await shot(page, "07-checklist-member-made");
    });

    await test.step("File Task files the first Task; the checklist gives way to the Inbox, live", async () => {
      await markLoaded(page);
      await setup.getByRole("button", { name: "File Task" }).click();
      const dialog = page.getByRole("dialog", { name: "File a Task" });
      await expect(dialog).toContainText("In WEB.");
      await dialog.getByLabel("Title").fill("Checkout flow");
      await shot(page, "08-checklist-file-task");
      await dialog.getByRole("button", { name: "File Task" }).click();
      await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
      await expect(setup).toHaveCount(0);
      await notReloaded(page);
      await shot(page, "09-inbox-after-checklist");
    });

    await test.step("a Task filed elsewhere appears without reloading", async () => {
      await page.goto(`${at}/projects/WEB/tasks`);
      await expect(page.locator("#main [data-task=WEB-1]")).toBeVisible();
      await markLoaded(page);
      await write(page, "POST", "/v1/tasks", { project: "WEB", title: "Cart page", step: "Build" });
      await expect(page.locator("#main [data-task=WEB-2]")).toContainText("Cart page");
      await notReloaded(page);
      await shot(page, "10-live-list");
    });

    await test.step("⌘K finds a Task by key and by words", async () => {
      await page.keyboard.press("ControlOrMeta+k");
      const search = page.getByRole("dialog", { name: "Search" });
      await search.getByRole("combobox").fill("WEB-2");
      await expect(search.getByRole("option", { name: /WEB-2 Cart page/ })).toBeVisible();
      await search.getByRole("combobox").fill("checkout");
      await expect(search.getByRole("option", { name: /WEB-1 Checkout flow/ })).toBeVisible();
      await shot(page, "11-search");
      await search.getByRole("option", { name: /WEB-1 Checkout flow/ }).click();
      await expect(page).toHaveURL(`${at}/tasks/WEB-1`);
    });

    await test.step("C opens File a Task; G B opens the board", async () => {
      await page.keyboard.press("c");
      await expect(page.getByRole("dialog", { name: "File a Task" })).toContainText("In WEB.");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.keyboard.press("g");
      await page.keyboard.press("b");
      await expect(page).toHaveURL(`${at}/projects/WEB/tasks?view=board`);
      await expect(page.locator("[data-task=WEB-2]")).toBeVisible();
      await shot(page, "12-board");
    });

    await test.step("J walks the list, Enter opens the peek beside it, Esc returns to the row; ? and G I answer", async () => {
      await page.goto(`${at}/projects/WEB/tasks?view=list`);
      await expect(page.locator("#main [data-task=WEB-1]")).toBeVisible();
      await page.keyboard.press("j");
      const selected = page.locator("#main [data-task][data-selected=true]");
      await expect(selected).toHaveCount(1);
      await expect(selected).toBeFocused();
      const key = (await selected.getAttribute("data-task"))!;
      const row = page.locator(`#main [data-task=${key}]`);
      await page.keyboard.press("Enter");
      const peek = page.getByRole("dialog", { name: `Task ${key}` });
      await expect(peek).toBeVisible();
      // Not modal: no scrim, and the row under it keeps the ring.
      await expect(page.locator("[data-slot=sheet-overlay]")).toHaveCount(0);
      await expect(row).toHaveAttribute("data-selected", "true");
      await shot(page, "13-peek-keys");
      await page.keyboard.press("Escape");
      await expect(peek).toHaveCount(0);
      await expect(row).toBeFocused();

      await page.keyboard.press("?");
      const keys = page.getByRole("dialog", { name: "Shortcuts" });
      await expect(keys.getByText("Go to Inbox")).toBeVisible();
      await shot(page, "14-shortcuts");
      await page.keyboard.press("Escape");
      await expect(keys).toHaveCount(0);
      await page.keyboard.press("g");
      await page.keyboard.press("i");
      await expect(page).toHaveURL(`${at}/inbox`);
    });

    await test.step("?task= opens the peek over the board, and the page from it", async () => {
      await page.goto(`${at}/projects/WEB/tasks?view=board&task=WEB-2`);
      const peek = page.getByRole("dialog", { name: "Task WEB-2" });
      await expect(peek).toBeVisible();
      await shot(page, "15-peek-over-board");
      await peek.getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Open as page" }).click();
      await expect(page).toHaveURL(`${at}/tasks/WEB-2`);
    });

    await test.step("at phone width nothing scrolls sideways, and the sidebar is a sheet", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const path of ["/inbox", "/projects/WEB/tasks?view=board", "/tasks/WEB-2", "/settings/organisation/members"]) {
        await page.goto(`${at}${path}`);
        await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
        await noSidewaysScroll(page);
        await shot(page, `16-phone${path.replace(/[/?=&]/g, "-")}`);
      }
      await page.goto(`${at}/projects/WEB/tasks?view=board`);
      await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
      await expect(sidebar(page)).toBeVisible();
      await expect(projectRow(page, "Web")).toHaveAttribute("aria-expanded", "true");
      await noSidewaysScroll(page);
      await shot(page, "17-phone-sidebar");
      // The Organisation menu opens from the sheet and fits the phone.
      await sidebar(page).getByRole("button", { name: "E2E Organisation" }).click();
      await page.getByRole("menuitem", { name: /^Switch Organisation/ }).press("ArrowRight");
      await expect(page.getByRole("menuitem", { name: "Profile" })).toBeVisible();
      await noSidewaysScroll(page);
      await shot(page, "18-phone-organisation-menu");
      await page.getByRole("menuitem", { name: "Profile" }).click();
      await expect(page).toHaveURL(`${at}/settings/account`);
    });

    // Nothing the Install's CSP refuses, and no other error.
    expect(errors).toEqual([]);
  });
});

test.describe("the Session panel with no Runner", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    install = await startInstall();
    ({ base, token } = install);
    const ada = (method: string, path: string, body?: unknown) => v1(token, "e2e-session-ada", method, path, body);

    // ses-builder is an agent the Runner would start (it has agent settings); it holds SES-1 at Build.
    await ada("POST", "/v1/members", { name: "ses-builder", kind: "agent" });
    await ada("POST", "/v1/projects", { key: "SES", name: "Sessions", members: ["ada", "ses-builder"] });
    await ada("PUT", "/v1/members/ses-builder/skills/engineer");
    await ada("PATCH", "/v1/members/ses-builder/agent", { model: "claude-sonnet-5-5" });
    const agent = await v1<{ secret: string }>(token, "e2e-session-ada", "POST", "/v1/members/ses-builder/tokens", { name: "e2e" });
    const filed = await v1<{ task: { id: string; key: string } }>(token, "e2e-session-ada", "POST", "/v1/tasks", {
      project: "SES",
      title: "Build the cart page",
      step: "Build",
    });
    taskKey = filed.task.key;
    taskId = filed.task.id;
    await v1(agent.secret, "sess-ses-builder", "POST", `/v1/tasks/${taskKey}/claim`, { heartbeat_timeout_seconds: 600 });

    const { url } = await v1<{ url: string }>(token, "e2e-session-ada", "POST", "/v1/members/ada/login-links");
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(url);
    await page.getByRole("button", { name: /^Sign in as / }).click();
    await expect(page).toHaveURL(`${base}/inbox`);
    signedIn = await ctx.storageState();
    await ctx.close();
  });

  test.afterAll(async () => {
    await install?.stop();
  });

  test("no Runner attached: the panel is absent, Nudge and Stop answer no_runner, and the Agents page pauses the agent", async ({ browser }) => {
    const { ctx, page, errors } = await open(browser);
    const asked: number[] = [];
    page.on("response", (r) => {
      if (new URL(r.url()).pathname === "/v1/runner/sessions") asked.push(r.status());
    });

    await page.goto(`${base}/tasks/${taskKey}`);
    await expect(page.getByRole("heading", { name: "Build the cart page", level: 1 })).toBeVisible();
    await expect.poll(() => asked).toEqual([200]);
    await expect(page.getByRole("complementary", { name: "Properties" }).getByRole("button", { name: "Copy the Session id sess-ses-builder" })).toHaveText("…-builder");
    await expect(page.getByRole("region", { name: "Session" })).toHaveCount(0);
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menuitem", { name: "Take back" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Nudge" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // No Runner: the page asks once, not every 5 s.
    await page.waitForTimeout(6_000);
    expect(asked).toEqual([200]);
    expect(await v1(token, "e2e-session-ada", "GET", "/v1/runner/sessions")).toEqual({ items: [], runner: false });
    await shot(page, "1-no-runner-task");

    for (const what of ["nudge", "stop"]) {
      const res = await send(token, "e2e-session-ada", "POST", `/v1/runner/sessions/${taskKey}/${what}`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("no_runner");
    }

    // The Project's Agents page: no session, and an admin pauses and resumes the agent.
    await page.goto(`${base}/projects/SES/agents`);
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "ses-builder", exact: true }) });
    await expect(row).toContainText("No session");
    await row.hover();
    await row.getByRole("button", { name: "More for ses-builder" }).click();
    await page.getByRole("menuitem", { name: "Pause" }).click();
    await expect(row.getByText("Paused")).toBeVisible();
    const detail = await v1<{ member: { agent?: { paused: boolean } } }>(token, "e2e-session-ada", "GET", "/v1/members/ses-builder");
    expect(detail.member.agent?.paused).toBe(true);
    await shot(page, "2-agents-paused");
    await row.hover();
    await row.getByRole("button", { name: "More for ses-builder" }).click();
    await page.getByRole("menuitem", { name: "Resume" }).click();
    await expect(row.getByText("Paused")).toHaveCount(0);

    expect(errors).toEqual([]);
    await ctx.close();
  });

  test("the terminal under the Install's CSP, the Runner played by the test: watch, Join, type, resize, Leave", async ({ browser }) => {
    const { ctx, page, errors } = await open(browser);
    const session = {
      task_id: taskId,
      member_id: "",
      session_id: "sess-ses-builder",
      host: "mac-mini",
      tmux: `dk-${taskKey}`,
      started_at: new Date().toISOString(),
      state: "running",
      log_path: `/data/sessions/${taskKey}/pane.log`,
    };
    const members = await v1<{ items: { id: string; name: string }[] }>(token, "e2e-session-ada", "GET", "/v1/members");
    session.member_id = members.items.find((m) => m.name === "ses-builder")!.id;
    await page.route("**/v1/runner/sessions", (route) => route.fulfill({ json: { items: [session], runner: true } }));

    const sockets: { url: string; text: string[]; typed: string }[] = [];
    await page.routeWebSocket(/\/v1\/runner\/sessions\/[^/]+\/terminal/, (ws) => {
      const seen = { url: ws.url(), text: [] as string[], typed: "" };
      sockets.push(seen);
      ws.onMessage((m) => {
        if (typeof m === "string") seen.text.push(m);
        else seen.typed += m.toString();
      });
      // What tmux would draw: a truecolor prompt, which xterm colours through a style the CSP allows.
      ws.send(Buffer.from("\x1b[38;2;120;80;220mbuilder\x1b[0m is running the tests\r\n$ "));
    });

    await page.goto(`${base}/tasks/${taskKey}`);
    const panel = page.getByRole("region", { name: "Session" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(`darkory join ${taskKey}`);
    await expect(panel).toContainText("Running");
    await expect(panel.locator(".xterm-rows")).toContainText("builder is running the tests");
    await expect(panel.getByRole("status")).toHaveText("Read-only · Join to type");
    expect(sockets[0].url).toMatch(new RegExp(`/v1/runner/sessions/${taskKey}/terminal\\?readonly=1$`));
    await expect.poll(() => sockets[0].text.map((t) => JSON.parse(t))).toContainEqual({ cols: expect.any(Number), rows: expect.any(Number) });
    await shot(page, "3-terminal-watching");
    // A selected line stays readable over the selection colour.
    await panel.locator(".xterm-screen").click({ clickCount: 3, position: { x: 40, y: 6 } });
    await shot(page, "3b-terminal-selection");

    await panel.getByRole("button", { name: "Join", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Joined · your keys go to the session");
    expect(sockets[1].url).toMatch(new RegExp(`/v1/runner/sessions/${taskKey}/terminal$`));
    await page.keyboard.type("ls");
    await page.keyboard.press("Enter");
    await expect.poll(() => sockets[1].typed).toBe("ls\r");
    // J is the session's while the terminal has the focus.
    await page.keyboard.press("j");
    await expect.poll(() => sockets[1].typed).toBe("ls\rj");
    await shot(page, "4-terminal-joined");

    await panel.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Read-only · Join to type");
    expect(sockets[2].url).toMatch(/\?readonly=1$/);

    // The terminal takes the app's colours, dark too.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(panel.locator(".xterm-rows")).toContainText("builder is running the tests");
    await shot(page, "5-terminal-dark");
    await page.emulateMedia({ colorScheme: "light" });

    // The Project's Agents page: the session's state has a column of its own, beside what the
    // agent holds; the agent's peek opens the Task's at its panel with View.
    await page.goto(`${base}/projects/SES/agents`);
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "ses-builder", exact: true }) });
    await expect(row.getByRole("cell").nth(1)).toContainText(taskKey);
    await expect(row.getByRole("cell").nth(2)).toContainText("Running");
    await expect(row.getByRole("cell").nth(2)).toContainText(`dk-${taskKey}`);
    await shot(page, "6-agents-running");
    await row.getByRole("link", { name: "ses-builder", exact: true }).click();
    const agentPeek = page.getByRole("dialog", { name: "Agent ses-builder" });
    await expect(agentPeek).toContainText("claude-sonnet-5-5");
    await shot(page, "6b-agent-peek");
    await agentPeek.getByRole("link", { name: "View" }).click();
    const peek = page.getByRole("dialog", { name: `Task ${taskKey}` });
    await expect(peek.getByRole("region", { name: "Session" }).locator(".xterm-rows")).toContainText("builder is running the tests");
    await expect(page).toHaveURL(new RegExp(`/projects/SES/agents\\?task=${taskKey}#session$`));
    await shot(page, "6c-peek-over-agents");

    // A phone: the page with a terminal on it does not scroll sideways.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${base}/tasks/${taskKey}`);
    await expect(panel.locator(".xterm-rows")).toContainText("builder is running the tests");
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
    await shot(page, "7-phone");

    expect(errors).toEqual([]);
    await ctx.close();
  });
});

/** Calls /v1 on another Install with a token and the Session it names; a refusal throws. */
function at(base: string, secret: string, session: string) {
  return async <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, "Darkory-Session": session, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
}

function hasTmux(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v tmux"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type LiveDetail = {
  task: { claim?: unknown };
  notes: { body: string }[];
  evidence: { id: string; filename: string }[];
};

for (const tmux of ["on", "off"] as const) {
  test.describe(`with a Runner, sessions ${tmux === "on" ? "in tmux" : "as child processes"}`, () => {
    let live: RunnerInstall | undefined;

    test.beforeAll(async () => {
      test.skip(tmux === "on" && !hasTmux(), "no tmux on this machine");
      test.setTimeout(240_000);
      live = await startRunnerInstall(tmux, async ({ base, token, fakeagent, scratch }) => {
        const ada = at(base, token, "e2e-live-ada");
        // builder runs the fake agent, busy until /exit: it keeps writing progress, so the Runner
        // keeps its Heartbeats and never nudges. The other agents of the roster are paused.
        const progress = join(scratch, "{session_id}.jsonl");
        await ada("PATCH", "/v1/members/builder/agent", {
          command: fakeagent,
          args: ["--prompt-file", "{prompt_file}", "--progress", progress, "--mcp-config", "{mcp_config}"],
          model: "fake-1",
          env: { FAKEAGENT_SCENARIO: "busy" },
          unattended: true,
          paused: false,
          progress_file: progress,
        });
        for (const name of ["planner", "reviewer", "retro"]) await ada("PATCH", `/v1/members/${name}/agent`, { paused: true });
      });
    });

    test.afterAll(async () => {
      await live?.stop();
    });

    test(`the Runner's session live: watch, ${tmux === "on" ? "Join and type, " : ""}Pause, Stop`, async ({ browser }) => {
      test.setTimeout(120_000);
      const { base, token } = live!;
      const ada = at(base, token, "e2e-live-ada");
      const filed = await ada<{ task: { key: string } }>("POST", "/v1/tasks", { project: "MAIN", title: "Fix the typo", step: "Build" });
      const key = filed.task.key;
      const sessions = () => ada<{ items: { task_id: string; tmux?: string }[]; runner: boolean }>("GET", "/v1/runner/sessions");
      // The Runner claims it as builder and starts the fake agent.
      await expect.poll(async () => (await sessions()).items.length, { timeout: 30_000 }).toBe(1);
      expect((await sessions()).items[0].tmux).toBe(tmux === "on" ? `dk-${key}` : undefined);

      const { url } = await ada<{ url: string }>("POST", "/v1/members/ada/login-links");
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(e.message));
      const sockets: string[] = [];
      page.on("websocket", (ws) => sockets.push(ws.url()));
      await page.goto(url);
      await page.getByRole("button", { name: /^Sign in as / }).click();
      await expect(page).toHaveURL(`${base}/inbox`);

      // Agents: builder's session and what it holds. Pause it first, or the Task Stop releases
      // goes straight back to builder.
      await page.goto(`${base}/projects/MAIN/agents`);
      const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "builder", exact: true }) });
      await expect(row.getByRole("cell").nth(1)).toContainText(key);
      await expect(row.getByRole("cell").nth(2)).toContainText("Running");
      await row.hover();
      await row.getByRole("button", { name: "More for builder" }).click();
      await page.getByRole("menuitem", { name: "Pause" }).click();
      await expect(row.getByText("Paused")).toBeVisible();
      await shot(page, `runner-8-live-agents-tmux-${tmux}`);

      await row.getByRole("link", { name: "builder", exact: true }).click();
      const agentPeek = page.getByRole("dialog", { name: "Agent builder" });
      await expect(agentPeek).toContainText("fake-1");
      await agentPeek.getByRole("link", { name: "View" }).click();
      const peek = page.getByRole("dialog", { name: `Task ${key}` });
      const panel = peek.getByRole("region", { name: "Session" });
      await expect(panel).toContainText(tmux === "on" ? `tmux dk-${key}` : "no tmux");
      if (tmux === "on") {
        // Watching, read-only: tmux draws what the fake agent printed.
        const screen = panel.locator(".xterm-rows");
        await expect(screen).toContainText("fakeagent: busy until /exit", { timeout: 15_000 });
        await expect(panel.getByRole("status")).toHaveText("Read-only · Join to type");
        expect(sockets[0]).toMatch(new RegExp(`/v1/runner/sessions/${key}/terminal\\?readonly=1$`));
        await shot(page, "runner-9-live-watching");

        // Joined, a line typed in the browser reaches the fake agent, which says it read it.
        await panel.getByRole("button", { name: "Join", exact: true }).click();
        await expect(panel.getByRole("status")).toHaveText("Joined · your keys go to the session");
        // The joined socket starts from a cleared screen; type once tmux has attached and drawn it,
        // as a person would (keys sent before tmux takes the terminal are lost).
        await expect(screen).toContainText("fakeagent: busy until /exit");
        await page.keyboard.type("hello from the web");
        await page.keyboard.press("Enter");
        await expect(screen).toContainText('fakeagent: read "hello from the web"');
        await expect.poll(async () => (await ada<LiveDetail>("GET", `/v1/tasks/${key}`)).notes.map((n) => n.body)).toContain("ada joined the session.");
        await shot(page, "runner-10-live-joined");
      } else {
        // Without tmux the session cannot be joined: no terminal, no WebSocket.
        await expect(panel).toContainText("This session runs without tmux and cannot be joined");
        await expect(panel.locator(".xterm")).toHaveCount(0);
        expect(sockets).toEqual([]);
        await shot(page, "runner-9-live-child");
      }

      // Stop from the peek's ⋯ menu: the session ends, its Claim is released with a Note, and its
      // log is Evidence.
      await peek.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Stop session" }).click();
      const confirm = page.getByRole("dialog", { name: `Stop the session on ${key}?` });
      await expect(confirm).toContainText("Its Claim is released, with a Note saying so");
      await shot(page, `runner-11-live-stop-tmux-${tmux}`);
      await confirm.getByRole("button", { name: "Stop session" }).click();
      await expect(panel).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(async () => (await sessions()).items.length).toBe(0);
      const detail = await ada<LiveDetail>("GET", `/v1/tasks/${key}`);
      expect(detail.task.claim).toBeUndefined();
      expect(detail.notes.map((n) => n.body).join("\n")).toContain("An admin stopped the session");
      const log = detail.evidence.find((e) => new RegExp(`^session-${key}-builder-\\d{6}\\.log$`).test(e.filename));
      expect(log, "the session's log is Evidence").toBeDefined();
      const text = await (await fetch(`${base}/v1/evidence/${log!.id}/content`, { headers: { Authorization: `Bearer ${token}`, "Darkory-Session": "e2e-live-ada" } })).text();
      expect(text).toContain("fakeagent: busy until /exit");
      if (tmux === "on") expect(text).toContain('fakeagent: read "hello from the web"');
      await shot(page, `runner-12-live-stopped-tmux-${tmux}`);

      expect(errors).toEqual([]);
      await ctx.close();
    });
  });
}
