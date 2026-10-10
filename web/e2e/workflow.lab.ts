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

      // Live: the line.
      await page.goto("/projects/WEB/workflows/wf-work");
      const live = page.getByRole("region", { name: "Workflow", exact: true });
      await expect(live.locator('button[data-task="WEB-5"]')).toBeVisible();
      await expect(live.getByRole("img", { name: "builder-1 (agent), working" }).first()).toBeVisible();
      await page.waitForTimeout(400);
      await noSidewaysScroll(page);
      await shot(page, `live-${tag}`);

      // The rail and a return track say what they mean on hover: nothing drawn over them takes the pointer.
      // (A line is a zero-width box to Playwright, so the pointer goes to its middle by hand.)
      const pointAt = async (selector: string) => {
        const b = await live.locator(selector).first().evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.move(b.x, b.y);
      };
      await pointAt('svg path[data-hint^="Build → QA"]');
      await expect(page.getByRole("tooltip")).toHaveText("Build → QA: when the holder says pass");
      await pointAt('svg path[data-connectors][data-hint*="when the holder says needs changes"]');
      await expect(page.getByRole("tooltip")).toContainText("when the holder says needs changes");
      await page.mouse.move(0, 0);

      // Text view: the same switch at every size.
      await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Text" }).click();
      await expect(page.getByRole("list", { name: "Steps", exact: true })).toBeVisible();
      await noSidewaysScroll(page);
      await shot(page, `live-text-${tag}`);

      // Editing: the list beside the picked Step's panel, the line above (on a phone, the line behind its toggle).
      await page.goto("/projects/WEB/workflows/wf-work/edit");
      await expect(page.getByRole("list", { name: "Steps", exact: true })).toBeVisible();
      await page.waitForTimeout(300);
      await noSidewaysScroll(page);
      await shot(page, `edit-${tag}`);
      if (size.name === "phone") {
        await page.getByRole("button", { name: "Show the line" }).click();
        await shot(page, `edit-line-${tag}`);
      }

      // F5a: a Step added after Review from its panel's menu, named, its Skill picker open on a Skill that does not exist.
      await page.getByRole("list", { name: "Steps", exact: true }).getByRole("button", { name: /^\d+\. Review$/ }).click();
      await page.getByRole("button", { name: "More for Review" }).click();
      await page.getByRole("menuitem", { name: "Add Step after Review" }).click();
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
      await page.getByRole("button", { name: "More for Security review" }).click();
      await page.getByRole("menuitem", { name: "Add Step after Security review" }).click();
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
  await page.goto("/projects/WEB/workflows/wf-work/edit?step=st-qa");
  const name = page.getByRole("textbox", { name: "Name of Step 4" });
  await expect(name).toBeFocused();
  await name.fill("Test");
  await expect(page.getByText("Editing · 1 change")).toBeVisible();
  // Alt+↓ on its row moves it after Review, and keeps the focus.
  await page.getByRole("button", { name: "4. Test" }).press("Alt+ArrowDown");
  await expect(page.getByRole("listitem", { name: "5. Test" })).toBeVisible();
  await expect(page.getByRole("button", { name: "5. Test" })).toBeFocused();
  await page.getByRole("combobox", { name: "Skill of Test" }).click();
  await page.getByPlaceholder("Find or name a Skill").fill("testing");
  await page.getByRole("option", { name: /New Skill “testing”/ }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Text" }).fill("Test it.");
  await page.getByRole("dialog").getByRole("button", { name: "Use this Skill" }).click();
  // Its grip dragged onto Build's row: it lands in Build's place.
  await page.getByRole("listitem", { name: "5. Test" }).hover();
  const grip = await page.getByRole("button", { name: /^Reorder Test/ }).boundingBox();
  const build = await page.getByRole("listitem", { name: "3. Build" }).boundingBox();
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip!.x + 4, grip!.y - 10, { steps: 4 });
  await page.mouse.move(grip!.x + 4, build!.y + 6, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("listitem", { name: "3. Test" })).toBeVisible();
  await expect(page.getByRole("listitem", { name: "4. Build" })).toBeVisible();
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

// The live line as things happen: a pickup reads "now" with its tag, a Task travels its Connector
// (shot mid-way) and lands, a lapse is tagged; in light and dark, at a phone's size, and with
// reduced motion, no token.
const token = (page: Page, key: string) => page.getByRole("region", { name: "Workflow", exact: true }).locator(`button[data-task="${key}"]`);

for (const scheme of ["light", "dark"] as const) {
  test(`live moments, desktop, ${scheme}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = watchErrors(page);
    const { tasks } = await mockV1(page);
    const task = (n: number) => tasks.find((t) => t.id === `k-${n}`)!;
    await page.goto("/projects/WEB/workflows/wf-work");
    await expect(token(page, "WEB-5")).toHaveAttribute("aria-label", /^WEB-5 Normalise names on input, held by builder-1/);
    await page.waitForTimeout(400);
    await noSidewaysScroll(page);
    await shot(page, `live-moments-0-open-${scheme}`);

    // builder-1 picks up WEB-7 at Build.
    task(7).claim = claimOf(7, "m-builder-1");
    await emit(page, entryAt(60, "task.claimed", "k-7", "m-builder-1", { step_id: "st-build", skill_id: "s-engineer" }));
    await expect(token(page, "WEB-7")).toHaveAttribute("data-now", "");
    await expect(token(page, "WEB-7")).toHaveAttribute("data-pulse", "agent");
    await page.waitForTimeout(500);
    await shot(page, `live-moments-1-pickup-${scheme}`);

    // qa-bot passes WEB-9 on to Review: a token travels the pass Connector.
    Object.assign(task(9), { step_id: "st-review", claim: undefined });
    await emit(page, entryAt(61, "task.advanced", "k-9", "m-qa", { from: "st-qa", to: "st-review", outcome: "pass" }));
    await expect(page.locator('[data-travel="WEB-9"]')).toContainText("WEB-9");
    await page.waitForTimeout(550);
    await shot(page, `live-moments-2-travelling-${scheme}`);
    await expect(page.locator("[data-travel]")).toHaveCount(0, { timeout: 3_000 });
    await expect(token(page, "WEB-9")).toHaveAttribute("data-arrived", "");
    await shot(page, `live-moments-3-landed-${scheme}`);

    // builder-2's Claim on WEB-6 lapses; reviewer sends WEB-10 back to Build along the loop under the line.
    Object.assign(task(6), { claim: undefined });
    await emit(page, entryAt(62, "task.lapsed", "k-6", undefined, { holder_id: "m-builder-2", claim_id: "cl-6" }));
    Object.assign(task(10), { step_id: "st-build" });
    await emit(page, entryAt(63, "task.advanced", "k-10", "m-reviewer", { from: "st-review", to: "st-build", outcome: "needs changes" }));
    // Plan's WEB-4 fills the gap a tag would hang in: the lapse shows as the token's amber pulse.
    await expect(token(page, "WEB-6")).toHaveAttribute("data-pulse", "lapsed");
    await page.waitForTimeout(600);
    await shot(page, `live-moments-4-lapse-and-back-${scheme}`);

    // The text view lists each Step's Tasks.
    await page.getByRole("button", { name: "Text" }).click();
    const steps = page.getByRole("list", { name: "Steps", exact: true });
    await expect(steps.getByRole("list", { name: "Tasks at Build" })).toContainText("WEB-7");
    await shot(page, `live-moments-7-text-${scheme}`);

    expect(errors).toEqual([]);
    await context.close();
  });
}

test("live moments, phone: the line runs down the page and a pickup reads now", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const { tasks } = await mockV1(page);
  await page.goto("/projects/WEB/workflows/wf-work");
  await expect(page.getByRole("region", { name: "Workflow", exact: true })).toHaveAttribute("data-orientation", "vertical");
  tasks.find((t) => t.id === "k-7")!.claim = claimOf(7, "m-builder-1");
  await emit(page, entryAt(60, "task.claimed", "k-7", "m-builder-1", { step_id: "st-build" }));
  await expect(token(page, "WEB-7")).toContainText("now");
  await page.waitForTimeout(400);
  await noSidewaysScroll(page);
  await shot(page, "live-moments-phone-line");
  expect(errors).toEqual([]);
  await context.close();
});

test("live moments, reduced motion: no token travels, the Task simply appears at its next Step", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const { tasks } = await mockV1(page);
  await page.goto("/projects/WEB/workflows/wf-work");
  await expect(token(page, "WEB-9")).toBeVisible();
  Object.assign(tasks.find((t) => t.id === "k-9")!, { step_id: "st-review", claim: undefined });
  await emit(page, entryAt(61, "task.advanced", "k-9", "m-qa", { from: "st-qa", to: "st-review", outcome: "pass" }));
  await expect(token(page, "WEB-9")).toHaveAttribute("data-arrived", "");
  await expect(page.locator("[data-travel]")).toHaveCount(0);
  await shot(page, "live-moments-reduced-motion");
  expect(errors).toEqual([]);
  await context.close();
});
