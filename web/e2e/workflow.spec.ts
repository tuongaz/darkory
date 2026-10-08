import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall } from "./server";

// Scenarios 6 and 9 of docs/build/model-v2-plan.md against the real binary, on an Install of
// their own (init's MAIN with the default Workflow and the roster's agents):
//   6. Workflow editing in the list: rename a Step, add one with a new Skill, delete one with Tasks
//      (asked where they go), all saved in one go; the open board's columns follow.
//   9. Marks: an agent's gradient border, turning while its Claim is live; a human's plain border.
// And, first, the live canvas as things happen: a Task filed, picked up, advanced and completed.
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/workflow/", import.meta.url));
const liveShots = fileURLToPath(new URL("./screenshots/live/", import.meta.url));

let stop: (() => Promise<void>) | undefined;
let base = "";
let token = "";
let signedIn: Awaited<ReturnType<BrowserContext["storageState"]>>;

/** A /v1 call with `secret` as the bearer (ada's unless given). */
async function v1(method: string, path: string, body?: unknown, secret = token, session = "e2e-workflow") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Darkory-Session": session,
      "Idempotency-Key": crypto.randomUUID(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const install = await startInstall({ roster: true });
  ({ stop, base, token } = install);
  const { url } = (await v1("POST", "/v1/members/ada/login-links")) as { url: string };
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

async function open(browser: Browser, path: string, size = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ storageState: signedIn, viewport: size });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}${path}`);
  return { ctx, page, errors };
}

const node = (page: Page, name: string) => page.locator(".react-flow__node").filter({ has: page.getByText(name, { exact: true }) }).first();

/** A fresh token for a roster agent, by name. */
async function agentToken(name: string): Promise<string> {
  const { items } = (await v1("GET", "/v1/members")) as { items: { id: string; name: string }[] };
  const m = items.find((x) => x.name === name)!;
  return ((await v1("POST", `/v1/members/${m.id}/tokens`, { name: `live-${name}` })) as { secret: string }).secret;
}

test("live: a Task filed shows at Build, its pickup is called out, it travels to Review and into Done, the trail says each", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, "/projects/MAIN/workflow");
  const canvas = page.getByRole("region", { name: "Workflow", exact: true });
  const trail = page.getByRole("complementary", { name: "Live trail" });
  await expect(canvas.locator(".react-flow__edge").first()).toBeVisible();
  await expect(trail.getByRole("status")).toHaveText("Live");
  await page.screenshot({ path: `${liveShots}0-open.png` });

  // Filed through /v1: its chip fades in at Build with a "filed" callout.
  const filed = ((await v1("POST", "/v1/tasks", { project: "MAIN", title: "Count the ledger", step: "Build" })) as { task: { key: string } }).task;
  const chip = () => node(page, "Build").getByRole("button", { name: new RegExp(`^${filed.key} Count the ledger`) });
  await expect(chip()).toHaveAttribute("aria-label", `${filed.key} Count the ledger, waiting`);
  await expect(page.locator(".flow-callout", { hasText: `ada filed ${filed.key}` })).toBeVisible();
  await expect(trail.getByRole("listitem").first()).toHaveAccessibleName(`ada filed ${filed.key} at Build`);
  await page.screenshot({ path: `${liveShots}1-filed.png` });

  // builder claims it with its own token and Session: called out, its mark ringed on the chip, a trail row.
  const builder = await agentToken("builder");
  await v1("POST", `/v1/tasks/${filed.key}/claim`, { heartbeat_timeout_seconds: 600 }, builder, "builder-live-1");
  await expect(page.locator(".flow-callout", { hasText: `builder picked up ${filed.key}` })).toBeVisible();
  await expect(chip()).toHaveAttribute("aria-label", `${filed.key} Count the ledger, held by builder (agent)`);
  await expect(chip()).toHaveAttribute("data-live", "agent");
  await expect(chip().getByRole("img", { name: "builder (agent), working" })).toHaveAttribute("data-working", "running");
  await expect(trail.getByRole("listitem").first()).toHaveAccessibleName(`builder picked up ${filed.key} at Build`);
  await expect(trail).toContainText("1 working now");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${liveShots}2-picked-up.png` });

  // It advances along pass: a token travels the drawn line to Review (shot mid-way), the outcome lit.
  await v1("POST", `/v1/tasks/${filed.key}/advance`, { outcome: "pass" }, builder, "builder-live-1");
  const token = page.locator(".flow-token");
  await expect(token).toHaveText(filed.key);
  await expect(canvas.locator('[data-lit="true"]')).toHaveText("pass");
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${liveShots}3-travelling.png` });
  await expect(token).toHaveCount(0, { timeout: 4_000 });
  const atReview = node(page, "Review").getByRole("button", { name: new RegExp(`^${filed.key} `) });
  await expect(atReview).toHaveAttribute("aria-label", `${filed.key} Count the ledger, waiting`);
  await expect(trail.getByRole("listitem").first()).toHaveAccessibleName(`builder advanced ${filed.key} along pass to Review`);
  await page.screenshot({ path: `${liveShots}4-at-review.png` });

  // reviewer picks it up and completes it along pass: into Done, and Review is as it was.
  const reviewer = await agentToken("reviewer");
  await v1("POST", `/v1/tasks/${filed.key}/claim`, {}, reviewer, "reviewer-live-1");
  await expect(page.locator(".flow-callout", { hasText: `reviewer picked up ${filed.key}` })).toBeVisible();
  await v1("POST", `/v1/tasks/${filed.key}/advance`, { outcome: "pass" }, reviewer, "reviewer-live-1");
  await expect(token).toHaveText(filed.key);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${liveShots}5-into-done.png` });
  await expect(trail.getByRole("listitem").first()).toHaveAccessibleName(`reviewer completed ${filed.key} along pass · from Review`);
  await expect(node(page, "Review").getByRole("button", { name: new RegExp(`^${filed.key} `) })).toHaveCount(0);
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: `${liveShots}6-done.png` });

  // Dark, the same moment: a pickup at Build.
  await page.emulateMedia({ colorScheme: "dark" });
  const again = ((await v1("POST", "/v1/tasks", { project: "MAIN", title: "Recount the ledger", step: "Build" })) as { task: { key: string } }).task;
  await v1("POST", `/v1/tasks/${again.key}/claim`, { heartbeat_timeout_seconds: 600 }, builder, "builder-live-2");
  await expect(page.locator(".flow-callout", { hasText: `builder picked up ${again.key}` })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${liveShots}7-picked-up-dark.png` });
  await v1("POST", `/v1/tasks/${again.key}/release`, undefined, builder, "builder-live-2");
  await expect(page.locator(".flow-callout", { hasText: `builder let go of ${again.key}` })).toBeVisible();
  await v1("POST", `/v1/tasks/${again.key}/drop`, undefined);
  await expect(trail.getByRole("listitem").first()).toContainText(`ada dropped ${again.key}`);

  // Opened afresh, the trail starts from the Project's recent moves, read from /v1/activity.
  await page.reload();
  await expect(trail.getByRole("listitem").first()).toContainText(`ada dropped ${again.key}`);
  await expect(trail.getByRole("listitem").filter({ hasText: `ada filed ${filed.key} at Build` })).toHaveCount(1);
  // Filed, picked up, advanced, picked up, completed; filed, picked up, let go of, dropped.
  await expect(trail.getByRole("listitem")).toHaveCount(9);
  await page.screenshot({ path: `${liveShots}8-reopened-dark.png` });

  expect(errors).toEqual([]);
  await ctx.close();
});

test("scenario 6: rename a Step while the board is open, delete one with Tasks, add one with a new Skill, all saved in one go", async ({ browser }) => {
  // Two Tasks at Review, to be moved when it is deleted.
  for (const title of ["Check the ledger", "Check the totals"]) await v1("POST", "/v1/tasks", { project: "MAIN", title, step: "Review" });

  const board = await open(browser, "/projects/MAIN/tasks?view=board");
  await expect(board.page.getByText("Build", { exact: true }).first()).toBeVisible();
  await board.page.screenshot({ path: `${shots}6-01-board-before.png`, animations: "disabled" });

  const { page, errors, ctx } = await open(browser, "/settings/projects/MAIN/workflow");
  const list = page.getByRole("list", { name: "Steps" });
  await expect(list.getByRole("listitem", { name: "3. Build" })).toBeVisible();
  await page.screenshot({ path: `${shots}6-02-editing.png`, animations: "disabled" });

  // Rename Build to Make: nothing is sent yet, the board keeps Build.
  await page.getByRole("textbox", { name: "Name of Step 3" }).fill("Make");
  await expect(page.getByText("Editing · 1 change")).toBeVisible();
  await page.screenshot({ path: `${shots}6-03-renamed.png`, animations: "disabled" });

  // Add QA after Make with a new Skill: Make's pass now leads into QA, which leads on to Review.
  await list.getByRole("button", { name: "Add a Step after Make" }).click();
  await page.getByRole("textbox", { name: "Name of Step 4" }).fill("QA");
  await page.getByRole("combobox", { name: "Skill of QA" }).click();
  await page.getByPlaceholder("Find or name a Skill").fill("qa");
  await page.getByRole("option", { name: /New Skill “qa”/ }).click();
  const skillDialog = page.getByRole("dialog", { name: "New Skill “qa”" });
  await skillDialog.getByRole("textbox", { name: "Text" }).fill("Try it as a user would.");
  await page.screenshot({ path: `${shots}6-04-new-skill.png`, animations: "disabled" });
  await skillDialog.getByRole("button", { name: "Use this Skill" }).click();
  await expect(list.getByRole("listitem", { name: "3. Make" }).getByRole("combobox", { name: "Where pass out of Make leads" })).toHaveText("QA");

  // Delete Review: its two Tasks must go somewhere; QA's pass, which led into it, now leads into Done.
  await list.getByRole("button", { name: "Delete Review" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Review" });
  await expect(dialog).toContainText("2 Tasks are at Review");
  await expect(dialog.getByRole("button", { name: "Delete Review" })).toBeDisabled();
  await page.screenshot({ path: `${shots}6-05-delete-asks-where.png`, animations: "disabled" });
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "Make" }).click();
  await dialog.getByRole("button", { name: "Delete Review" }).click();
  await expect(list.getByRole("listitem", { name: /Review$/ })).toHaveCount(0);
  await expect(list.getByRole("listitem", { name: "4. QA" }).getByRole("combobox", { name: "Where pass out of QA leads" })).toHaveText("Done");
  await page.screenshot({ path: `${shots}6-06-before-save.png`, animations: "disabled" });

  // Save: the Skill, then the Workflow; the live Workflow, and the board's columns follow without a reload.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(`${base}/projects/MAIN/workflow`);
  await expect(board.page.getByText("Make", { exact: true }).first()).toBeVisible();
  await expect(board.page.getByText("Build", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${shots}6-07-saved.png`, animations: "disabled" });
  await board.page.screenshot({ path: `${shots}6-08-board-after-live.png`, animations: "disabled" });
  const moved = (await v1("GET", "/v1/tasks?project=MAIN&state=open")) as { items: { title: string; step_id?: string }[] };
  const wf = (await v1("GET", "/v1/projects/MAIN/workflow")) as { steps: { id: string; name: string; skill_id?: string }[] };
  const make = wf.steps.find((s) => s.name === "Make")!;
  expect(moved.items.filter((t) => t.title.startsWith("Check the")).every((t) => t.step_id === make.id)).toBe(true);
  const { items: skillList } = (await v1("GET", "/v1/skills")) as { items: { id: string; name: string }[] };
  expect(wf.steps.find((s) => s.name === "QA")!.skill_id).toBe(skillList.find((s) => s.name === "qa")!.id);

  // An agent for QA, for scenario 9.
  const bot = (await v1("POST", "/v1/members", { name: "qa-bot", kind: "agent" })) as { id: string };
  await v1("PUT", `/v1/projects/MAIN/members/${bot.id}`);
  await v1("PUT", `/v1/members/${bot.id}/skills/qa`);

  expect(errors).toEqual([]);
  expect(board.errors).toEqual([]);
  await board.ctx.close();
  await ctx.close();
});

test("scenario 9: an agent's mark turns while its Claim is live; a human's is a plain ring", async ({ browser }) => {
  // qa-bot (made above) claims a Task at QA with a Heartbeat timeout: live, no Runner session, so running.
  const bot = (await v1("GET", "/v1/members")) as { items: { id: string; name: string }[] };
  const qaBot = bot.items.find((m) => m.name === "qa-bot")!;
  const { secret } = (await v1("POST", `/v1/members/${qaBot.id}/tokens`, { name: "scenario-9" })) as { secret: string };
  const filed = ((await v1("POST", "/v1/tasks", { project: "MAIN", title: "Test the ledger", step: "QA" })) as { task: { key: string } }).task;
  await v1("POST", `/v1/tasks/${filed.key}/claim`, { heartbeat_timeout_seconds: 600 }, secret, "qa-bot-1");
  // ada takes Make's Tasks.
  await v1("PUT", "/v1/projects/MAIN/members/ada");
  await v1("PUT", "/v1/members/ada/skills/engineer");

  const { page, errors, ctx } = await open(browser, "/projects/MAIN/workflow");
  // The taker's mark, under the Task's chip (which carries the holder's mark too).
  const mark = node(page, "QA").getByRole("img", { name: "qa-bot (agent), working" }).last();
  await expect(mark).toHaveAttribute("data-working", "running");
  await expect(mark).toHaveAttribute("data-kind", "agent");
  const spin = () => mark.evaluate((el) => getComputedStyle(el).getPropertyValue("--spin"));
  const first = await spin();
  await page.waitForTimeout(300);
  expect(await spin()).not.toBe(first);

  // ada, a human not working there: a plain ring, still.
  const ada = node(page, "Make").getByRole("img", { name: "ada" });
  await expect(ada).toHaveAttribute("data-kind", "human");
  await expect(ada).not.toHaveAttribute("data-working");
  await page.screenshot({ path: `${shots}9-01-marks.png`, animations: "disabled" });

  // The Step's peek lists the Task and its worker.
  // On its name: the middle of the node is its Tasks' chips, each opening its Task.
  await node(page, "QA").getByText("QA", { exact: true }).click();
  const peek = page.getByRole("dialog", { name: "Step QA" });
  await expect(peek.getByRole("list", { name: "Tasks at QA" })).toContainText("Test the ledger");
  await expect(peek.getByRole("list", { name: "Takers at QA" })).toContainText("Working here");
  await page.screenshot({ path: `${shots}9-02-step-peek.png`, animations: "disabled" });

  expect(errors).toEqual([]);
  await ctx.close();
});
