import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall } from "./server";

// Scenarios 6 and 9 of docs/build/model-v2-plan.md against the real binary, on an Install of
// their own (init's MAIN with the default Workflow and the roster's agents):
//   6. Workflow editing: rename a Step while the board is open (its columns follow); delete a Step
//      with Tasks (asked where they go); add a Step with a new Skill and a new agent; a Step nobody
//      holds shows the warning on the canvas and in the list.
//   9. Marks: an agent's gradient border, turning while its Claim is live; a human's plain border.
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/workflow/", import.meta.url));

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
  await page.screenshot({ path: `${shots}6-05-delete-asks-where.png`, animations: "disabled" });
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "Make" }).click();
  await dialog.getByRole("button", { name: "Delete Review" }).click();
  await expect(node(page, "Review")).toHaveCount(0);
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
  const mark = node(page, "QA").getByRole("img", { name: "qa-bot (agent), working" });
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
  await node(page, "QA").click();
  const peek = page.getByRole("dialog", { name: "Step QA" });
  await expect(peek.getByRole("list", { name: "Tasks at QA" })).toContainText("Test the ledger");
  await expect(peek.getByRole("list", { name: "Takers at QA" })).toContainText("Working here");
  await page.screenshot({ path: `${shots}9-02-step-peek.png`, animations: "disabled" });

  expect(errors).toEqual([]);
  await ctx.close();
});
