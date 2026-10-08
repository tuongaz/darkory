import { expect, test, type Page } from "@playwright/test";
import { emit, mockV1 } from "./workflowMock";

// The Workflow screens under `vite dev` with a mocked /v1 (`npm run lab`): the live canvas and a
// Step's peek, the text view, and the list editor (F5a–c of frag-d), at desktop and phone sizes in
// light and dark, shot into e2e/screenshots/ for a person to look at. No console error, no
// sideways scroll.

const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function noSidewaysScroll(page: Page) {
  const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(w.scroll).toBe(w.client);
}

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/workflow-${name}.png` });

for (const scheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    test(`workflow screens, ${size.name}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await mockV1(page);
      const tag = `${size.name}-${scheme}`;

      // Live.
      await page.goto("/projects/WEB/workflow");
      const live = page.getByRole("region", { name: "Workflow", exact: true });
      await expect(live.locator(".react-flow__edge").first()).toBeVisible();
      await expect(live.getByRole("img", { name: "builder-1 (agent), working" }).first()).toBeVisible();
      await page.waitForTimeout(400);
      await noSidewaysScroll(page);
      await shot(page, `live-${tag}`);

      // A Step's peek.
      await live.locator(".react-flow__node").filter({ hasText: "Build" }).first().getByText("Build", { exact: true }).click();
      const peek = page.getByRole("dialog", { name: "Step Build" });
      await expect(peek.getByRole("list", { name: "Tasks at Build" })).toBeVisible();
      await page.waitForTimeout(800);
      await shot(page, `peek-${tag}`);
      await peek.getByRole("button", { name: "Close" }).click();

      // Text view.
      await page.getByRole("button", { name: "Text" }).click();
      await expect(page.getByRole("list", { name: "Steps" })).toBeVisible();
      await noSidewaysScroll(page);
      await shot(page, `live-text-${tag}`);

      // Editing: the list with the line above (on a phone, the line behind its toggle).
      await page.goto("/settings/projects/WEB/workflow");
      await expect(page.getByRole("list", { name: "Steps" })).toBeVisible();
      await page.waitForTimeout(300);
      await noSidewaysScroll(page);
      await shot(page, `edit-${tag}`);
      if (size.name === "phone") {
        await page.getByRole("button", { name: "Show the line" }).click();
        await shot(page, `edit-line-${tag}`);
      }

      // F5a: a Step inserted after Review, named, its Skill picker open on a Skill that does not exist.
      await page.getByRole("button", { name: "Add a Step after Review" }).click();
      await page.getByRole("textbox", { name: "Name of Step 6" }).fill("Security review");
      await page.getByRole("combobox", { name: "Skill of Security review" }).click();
      await page.getByPlaceholder("Find or name a Skill").fill("security");
      await page.waitForTimeout(200);
      await noSidewaysScroll(page);
      await shot(page, `edit-insert-${tag}`);
      await page.getByRole("option", { name: /New Skill “security”/ }).click();
      const sheet = page.getByRole("dialog", { name: "New Skill “security”" });
      await sheet.getByRole("textbox", { name: "Text" }).fill("Look for the holes an attacker would use.");
      await shot(page, `edit-new-skill-${tag}`);
      await sheet.getByRole("button", { name: "Use this Skill" }).click();

      // F5b: an outcome added out of it, back to Build.
      await page.getByRole("button", { name: "Add an outcome out of Security review" }).click();
      await page.getByRole("textbox", { name: "Outcome out of Security review" }).last().fill("fail");
      await page.getByRole("combobox", { name: "Where fail out of Security review leads" }).click();
      await page.getByRole("option", { name: "Build" }).click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      await noSidewaysScroll(page);
      await shot(page, `edit-outcome-${tag}`);

      // A refusal in words: a Step with no name.
      await page.getByRole("button", { name: "Add a Step after Build" }).click();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("alert")).toContainText("A Step needs a name.");
      await shot(page, `edit-refused-${tag}`);
      await page.keyboard.press("Escape");
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");

      // F5c: saved, the live Workflow.
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
      await page.waitForTimeout(500);
      await shot(page, `edit-saved-${tag}`);

      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

test("editing: nothing is sent until Save; then the new Skill, then one PUT", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockV1(page);
  const writes: string[] = [];
  page.on("request", (r) => r.method() !== "GET" && r.url().includes("/v1/") && writes.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.goto("/settings/projects/WEB/workflow?step=st-qa");
  const name = page.getByRole("textbox", { name: "Name of Step 4" });
  await expect(name).toBeFocused();
  await name.fill("Test");
  await expect(page.getByText("Editing · 1 change")).toBeVisible();
  // Alt+↓ moves it after Review, and keeps the focus.
  await name.press("Alt+ArrowDown");
  await expect(page.getByRole("listitem", { name: "5. Test" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name of Step 5" })).toBeFocused();
  await page.getByRole("combobox", { name: "Skill of Test" }).click();
  await page.getByPlaceholder("Find or name a Skill").fill("testing");
  await page.getByRole("option", { name: /New Skill “testing”/ }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Text" }).fill("Test it.");
  await page.getByRole("dialog").getByRole("button", { name: "Use this Skill" }).click();
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => writes).toEqual(["POST /v1/skills", "PUT /v1/projects/WEB/workflow"]);
  expect(errors).toEqual([]);
});

const entryAt = (seq: number, kind: string, subject: string, actor: string | undefined, payload: Record<string, unknown>) => ({
  seq,
  at: new Date().toISOString(),
  kind,
  subject_type: "task",
  subject_id: subject,
  ...(actor ? { actor_id: actor } : {}),
  payload,
});
const claimOf = (n: number, holder: string) => ({
  id: `cl-live-${n}`,
  task_id: `k-${n}`,
  holder_id: holder,
  session_id: `sess-live-${n}`,
  started_at: new Date().toISOString(),
});

// The live canvas as things happen: a pickup called out above its Step, a Task travelling its
// Connector (shot mid-way), a lapse, a completion into Done; the trail beside it; each in light
// and dark, and at a phone's size with the trail as a sheet; and with reduced motion, no token.
for (const scheme of ["light", "dark"] as const) {
  test(`live moments, desktop, ${scheme}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = watchErrors(page);
    const { tasks } = await mockV1(page);
    const task = (n: number) => tasks.find((t) => t.id === `k-${n}`)!;
    await page.goto("/projects/WEB/workflow");
    const live = page.getByRole("region", { name: "Workflow", exact: true });
    const trail = page.getByRole("complementary", { name: "Live trail" });
    await expect(live.getByRole("button", { name: /^WEB-5 Normalise names on input, held by builder-1/ })).toBeVisible();
    await expect(trail.getByRole("listitem").first()).toContainText("planner picked up WEB-4 at Plan");
    await expect(trail).toContainText("4 working now");
    await page.waitForTimeout(400);
    await noSidewaysScroll(page);
    await shot(page, `live-moments-0-open-${scheme}`);

    // builder-1 picks up WEB-7 at Build.
    task(7).claim = claimOf(7, "m-builder-1");
    await emit(page, entryAt(60, "task.claimed", "k-7", "m-builder-1", { step_id: "st-build", skill_id: "s-engineer" }));
    await expect(page.locator(".flow-callout", { hasText: "builder-1 picked up WEB-7" })).toBeVisible();
    await expect(live.getByRole("button", { name: /^WEB-7 Store names as NFC, held by builder-1/ })).toHaveAttribute("data-live", "agent");
    await expect(trail.getByRole("listitem").first()).toContainText("builder-1 picked up WEB-7 at Build");
    await page.waitForTimeout(500);
    await shot(page, `live-moments-1-pickup-${scheme}`);

    // qa-bot passes WEB-9 on to Review: a token travels the pass Connector.
    Object.assign(task(9), { step_id: "st-review", claim: undefined });
    await emit(page, entryAt(61, "task.advanced", "k-9", "m-qa", { from: "st-qa", to: "st-review", outcome: "pass" }));
    await expect(page.locator(".flow-token")).toHaveText("WEB-9");
    await page.waitForTimeout(550);
    await shot(page, `live-moments-2-travelling-${scheme}`);
    await expect(page.locator(".flow-token")).toHaveCount(0, { timeout: 3_000 });
    await expect(live.getByRole("button", { name: /^WEB-9 / })).toHaveAttribute("data-arrived", "true");
    await expect(trail.getByRole("listitem").first()).toContainText("qa-bot advanced WEB-9 along pass to Review");
    await shot(page, `live-moments-3-landed-${scheme}`);

    // builder-2's Claim on WEB-6 lapses; reviewer sends WEB-10 back to Build.
    Object.assign(task(6), { claim: undefined });
    await emit(page, entryAt(62, "task.lapsed", "k-6", undefined, { holder_id: "m-builder-2", claim_id: "cl-6" }));
    Object.assign(task(10), { step_id: "st-build" });
    await emit(page, entryAt(63, "task.advanced", "k-10", "m-reviewer", { from: "st-review", to: "st-build", outcome: "needs changes" }));
    await expect(page.locator(".flow-callout", { hasText: "WEB-6's Claim lapsed" })).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, `live-moments-4-lapse-and-back-${scheme}`);
    await expect(trail.getByRole("listitem").first()).toContainText("reviewer sent WEB-10 back along needs changes to Build");

    // Hovering a row lights its Steps.
    await trail.getByRole("listitem").first().hover();
    await page.waitForTimeout(300);
    await shot(page, `live-moments-5-row-hovered-${scheme}`);

    // The trail hides to a button, and comes back.
    await trail.getByRole("button", { name: "Hide the trail" }).click();
    await expect(page.getByRole("button", { name: "Show the trail" })).toBeVisible();
    await shot(page, `live-moments-6-trail-hidden-${scheme}`);
    await page.getByRole("button", { name: "Show the trail" }).click();
    await expect(trail).toBeVisible();

    // The text view lists each Step's Tasks.
    await page.getByRole("button", { name: "Text" }).click();
    const steps = page.getByRole("list", { name: "Steps" });
    await expect(steps.getByRole("list", { name: "Tasks at Build" })).toContainText("WEB-7");
    await shot(page, `live-moments-7-text-${scheme}`);

    expect(errors).toEqual([]);
    await context.close();
  });
}

test("live moments, phone: the trail is a sheet the Live button opens", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const { tasks } = await mockV1(page);
  await page.goto("/projects/WEB/workflow");
  await expect(page.locator(".react-flow__edge").first()).toBeVisible();
  tasks.find((t) => t.id === "k-7")!.claim = claimOf(7, "m-builder-1");
  await emit(page, entryAt(60, "task.claimed", "k-7", "m-builder-1", { step_id: "st-build" }));
  await expect(page.locator(".flow-callout", { hasText: "builder-1 picked up WEB-7" })).toBeVisible();
  await page.waitForTimeout(400);
  await noSidewaysScroll(page);
  await shot(page, "live-moments-phone-canvas");
  await page.getByRole("button", { name: "Show the trail" }).click();
  await expect(page.getByRole("dialog").getByRole("list", { name: "Trail" })).toContainText("builder-1 picked up WEB-7 at Build");
  await page.waitForTimeout(600);
  await shot(page, "live-moments-phone-trail");
  expect(errors).toEqual([]);
  await context.close();
});

test("live moments, reduced motion: no token, the chip simply appears; the trail still says it", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const { tasks } = await mockV1(page);
  await page.goto("/projects/WEB/workflow");
  await expect(page.locator(".react-flow__edge").first()).toBeVisible();
  Object.assign(tasks.find((t) => t.id === "k-9")!, { step_id: "st-review", claim: undefined });
  await emit(page, entryAt(61, "task.advanced", "k-9", "m-qa", { from: "st-qa", to: "st-review", outcome: "pass" }));
  await expect(page.getByRole("complementary", { name: "Live trail" }).getByRole("listitem").first()).toContainText("qa-bot advanced WEB-9 along pass to Review");
  await expect(page.locator(".flow-token")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^WEB-9 / })).toBeVisible();
  await shot(page, "live-moments-reduced-motion");
  expect(errors).toEqual([]);
  await context.close();
});
