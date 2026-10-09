import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startInstall } from "./server";

// Scenarios 6 and 9 of docs/build/model-v2-plan.md against the real binary, on an Install of
// their own (init's MAIN with the default Workflow and the roster's agents):
//   6. Workflow editing in the list and panel: rename a Step, add one between two with a new Skill
//      and wire it, delete one with Tasks (asked where they go and where the outcome into it
//      leads), the changes listed, all saved in one go; the open board's columns follow; then who
//      takes a Step: a new agent, at once; a Member added and one removed, saved with the Workflow;
//      a removal cancelled, discarded.
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
  const { page, errors, ctx } = await open(browser, "/projects/MAIN/workflows");
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

test("scenario 6: rename a Step while the board is open, add one between two, delete one with Tasks, then who takes each Step, all from the panel", async ({ browser }) => {
  // Two Tasks at Review, to be moved when it is deleted.
  for (const title of ["Check the ledger", "Check the totals"]) await v1("POST", "/v1/tasks", { project: "MAIN", title, step: "Review" });

  const board = await open(browser, "/projects/MAIN/tasks?view=board");
  await expect(board.page.getByText("Build", { exact: true }).first()).toBeVisible();
  await board.page.screenshot({ path: `${shots}6-01-board-before.png`, animations: "disabled" });

  // C1: the Steps as text, none open until one is picked; then Build, where New Tasks start.
  // Settings › Workflows lists MAIN's one, Work; its row opens its editor.
  const { page, errors, ctx } = await open(browser, "/settings/projects/MAIN/workflows");
  await page.getByRole("table", { name: "Workflows" }).getByRole("link", { name: "Work" }).click();
  const list = page.getByRole("list", { name: "Steps" });
  await expect(page.getByRole("note", { name: "No Step picked" })).toBeVisible();
  await expect(list.getByRole("listitem", { name: "3. Build" })).toContainText("New Tasks start here");
  await list.getByRole("button", { name: "3. Build" }).click();
  await expect(list.getByRole("button", { name: "3. Build" })).toHaveAttribute("aria-current", "true");
  await page.screenshot({ path: `${shots}6-02-editing.png`, animations: "disabled" });

  // Rename Build to Make: nothing is sent yet, the board keeps Build.
  await page.getByRole("textbox", { name: "Name of Step 3" }).fill("Make");
  await expect(page.getByRole("button", { name: "Editing · 1 change: list them" })).toBeVisible();
  await page.screenshot({ path: `${shots}6-03-renamed.png`, animations: "disabled" });

  // C2: the band between Make and Review adds a Step there: a hold with no outcome, its name in focus.
  // Hovering it changes only its colour: it and every row under it stay where they were.
  const make = list.getByRole("listitem", { name: "3. Make" });
  const band = page.getByRole("button", { name: "Add a Step after Make" });
  const below = list.getByRole("listitem", { name: "4. Review" });
  const last = list.getByRole("listitem", { name: "6. Skill review" });
  const rest = [await band.boundingBox(), await below.boundingBox(), await last.boundingBox()];
  await expect(band).toHaveCSS("opacity", "0");
  const box = (await make.boundingBox())!;
  await page.mouse.move(box.x + 120, box.y + box.height + 2);
  await band.hover();
  await expect(band).toHaveCSS("opacity", "1");
  await expect(band).toHaveText("Add Step");
  expect([await band.boundingBox(), await below.boundingBox(), await last.boundingBox()]).toEqual(rest);
  await page.screenshot({ path: `${shots}6-04-add-band.png`, animations: "disabled" });
  await band.click();
  await expect(page.getByRole("textbox", { name: "Name of Step 4" })).toBeFocused();
  await expect(page.getByRole("region", { name: "Step 4: New Step" })).toContainText("By hand");
  await page.getByRole("textbox", { name: "Name of Step 4" }).fill("QA");
  // Its Skill, new, created on Save; then its way on, and Make's main outcome into it.
  await page.getByRole("combobox", { name: "Skill of QA" }).click();
  await page.getByPlaceholder("Find or name a Skill").fill("qa");
  await page.getByRole("option", { name: /New Skill “qa”/ }).click();
  const skillDialog = page.getByRole("dialog", { name: "New Skill “qa”" });
  await skillDialog.getByRole("textbox", { name: "Text" }).fill("Try it as a user would.");
  await skillDialog.getByRole("button", { name: "Use this Skill" }).click();
  await expect(page.getByRole("region", { name: "Outcomes" }).getByText("No way out", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add an outcome out of QA" }).click();
  await page.getByRole("textbox", { name: "Outcome out of QA" }).fill("pass");
  await page.getByRole("combobox", { name: "Where pass out of QA leads" }).click();
  await page.getByRole("option", { name: "Review", exact: true }).click();
  await list.getByRole("button", { name: "3. Make" }).click();
  await page.getByRole("combobox", { name: "Where pass out of Make leads" }).click();
  await page.getByRole("option", { name: "QA", exact: true }).click();
  await page.screenshot({ path: `${shots}6-05-added.png`, animations: "disabled" });

  // C4: delete Review. Its two Tasks must go somewhere; QA's pass into it is removed unless led on: into Done.
  await list.getByRole("button", { name: "5. Review" }).click();
  await page.getByRole("button", { name: "Delete Review" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Review" });
  await expect(dialog.getByRole("heading", { name: "2 Tasks at Review" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Where pass out of QA leads instead" })).toHaveText("Remove this outcome");
  await expect(dialog.getByRole("button", { name: "Delete Review" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Step that receives the Tasks at Review" }).click();
  await page.getByRole("option", { name: "Make", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Where pass out of QA leads instead" }).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await page.screenshot({ path: `${shots}6-06-delete-asks.png`, animations: "disabled" });
  await dialog.getByRole("button", { name: "Delete Review" }).click();
  await expect(list.getByRole("listitem", { name: /Review$/ })).toHaveCount(0);
  // Review was the last Step on the line: the panel moves to QA above it, not to Retro after a Parent.
  await expect(page.getByRole("textbox", { name: "Name of Step 4" })).toHaveValue("QA");
  // The changes, listed from the header.
  const chip = page.getByRole("button", { name: /^Editing · \d+ changes: list them$/ });
  await chip.click();
  const changes = page.getByRole("list", { name: "Changes" });
  await expect(changes).toContainText("Build → Make");
  await expect(changes).toContainText("Review · its 2 Tasks move to Make");
  await expect(changes).toContainText("AddedQA · pass → Done");
  await page.screenshot({ path: `${shots}6-07-changes.png`, animations: "disabled" });
  await page.keyboard.press("Escape");

  // Save: the Skill, then the Workflow; the live Workflow, and the board's columns follow without a reload.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(`${base}/projects/MAIN/workflows`);
  await expect(board.page.getByText("Make", { exact: true }).first()).toBeVisible();
  await expect(board.page.getByText("Build", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${shots}6-08-saved.png`, animations: "disabled" });
  const moved = (await v1("GET", "/v1/tasks?project=MAIN&state=open")) as { items: { title: string; step_id?: string }[] };
  const wf = (await v1("GET", "/v1/projects/MAIN/workflow")) as { workflows: { id: string }[]; steps: { id: string; name: string; skill_id?: string }[]; connectors: { from_step_id: string; to_step_id?: string; name: string }[] };
  const madeStep = wf.steps.find((s) => s.name === "Make")!;
  const qaStep = wf.steps.find((s) => s.name === "QA")!;
  expect(moved.items.filter((t) => t.title.startsWith("Check the")).every((t) => t.step_id === madeStep.id)).toBe(true);
  expect(wf.connectors.find((c) => c.from_step_id === qaStep.id && c.name === "pass")!.to_step_id).toBeUndefined();
  const { items: skillList } = (await v1("GET", "/v1/skills")) as { items: { id: string; name: string }[] };
  expect(qaStep.skill_id).toBe(skillList.find((s) => s.name === "qa")!.id);

  // C3: QA's Skill exists now and nobody has it: its Owner takes it. A new agent for it, at once: its token shows once.
  const work = wf.workflows[0].id;
  await page.goto(`${base}/settings/projects/MAIN/workflows/${work}?step=${qaStep.id}`);
  const takenBy = page.getByRole("region", { name: "Step 4: QA" }).getByRole("region", { name: "Taken by" });
  await expect(takenBy).toContainText("Nobody");
  await expect(list.getByRole("listitem", { name: "4. QA" })).toContainText("Owner takes it");
  await page.screenshot({ path: `${shots}6-09-unstaffed.png`, animations: "disabled" });
  await takenBy.getByRole("button", { name: "New agent" }).click();
  const agentDialog = page.getByRole("dialog", { name: "New agent" });
  await agentDialog.getByRole("textbox", { name: "Name" }).fill("qa-bot");
  await agentDialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("textbox", { name: "Secret of qa-bot's token" })).toHaveValue(/^dk_/);
  await page.screenshot({ path: `${shots}6-10-agent-token-once.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(takenBy.getByRole("list", { name: "Members with qa" })).toContainText("qa-bot");

  // ada takes Make's Tasks, added from its panel; builder no longer does, removed by its ×. Both
  // are the draft's: listed, sent on Save with the Workflow.
  await list.getByRole("button", { name: "3. Make" }).click();
  const makeTakers = page.getByRole("region", { name: "Step 3: Make" }).getByRole("region", { name: "Taken by" });
  const engineers = makeTakers.getByRole("list", { name: "Members with engineer" });
  await makeTakers.getByRole("button", { name: "Add a Member" }).click();
  await page.getByRole("option", { name: /^ada/ }).click();
  await expect(engineers).toContainText("ada");
  await makeTakers.getByRole("button", { name: "Remove builder" }).hover();
  await page.screenshot({ path: `${shots}6-11-remove-hover.png`, animations: "disabled" });
  await makeTakers.getByRole("button", { name: "Remove builder" }).click();
  await expect(engineers).not.toContainText("builder");
  await page.getByRole("button", { name: "Editing · 2 changes: list them" }).click();
  await expect(page.getByRole("list", { name: "Changes" })).toContainText("Addedada to engineer");
  await expect(page.getByRole("list", { name: "Changes" })).toContainText("Removedbuilder from engineer");
  await page.screenshot({ path: `${shots}6-12-edited.png`, animations: "disabled" });
  await page.keyboard.press("Escape");
  const has = async (name: string) => {
    const { items } = (await v1("GET", "/v1/members")) as { items: { id: string; name: string }[] };
    const d = (await v1("GET", `/v1/members/${items.find((m) => m.name === name)!.id}`)) as { skills: { name: string }[] };
    return d.skills.some((k) => k.name === "engineer");
  };
  expect([await has("ada"), await has("builder")]).toEqual([false, true]);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(`${base}/projects/MAIN/workflows`);
  expect([await has("ada"), await has("builder")]).toEqual([true, false]);

  // A removal cancelled is discarded: ada keeps engineer.
  await page.goto(`${base}/settings/projects/MAIN/workflows/${work}?step=${madeStep.id}`);
  await makeTakers.getByRole("button", { name: "Remove ada" }).click();
  await expect(makeTakers).toContainText("Nobody");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog", { name: "Discard 1 change?" }).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(`${base}/settings/projects/MAIN/workflows`);
  expect(await has("ada")).toBe(true);

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

  const { page, errors, ctx } = await open(browser, "/projects/MAIN/workflows");
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

  // Hovering the step-head mark opens qa-bot's card: an agent with the qa Skill, holding the Task.
  await mark.hover();
  const card = page.locator('[data-slot="hover-card-content"]');
  await expect(card.locator("[data-member-card]")).toHaveAttribute("data-member-card", "qa-bot");
  await expect(card.getByText("Agent", { exact: true })).toBeVisible();
  await expect(card.locator("dd").getByText("qa", { exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: new RegExp(`${filed.key}\\s*Test the ledger`) })).toBeVisible();
  await expect(card.getByText(/^Working for /)).toBeVisible();
  await expect(card.getByRole("link", { name: "Open profile" })).toHaveAttribute("href", "/settings/organisation/agents/qa-bot");
  await page.screenshot({ path: `${shots}9-02-card.png`, animations: "disabled" });
  // Moving away closes it; focusing ada's mark opens hers.
  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);
  await ada.focus();
  await expect(card.locator("[data-member-card]")).toHaveAttribute("data-member-card", "ada");
  await expect(card.getByText("Human", { exact: true })).toBeVisible();

  expect(errors).toEqual([]);
  await ctx.close();
});

test("the software Workflow at 1440×900: its line and the whole Loops list show as the page opens, nothing cut by the panels", async ({ browser }) => {
  // The preset's 14 Steps and 7 loops back (examples/workflows/software), its Skills made first.
  const workflow = JSON.parse(readFileSync(fileURLToPath(new URL("../../examples/workflows/software/workflow.json", import.meta.url)), "utf8")) as { steps: { skill?: string }[] };
  const have = new Set(((await v1("GET", "/v1/skills")) as { items: { name: string }[] }).items.map((x) => x.name));
  for (const name of new Set(workflow.steps.flatMap((x) => (x.skill ? [x.skill] : [])))) {
    if (!have.has(name)) await v1("POST", "/v1/skills", { name, kind: "generic", body: `${name}.` });
  }
  await v1("POST", "/v1/projects", { key: "SWL", name: "Software line", workflow: "empty", members: ["ada"] });
  await v1("PUT", "/v1/projects/SWL/workflow", workflow);

  const { page, errors, ctx } = await open(browser, "/projects/SWL/workflows");
  const loops = page.getByRole("region", { name: "Loops" });
  await expect(loops).toContainText("Loops 7");
  const rows = loops.getByRole("listitem");
  await expect(rows).toHaveCount(7);
  // Every row is on screen and on top where it is drawn: no pane above it cuts it off.
  for (const row of await rows.all()) {
    const seen = await row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.left + 12, r.top + r.height / 2));
    });
    expect(seen, await row.innerText()).toBe(true);
  }
  await page.screenshot({ path: `${liveShots}software-loops-1440.png`, animations: "disabled" });
  expect(errors).toEqual([]);
  await ctx.close();
});

test("the software Workflow down a phone and a 1024 window: every loop back's track keeps the gutter at the line's left edge", async ({ browser }) => {
  for (const size of [{ width: 390, height: 844 }, { width: 1024, height: 900 }]) {
    const { page, errors, ctx } = await open(browser, "/projects/SWL/workflows", size);
    const line = page.getByRole("region", { name: "Workflow" });
    await expect(line).toHaveAttribute("data-orientation", "vertical");
    const tracks = line.locator("path[data-track]");
    await expect(tracks.first()).toBeAttached();
    // Each track's left edge, from the line's own left edge, in the page as drawn.
    const gaps = await line.evaluate((el) => {
      const left = el.getBoundingClientRect().left;
      return [...el.querySelectorAll("path[data-track]")].map((p) => Math.round(p.getBoundingClientRect().left - left));
    });
    expect(Math.min(...gaps), `${size.width}: ${gaps}`).toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: `${liveShots}software-tracks-${size.width}.png`, animations: "disabled" });
    expect(errors).toEqual([]);
    await ctx.close();
  }
});
