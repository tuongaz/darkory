import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import startServer from "./server";

// The Session panel and the Agents page's Runner state (docs/build/agents-plan.md, R2) against the
// real binary. They run on an Install of their own, as admin.spec.ts does: the agent here has
// agent settings, which a Runner attached to the shared Install would start sessions for. This
// branch's server has no Runner, so the panel must be absent; the live terminal is played by
// Playwright (page.route and page.routeWebSocket) until the Runner lands.
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/session/", import.meta.url));
const envKeys = ["DARKORY_E2E_LOGIN_LINK", "DARKORY_E2E_BASE_URL", "DARKORY_E2E_DATA", "DARKORY_E2E_ADMIN_TOKEN"] as const;

let stop: (() => Promise<void>) | undefined;
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

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const saved = envKeys.map((k) => [k, process.env[k]] as const);
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
  const ada = (method: string, path: string, body?: unknown) => v1(token, "e2e-session-ada", method, path, body);

  // ses-builder is an agent the Runner would start (it has agent settings); it holds SES-2.
  await ada("POST", "/v1/teams", { key: "SES", name: "Sessions" });
  await ada("POST", "/v1/skills", { name: "ses-engineer", kind: "generic", body: "Build what the Task asks for." });
  await ada("POST", "/v1/members", { name: "ses-builder", kind: "agent" });
  for (const m of ["ada", "ses-builder"]) await ada("PUT", `/v1/teams/SES/members/${m}`);
  await ada("PUT", "/v1/members/ses-builder/skills/ses-engineer");
  await ada("PATCH", "/v1/members/ses-builder/agent", { model: "claude-sonnet-5-5" });
  const agent = (await ada("POST", "/v1/members/ses-builder/tokens", { name: "e2e" })) as { secret: string };
  const feature = (await ada("POST", "/v1/features", { team: "SES", title: "Cart" })) as { feature: { key: string } };
  const filed = (await ada("POST", "/v1/tasks", { feature: feature.feature.key, title: "Build the cart page", skill: "ses-engineer" })) as {
    task: { id: string; key: string };
  };
  taskKey = filed.task.key;
  taskId = filed.task.id;
  await v1(agent.secret, "sess-ses-builder", "POST", `/v1/tasks/${taskKey}/claim`, { heartbeat_timeout_seconds: 600 });

  const { url } = await ada("POST", "/v1/members/ada/login-links") as { url: string };
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

test("no Runner attached: the panel is absent, Nudge and Stop answer no_runner, and the Agents page pauses the agent", async ({ browser }) => {
  const { ctx, page, errors } = await open(browser);
  const asked: number[] = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname === "/v1/runner/sessions") asked.push(r.status());
  });

  await page.goto(`${base}/tasks/${taskKey}`);
  await expect(page.getByRole("heading", { name: "Build the cart page", level: 1 })).toBeVisible();
  await expect.poll(() => asked).toEqual([200]);
  await expect(page.getByRole("complementary", { name: "Properties" })).toContainText("sess-ses-builder");
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

  // The Agents page: the agent's model is a fact, and an admin pauses and resumes it.
  await page.goto(`${base}/agents`);
  const row = page.getByRole("row").filter({ hasText: "ses-builder" });
  await expect(row).toContainText("claude-sonnet-5-5");
  await row.hover();
  await row.getByRole("button", { name: "More for ses-builder" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await expect(row.getByText("Paused")).toBeVisible();
  const detail = (await v1(token, "e2e-session-ada", "GET", "/v1/members/ses-builder")) as { member: { agent?: { paused: boolean } } };
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
  const members = (await v1(token, "e2e-session-ada", "GET", "/v1/members")) as { items: { id: string; name: string }[] };
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

  // The peek over the Agents page, which View opens at the panel.
  await page.goto(`${base}/agents`);
  const row = page.getByRole("row").filter({ hasText: "ses-builder" });
  await expect(row).toContainText("running since");
  await row.getByRole("link", { name: "View" }).click();
  const peek = page.getByRole("dialog", { name: `Task ${taskKey}` });
  await expect(peek.getByRole("region", { name: "Session" }).locator(".xterm-rows")).toContainText("builder is running the tests");
  await expect(page).toHaveURL(new RegExp(`/agents\\?task=${taskKey}#session$`));
  await shot(page, "6-peek-over-agents");

  // A phone: the page with a terminal on it does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${base}/tasks/${taskKey}`);
  await expect(panel.locator(".xterm-rows")).toContainText("builder is running the tests");
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  await shot(page, "7-phone");

  expect(errors).toEqual([]);
  await ctx.close();
});
