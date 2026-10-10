import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startInstall } from "./server";

// Scenarios 6 and 9 of docs/build/model-v2-plan.md against the real binary, on an Install of
// their own (init's MAIN with the default Workflows, Implementation and Bug triage, and the roster's
// agents; the scenarios edit Implementation):
//   6. Workflow editing on the line (vf-9): rename a Step, add one between two with a new Skill
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

/** The address of a Project's first Workflow's page (MAIN's Implementation): its Workflows open on a list. */
async function workflowPage(key: string): Promise<string> {
  const { workflows } = (await v1("GET", `/v1/projects/${key}/workflow`)) as { workflows: { id: string; position: number }[] };
  // The first by position, as `compare.mjs`'s firstWorkflow takes it.
  const first = [...workflows].sort((a, b) => a.position - b.position)[0];
  return `/projects/${key}/workflows/${first.id}`;
}

/** A fresh token for a roster agent, by name. */
async function agentToken(name: string): Promise<string> {
  const { items } = (await v1("GET", "/v1/members")) as { items: { id: string; name: string }[] };
  const m = items.find((x) => x.name === name)!;
  return ((await v1("POST", `/v1/members/${m.id}/tokens`, { name: `live-${name}` })) as { secret: string }).secret;
}

test("live: a Task filed shows at Build on the line, its pickup reads now, it travels to Review and into Done", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, await workflowPage("MAIN"));
  const line = page.getByRole("region", { name: "Workflow", exact: true });
  await expect(line.locator('[data-head="Build"]')).toBeVisible();
  await page.screenshot({ path: `${liveShots}0-open.png` });
  const token = (key: string) => line.locator(`button[data-task="${key}"]`);
  const tag = (key: string) => token(key).locator("xpath=..").locator("[data-tag]");
  /** Whether the Task's token stands in its Step's row on the line, and nowhere else. */
  const at = async (key: string, step: string) =>
    (await line.locator(`[data-station][data-head="${step}"] button[data-task="${key}"]`).count()) === 1 && (await token(key).count()) === 1;

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
  // The main line's Done, first; "When a Parent ends" under it has a Done of its own.
  await expect(line.locator('[data-head="Done"]').first()).toContainText("1 today");
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

test("scenario 6: rename a Step while the board is open, add one between two, delete one with Tasks, then who takes each Step, all on the line", async ({ browser }) => {
  // Two Tasks at Review, to be moved when it is deleted.
  for (const title of ["Check the ledger", "Check the totals"]) await v1("POST", "/v1/tasks", { project: "MAIN", title, step: "Review" });

  const board = await open(browser, "/projects/MAIN/tasks?view=board");
  await expect(board.page.getByText("Build", { exact: true }).first()).toBeVisible();
  await board.page.screenshot({ path: `${shots}6-01-board-before.png`, animations: "disabled" });

  // C1: the draft on the line, its fields in place (vf-9). MAIN's Workflows list Implementation and
  // Bug triage; Implementation's pencil opens its editor.
  const { page, errors, ctx } = await open(browser, "/projects/MAIN/workflows");
  await page.getByRole("list", { name: "Workflows" }).getByRole("link", { name: "Edit Implementation" }).click();
  const rail = page.getByRole("list", { name: "Steps on the line" });
  const onRail = () => rail.locator(":scope > li").evaluateAll((els) => els.map((el) => el.getAttribute("data-head")));
  await expect.poll(onRail).toEqual(["Build", "Review", "Done"]);
  await expect(page.getByRole("region", { name: "Also starts here" }).getByRole("textbox", { name: "Name of Backlog" })).toBeVisible();
  await page.screenshot({ path: `${shots}6-02-editing.png`, animations: "disabled" });

  // Rename Build to Make: nothing is sent yet, the board keeps Build.
  await page.getByRole("textbox", { name: "Name of Build" }).fill("Make");
  await expect(page.getByRole("button", { name: "1 change: list them" })).toBeVisible();
  await page.screenshot({ path: `${shots}6-03-renamed.png`, animations: "disabled" });

  // C2: Make's ⋯ adds a Step after it: a hold with no outcome, on the line, its name in focus.
  // Hovering a Step's controls moves nothing on the line.
  const more = page.getByRole("button", { name: "More for Make" });
  const below = page.getByRole("textbox", { name: "Name of Review" });
  const rest = [await below.boundingBox(), await rail.boundingBox()];
  await more.hover();
  expect([await below.boundingBox(), await rail.boundingBox()]).toEqual(rest);
  await more.click();
  await page.getByRole("menuitem", { name: "Add Step after Make" }).click();
  await expect(page.getByRole("textbox", { name: "Name of the new Step" })).toBeFocused();
  await expect.poll(onRail).toEqual(["Make", "New Step", "Review", "Done"]);
  await page.screenshot({ path: `${shots}6-04-added-step.png`, animations: "disabled" });
  await page.getByRole("textbox", { name: "Name of the new Step" }).fill("QA");
  // Its Skill, new, created on Save (usability: init seeds qa, which tester holds); then its way
  // on, and Make's main outcome into it.
  await page.getByRole("combobox", { name: "Skill of QA" }).click();
  await page.getByPlaceholder("Find or name a Skill").fill("usability");
  await page.getByRole("option", { name: /New Skill “usability”/ }).click();
  const skillDialog = page.getByRole("dialog", { name: "New Skill “usability”" });
  await skillDialog.getByRole("textbox", { name: "Text" }).fill("Try it as a user would.");
  await skillDialog.getByRole("button", { name: "Use this Skill" }).click();
  await expect(rail.locator("li", { has: page.getByRole("textbox", { name: "Name of QA" }) }).getByText("No way out", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add an outcome out of QA" }).click();
  await page.getByRole("textbox", { name: "Outcome out of QA" }).fill("pass");
  await page.getByRole("combobox", { name: "Where pass out of QA leads" }).click();
  await page.getByRole("option", { name: "Review", exact: true }).click();
  await page.getByRole("combobox", { name: "Where pass out of Make leads" }).click();
  await page.getByRole("option", { name: "QA", exact: true }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${shots}6-05-added.png`, animations: "disabled" });

  // C4: delete Review. Its two Tasks must go somewhere; QA's pass into it is removed unless led on: into Done.
  await page.getByRole("button", { name: "More for Review" }).click();
  await page.getByRole("menuitem", { name: "Delete Review" }).click();
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
  await expect.poll(onRail).toEqual(["Make", "QA", "Done"]);
  await expect(page.getByRole("textbox", { name: "Name of QA" })).toHaveValue("QA");
  // The changes, listed from the bar.
  const chip = page.getByRole("button", { name: /^\d+ changes: list them$/ });
  await chip.click();
  const changes = page.getByRole("list", { name: "Changes" });
  await expect(changes).toContainText("Build → Make");
  await expect(changes).toContainText("Review · its 2 Tasks move to Make");
  await expect(changes).toContainText("AddedQA · pass → Done");
  await page.screenshot({ path: `${shots}6-07-changes.png`, animations: "disabled" });
  await page.keyboard.press("Escape");

  // Save: the Skill, then the Workflow; the live Workflow, and the board's columns follow without a reload.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`^${base}/projects/MAIN/workflows/[^/?]+$`));
  await expect(board.page.getByText("Make", { exact: true }).first()).toBeVisible();
  await expect(board.page.getByText("Build", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${shots}6-08-saved.png`, animations: "disabled" });
  const moved = (await v1("GET", "/v1/tasks?project=MAIN&state=open")) as { items: { title: string; step_id?: string }[] };
  const wf = (await v1("GET", "/v1/projects/MAIN/workflow")) as { workflows: { id: string; name: string }[]; steps: { id: string; name: string; workflow_id: string; position: number; skill_id?: string }[]; connectors: { from_step_id: string; to_step_id?: string; name: string }[] };
  const madeStep = wf.steps.find((s) => s.name === "Make")!;
  const qaStep = wf.steps.find((s) => s.name === "QA")!;
  expect(moved.items.filter((t) => t.title.startsWith("Check the")).every((t) => t.step_id === madeStep.id)).toBe(true);
  expect(wf.connectors.find((c) => c.from_step_id === qaStep.id && c.name === "pass")!.to_step_id).toBeUndefined();
  const { items: skillList } = (await v1("GET", "/v1/skills")) as { items: { id: string; name: string }[] };
  expect(qaStep.skill_id).toBe(skillList.find((s) => s.name === "usability")!.id);
  // Implementation's Save sent MAIN's whole graph: Bug triage comes back whole, its feature into Make.
  const bugTriage = wf.workflows.find((w) => w.name === "Bug triage")!;
  const bugSteps = wf.steps.filter((s) => s.workflow_id === bugTriage.id).sort((a, b) => a.position - b.position);
  expect(bugSteps.map((s) => s.name)).toEqual(["Triage", "Fix", "Code review", "Verify"]);
  expect(wf.connectors.filter((c) => bugSteps.some((s) => s.id === c.from_step_id))).toHaveLength(8);
  const triage = bugSteps.find((s) => s.name === "Triage")!;
  expect(wf.connectors.find((c) => c.from_step_id === triage.id && c.name === "feature")!.to_step_id).toBe(madeStep.id);

  // C3: QA's Skill exists now and nobody has it: its Owner takes it. A new agent for it, at once: its token shows once.
  const work = wf.workflows.find((w) => w.name === "Implementation")!.id;
  await page.goto(`${base}/projects/MAIN/workflows/${work}/edit?step=${qaStep.id}`);
  await expect(page.getByRole("textbox", { name: "Name of QA" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Who takes QA" })).toHaveText("Nobody");
  await page.screenshot({ path: `${shots}6-09-unstaffed.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Who takes QA" }).click();
  const takenBy = page.getByRole("region", { name: "Taken by" });
  await takenBy.getByRole("button", { name: "New agent" }).click();
  const agentDialog = page.getByRole("dialog", { name: "New agent" });
  await agentDialog.getByRole("textbox", { name: "Name" }).fill("qa-bot");
  await agentDialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page.getByRole("textbox", { name: "Secret of qa-bot's token" })).toHaveValue(/^dk_/);
  await page.screenshot({ path: `${shots}6-10-agent-token-once.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(takenBy.getByRole("list", { name: "Members with usability" })).toContainText("qa-bot");
  await page.keyboard.press("Escape");
  await expect(takenBy).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Who takes QA" })).toContainText("qa-bot");

  // ada takes Make's Tasks, added from its avatars; builder no longer does, removed by its ×. Both
  // are the draft's: listed, sent on Save with the Workflow.
  await page.getByRole("button", { name: "Who takes Make" }).click();
  const engineers = takenBy.getByRole("list", { name: "Members with engineer" });
  await takenBy.getByRole("button", { name: "Add a Member" }).click();
  await page.getByRole("option", { name: /^ada/ }).click();
  await expect(engineers).toContainText("ada");
  await takenBy.getByRole("button", { name: "Remove builder" }).hover();
  await page.screenshot({ path: `${shots}6-11-remove-hover.png`, animations: "disabled" });
  await takenBy.getByRole("button", { name: "Remove builder" }).click();
  // builder takes engineer at Bug triage's Fix too: removing it asks first, naming that Step.
  const removeBuilder = page.getByRole("dialog", { name: "Remove builder from engineer?" });
  await expect(removeBuilder).toContainText("builder also takes engineer at Fix.");
  await removeBuilder.getByRole("button", { name: "Remove" }).click();
  await expect(engineers).not.toContainText("builder");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "2 changes: list them" }).click();
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
  await expect(page).toHaveURL(`${base}/projects/MAIN/workflows/${work}`);
  expect([await has("ada"), await has("builder")]).toEqual([true, false]);

  // A removal cancelled is discarded: ada keeps engineer.
  await page.goto(`${base}/projects/MAIN/workflows/${work}/edit?step=${madeStep.id}`);
  await page.getByRole("button", { name: "Who takes Make" }).click();
  await takenBy.getByRole("button", { name: "Remove ada" }).click();
  const removeAda = page.getByRole("dialog", { name: "Remove ada from engineer?" });
  await expect(removeAda).toContainText("ada also takes engineer at Fix.");
  await removeAda.getByRole("button", { name: "Remove" }).click();
  await expect(takenBy).toContainText("Nobody");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog", { name: "Discard 1 change?" }).getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(`${base}/projects/MAIN/workflows/${work}`);
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

  const { page, errors, ctx } = await open(browser, await workflowPage("MAIN"));
  const line = page.getByRole("region", { name: "Workflow", exact: true });
  // The taker's mark under QA's name, ringed while it works there; the Task's token carries it too.
  const mark = line.locator('[data-head="QA"] [data-takers]').getByRole("img", { name: "qa-bot (agent), working" });
  await expect(mark).toHaveAttribute("data-working", "running");
  await expect(mark).toHaveAttribute("data-kind", "agent");
  await expect(line.locator(`button[data-task="${filed.key}"]`)).toHaveAttribute("aria-label", `${filed.key} Test the ledger, held by qa-bot (agent)`);
  const spin = () => mark.evaluate((el) => getComputedStyle(el).getPropertyValue("--spin"));
  const first = await spin();
  await page.waitForTimeout(300);
  expect(await spin()).not.toBe(first);

  // ada, a human not working there: a plain ring, still.
  const ada = line.locator('[data-head="Make"] [data-takers]').getByRole("img", { name: "ada" });
  await expect(ada).toHaveAttribute("data-kind", "human");
  await expect(ada).not.toHaveAttribute("data-working");
  await page.screenshot({ path: `${shots}9-01-marks.png`, animations: "disabled" });

  // Hovering the step-head mark opens qa-bot's card: an agent with the usability Skill, holding the Task.
  await mark.hover();
  const card = page.locator('[data-slot="hover-card-content"]');
  await expect(card.locator("[data-member-card]")).toHaveAttribute("data-member-card", "qa-bot");
  await expect(card.getByText("Agent", { exact: true })).toBeVisible();
  await expect(card.locator("dd").getByText("usability", { exact: true })).toBeVisible();
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

test("the software Workflow at 1440×900: its seven returns are drawn, each labelled at its Step on a track, none cut by the panels", async ({ browser }) => {
  // The preset's 14 Steps and 7 loops back (examples/workflows/software), its Skills made first.
  const workflow = JSON.parse(readFileSync(fileURLToPath(new URL("../../examples/workflows/software/workflow.json", import.meta.url)), "utf8")) as { steps: { skill?: string }[] };
  const have = new Set(((await v1("GET", "/v1/skills")) as { items: { name: string }[] }).items.map((x) => x.name));
  for (const name of new Set(workflow.steps.flatMap((x) => (x.skill ? [x.skill] : [])))) {
    if (!have.has(name)) await v1("POST", "/v1/skills", { name, kind: "generic", body: `${name}.` });
  }
  await v1("POST", "/v1/projects", { key: "SWL", name: "Software line", workflow: "empty", members: ["ada"] });
  await v1("PUT", "/v1/projects/SWL/workflow", workflow);

  const { page, errors, ctx } = await open(browser, await workflowPage("SWL"));
  const line = page.getByRole("region", { name: "Workflow", exact: true });
  // A return is labelled "↩ outcome → Step" at the Step it leaves, and drawn as a track into the Step it reaches.
  const labels = line.locator("[data-return]").filter({ hasText: "↩" });
  await expect(labels).toHaveCount(7);
  for (const label of await labels.all()) {
    const id = (await label.getAttribute("data-return"))!;
    await expect(line.locator(`g[data-track] [data-connectors*="${id}"]`).first(), id).toBeAttached();
  }
  // Every label is on top where it is drawn once scrolled to: no pane over the line cuts it off.
  for (const label of await labels.all()) {
    await label.scrollIntoViewIfNeeded();
    const seen = await label.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(seen, await label.innerText()).toBe(true);
  }
  await page.screenshot({ path: `${liveShots}software-returns-1440.png`, animations: "disabled" });
  expect(errors).toEqual([]);
  await ctx.close();
});

test("the software Workflow down a phone and a 1024 window: every return's track keeps the gutter at the line's left edge", async ({ browser }) => {
  for (const size of [{ width: 390, height: 844 }, { width: 1024, height: 900 }]) {
    const { page, errors, ctx } = await open(browser, await workflowPage("SWL"), size);
    const line = page.getByRole("region", { name: "Workflow" });
    await expect(line).toHaveAttribute("data-orientation", "vertical");
    const tracks = line.locator("g[data-track] path");
    await expect(tracks.first()).toBeAttached();
    // Each track's left edge, from the line's own left edge, in the page as drawn.
    const gaps = await line.evaluate((el) => {
      const left = el.getBoundingClientRect().left;
      return [...el.querySelectorAll("g[data-track]")].filter((g) => g.childElementCount > 0).map((g) => Math.round(g.getBoundingClientRect().left - left));
    });
    expect(Math.min(...gaps), `${size.width}: ${gaps}`).toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: `${liveShots}software-tracks-${size.width}.png`, animations: "disabled" });
    expect(errors).toEqual([]);
    await ctx.close();
  }
});
