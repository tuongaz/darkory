import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall } from "./server";

// Scenarios 6 and 9 of docs/build/model-v2-plan.md against the real binary, on an Install of
// their own (init's MAIN with the default Workflow and the roster's agents):
//   6. Workflow editing: rename a Step while the board is open (its columns follow); delete a Step
//      with Tasks (asked where they go); add a Step with a new Skill and a new agent; a Step nobody
//      holds shows the warning on the canvas and in the list.
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

const node = (page: Page, name: string) => page.locator(".react-flow__node").filter({ has: page.getByText(name, { exact: true }) }).first();

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

test("scenario 6: rename a Step while the board is open, delete one with Tasks, add one with a new Skill and agent", async ({ browser }) => {
  // Two Tasks at Review, to be moved when it is deleted.
  for (const title of ["Check the ledger", "Check the totals"]) await v1("POST", "/v1/tasks", { project: "MAIN", title, step: "Review" });

  const board = await open(browser, "/projects/MAIN/tasks?view=board");
  await expect(board.page.getByText("Build", { exact: true }).first()).toBeVisible();
  await board.page.screenshot({ path: `${shots}6-01-board-before.png`, animations: "disabled" });

  const { page, errors, ctx } = await open(browser, "/settings/projects/MAIN/workflow");
  await expect(page.getByRole("region", { name: "Workflow, editing" }).locator(".react-flow__edge").first()).toBeVisible();
  await page.screenshot({ path: `${shots}6-02-editing.png`, animations: "disabled" });

  // Rename Build to Make: the board's column follows without a reload.
  await node(page, "Build").click();
  const name = page.getByRole("textbox", { name: "Name of Build" });
  await name.fill("Make");
  await name.press("Enter");
  await expect(page.getByRole("status", { name: /^(Saving…|Saved)$/ })).toHaveText(/Saved/);
  await expect(board.page.getByText("Make", { exact: true }).first()).toBeVisible();
  await expect(board.page.getByText("Build", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${shots}6-03-renamed.png`, animations: "disabled" });
  await board.page.screenshot({ path: `${shots}6-04-board-renamed-live.png`, animations: "disabled" });

  // Delete Review: its two Tasks must go somewhere.
  await node(page, "Review").click();
  await page.getByRole("button", { name: "Delete Review" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Review" });
  await expect(dialog).toContainText("2 Tasks are at Review");
  await expect(dialog.getByRole("button", { name: "Delete Review" })).toBeDisabled();
  // Make's only way out led into Review: the dialog says so, and does not refuse.
  await expect(dialog.getByRole("note")).toContainText("Make leads out only into Review");
  await page.screenshot({ path: `${shots}6-05-delete-asks-where.png`, animations: "disabled" });
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "Make" }).click();
  await dialog.getByRole("button", { name: "Delete Review" }).click();
  await expect(node(page, "Review")).toHaveCount(0);
  await expect(node(page, "Make")).toContainText("No way out");
  await page.screenshot({ path: `${shots}6-06-deleted.png`, animations: "disabled" });
  const moved = (await v1("GET", "/v1/tasks?project=MAIN&state=open")) as { items: { title: string; step_id?: string }[] };
  const wf = (await v1("GET", "/v1/projects/MAIN/workflow")) as { steps: { id: string; name: string }[] };
  const make = wf.steps.find((s) => s.name === "Make")!;
  expect(moved.items.filter((t) => t.title.startsWith("Check the")).every((t) => t.step_id === make.id)).toBe(true);

  // Add a Step after Make with a new Skill: nobody holds it, so the canvas and the list warn.
  await node(page, "Make").hover();
  await page.getByRole("button", { name: "Add a Step after Make" }).click();
  const added = page.getByRole("region", { name: "Step New Step" });
  await added.getByRole("textbox", { name: "Name of New Step" }).fill("QA");
  await added.getByRole("textbox", { name: "Name of New Step" }).press("Enter");
  const qa = page.getByRole("region", { name: "Step QA" });
  await qa.getByRole("combobox", { name: "Skill of QA" }).click();
  await page.getByRole("option", { name: "Create a Skill…" }).click();
  const skillDialog = page.getByRole("dialog", { name: "Create a Skill" });
  await skillDialog.getByRole("textbox", { name: "Name" }).fill("qa");
  await page.screenshot({ path: `${shots}6-07-create-skill.png`, animations: "disabled" });
  await skillDialog.getByRole("button", { name: "Create Skill" }).click();
  await expect(node(page, "QA")).toContainText("No Member has it");
  await page.screenshot({ path: `${shots}6-08-unstaffed-canvas.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Text" }).click();
  await expect(page.getByRole("list", { name: "Steps" })).toContainText("No Member has qa");
  await page.screenshot({ path: `${shots}6-09-unstaffed-text.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Canvas" }).click();

  // A new agent for it: its token shows once, and the warning goes.
  await node(page, "QA").click();
  await page.getByRole("region", { name: "Step QA" }).getByRole("button", { name: "Create an agent" }).click();
  const agentDialog = page.getByRole("dialog", { name: "Create an agent" });
  await agentDialog.getByRole("textbox", { name: "Name" }).fill("qa-bot");
  await page.screenshot({ path: `${shots}6-10-create-agent.png`, animations: "disabled" });
  await agentDialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("textbox", { name: "Secret of qa-bot's token" })).toHaveValue(/^dk_/);
  await page.screenshot({ path: `${shots}6-11-agent-token-once.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(node(page, "QA")).not.toContainText("No Member has it");
  await page.screenshot({ path: `${shots}6-12-edited.png`, animations: "disabled" });

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
