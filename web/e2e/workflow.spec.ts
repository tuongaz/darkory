import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall } from "./server";

// Scenarios 6 and 9 of docs/build/model-v2-plan.md against the real binary, on an Install of
// their own (init's MAIN with the default Workflow and the roster's agents):
//   6. Workflow editing in the list: rename a Step, add one with a new Skill, delete one with Tasks
//      (asked where they go), all saved in one go; the open board's columns follow; then a new
//      agent and a Member for Steps from their rows, at once, the No Member warning going.
//   9. Marks: an agent's gradient border, turning while its Claim is live; a human's plain border.
// And, first, the live line as things happen: a Task filed, picked up, advanced and completed.
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

/** A fresh token for a roster agent, by name. */
async function agentToken(name: string): Promise<string> {
  const { items } = (await v1("GET", "/v1/members")) as { items: { id: string; name: string }[] };
  const m = items.find((x) => x.name === name)!;
  return ((await v1("POST", `/v1/members/${m.id}/tokens`, { name: `live-${name}` })) as { secret: string }).secret;
}

test("live: a Task filed shows at Build on the line, its pickup reads now, it travels to Review and into Done", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, "/projects/MAIN/workflow");
  const line = page.getByRole("region", { name: "Workflow", exact: true });
  await expect(line.locator('[data-head="Build"]')).toBeVisible();
  await page.screenshot({ path: `${liveShots}0-open.png` });
  const token = (key: string) => line.locator(`button[data-task="${key}"]`);
  const tag = (key: string) => token(key).locator("xpath=..").locator("[data-tag]");
  /** Whether the Task's token stands in its Step's column. */
  const at = async (key: string, step: string) => {
    const [t, h] = [await token(key).boundingBox(), await line.locator(`[data-head="${step}"]`).boundingBox()];
    return !!t && !!h && Math.abs(t.x + t.width / 2 - (h.x + h.width / 2)) < 8;
  };

  // Filed through /v1: its token appears at Build, tagged with who filed it.
  const filed = ((await v1("POST", "/v1/tasks", { project: "MAIN", title: "Count the ledger", step: "Build" })) as { task: { key: string } }).task;
  await expect(token(filed.key)).toHaveAttribute("aria-label", `${filed.key} Count the ledger, waiting`);
  expect(await at(filed.key, "Build")).toBe(true);
  await expect(tag(filed.key)).toContainText("ada filed");
  await page.screenshot({ path: `${liveShots}1-filed.png` });

  // builder claims it with its own token and Session: the token fills and reads "now", tagged with the pickup.
  const builder = await agentToken("builder");
  await v1("POST", `/v1/tasks/${filed.key}/claim`, { heartbeat_timeout_seconds: 600 }, builder, "builder-live-1");
  await expect(token(filed.key)).toHaveAttribute("aria-label", `${filed.key} Count the ledger, held by builder (agent)`);
  await expect(token(filed.key)).toHaveAttribute("data-now", "");
  await expect(token(filed.key)).toContainText("now");
  await expect(tag(filed.key)).toContainText("builder picked up");
  await expect(token(filed.key).getByRole("img", { name: "builder (agent), working" })).toHaveAttribute("data-working", "running");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${liveShots}2-picked-up.png` });

  // It advances along pass: a token travels the line to Review (shot mid-way), the outcome lit.
  await v1("POST", `/v1/tasks/${filed.key}/advance`, { outcome: "pass" }, builder, "builder-live-1");
  const travelling = page.locator(`[data-travel="${filed.key}"]`);
  await expect(travelling).toContainText(`${filed.key}pass`);
  await expect(line.locator('[data-lit="true"]').first()).toHaveText("pass");
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${liveShots}3-travelling.png` });
  await expect(travelling).toHaveCount(0, { timeout: 4_000 });
  await expect(token(filed.key)).toHaveAttribute("aria-label", `${filed.key} Count the ledger, waiting`);
  expect(await at(filed.key, "Review")).toBe(true);
  await page.screenshot({ path: `${liveShots}4-at-review.png` });

  // reviewer picks it up and completes it along pass: into Done, and its token leaves the line.
  const reviewer = await agentToken("reviewer");
  await v1("POST", `/v1/tasks/${filed.key}/claim`, {}, reviewer, "reviewer-live-1");
  await expect(tag(filed.key)).toContainText("reviewer picked up");
  await v1("POST", `/v1/tasks/${filed.key}/advance`, { outcome: "pass" }, reviewer, "reviewer-live-1");
  await expect(travelling).toContainText(filed.key);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${liveShots}5-into-done.png` });
  await expect(token(filed.key)).toHaveCount(0, { timeout: 4_000 });
  await expect(line.locator('[data-head="Done"]')).toContainText("1 today");
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: `${liveShots}6-done.png` });

  // Dark, the same moment: a pickup at Build.
  await page.emulateMedia({ colorScheme: "dark" });
  const again = ((await v1("POST", "/v1/tasks", { project: "MAIN", title: "Recount the ledger", step: "Build" })) as { task: { key: string } }).task;
  await v1("POST", `/v1/tasks/${again.key}/claim`, { heartbeat_timeout_seconds: 600 }, builder, "builder-live-2");
  await expect(tag(again.key)).toContainText("builder picked up");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${liveShots}7-picked-up-dark.png` });
  await v1("POST", `/v1/tasks/${again.key}/release`, undefined, builder, "builder-live-2");
  await expect(token(again.key)).toHaveAttribute("aria-label", `${again.key} Recount the ledger, waiting`);
  await v1("POST", `/v1/tasks/${again.key}/drop`, undefined);
  await expect(token(again.key)).toHaveCount(0);

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

  // QA's Skill exists now: nobody holds it, so its row warns. A new agent for it, from the row, at once:
  // its token shows once, and the warning goes.
  await page.goto(`${base}/settings/projects/MAIN/workflow`);
  const qaRow = page.getByRole("list", { name: "Steps" }).getByRole("listitem", { name: "4. QA" });
  await expect(qaRow.getByText("No Member has it")).toBeVisible();
  await page.screenshot({ path: `${shots}6-09-unstaffed.png`, animations: "disabled" });
  await qaRow.getByRole("button", { name: "Who takes QA's Tasks" }).click();
  await page.getByRole("menuitem", { name: "Create an agent…" }).click();
  const agentDialog = page.getByRole("dialog", { name: "Create an agent" });
  await agentDialog.getByRole("textbox", { name: "Name" }).fill("qa-bot");
  await page.screenshot({ path: `${shots}6-10-create-agent.png`, animations: "disabled" });
  await agentDialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("textbox", { name: "Secret of qa-bot's token" })).toHaveValue(/^dk_/);
  await expect(page.getByText(/The Runner starts its sessions on this Install/)).toBeVisible();
  await page.screenshot({ path: `${shots}6-11-agent-token-once.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(qaRow.getByRole("img", { name: "Members with qa: qa-bot" })).toBeVisible();
  await expect(qaRow.getByText("No Member has it")).toHaveCount(0);
  // ada takes Make's Tasks, added from its row.
  await page.getByRole("button", { name: "Who takes Make's Tasks" }).click();
  await page.getByRole("menuitem", { name: "Add Member…" }).click();
  await page.getByRole("option", { name: /^ada: / }).click();
  await expect(page.getByRole("listitem", { name: "3. Make" }).getByRole("img", { name: /^Members with engineer: .*ada/ })).toBeVisible();
  await page.screenshot({ path: `${shots}6-12-edited.png`, animations: "disabled" });
  // Neither touched the Workflow: nothing to save.
  await expect(page.getByRole("status", { name: "Editing" })).toHaveText("Editing");

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
  // ada took Make's Tasks in scenario 6.

  const { page, errors, ctx } = await open(browser, "/projects/MAIN/workflow");
  const line = page.getByRole("region", { name: "Workflow", exact: true });
  // The taker's mark under QA's name, ringed while it works there; the Task's token carries it too.
  const mark = line.locator('[data-head="QA"]').getByRole("img", { name: "qa-bot (agent), working" });
  await expect(mark).toHaveAttribute("data-working", "running");
  await expect(mark).toHaveAttribute("data-kind", "agent");
  await expect(line.locator(`button[data-task="${filed.key}"]`)).toHaveAttribute("aria-label", `${filed.key} Test the ledger, held by qa-bot (agent)`);
  const spin = () => mark.evaluate((el) => getComputedStyle(el).getPropertyValue("--spin"));
  const first = await spin();
  await page.waitForTimeout(300);
  expect(await spin()).not.toBe(first);

  // ada, a human not working there: a plain ring, still.
  const ada = line.locator('[data-head="Make"]').getByRole("img", { name: "ada" });
  await expect(ada).toHaveAttribute("data-kind", "human");
  await expect(ada).not.toHaveAttribute("data-working");
  await page.screenshot({ path: `${shots}9-01-marks.png`, animations: "disabled" });

  expect(errors).toEqual([]);
  await ctx.close();
});
