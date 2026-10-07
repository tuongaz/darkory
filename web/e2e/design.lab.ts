import { expect, test, type Page } from "@playwright/test";

// The design lab in a real browser (`npm run lab`): no console error, no sideways scroll on a
// phone, the working ring turning (and still under reduced motion), the editing canvas's drags,
// and screenshots of each size and theme for a person to look at.

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

async function open(page: Page) {
  await page.goto("/dev/design");
  await expect(page.getByRole("heading", { name: "Design lab" })).toBeVisible();
  // The canvases have drawn their Connectors and the graph its arrows.
  await expect(page.getByRole("region", { name: "Workflow", exact: true }).locator(".react-flow__edge").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Subtasks, graph" }).locator(".react-flow__edge").first()).toBeVisible();
}

const spin = (page: Page) =>
  page
    .getByRole("img", { name: "builder-1 (agent), working" })
    .first()
    .evaluate((el) => getComputedStyle(el).getPropertyValue("--spin"));

for (const scheme of ["light", "dark"] as const) {
  for (const size of sizes) {
    test(`${size.name}, ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors = watchErrors(page);
      await open(page);

      const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(widths.scroll).toBe(widths.client);
      // The graph scrolls sideways in its box under a finger too.
      const graphPane = page.getByRole("region", { name: "Subtasks, graph" }).locator(".react-flow__pane");
      expect(await graphPane.evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-x pan-y");

      await page.screenshot({ path: `e2e/screenshots/lab-${size.name}-${scheme}.png`, fullPage: true });
      if (size.name === "desktop") {
        for (const name of ["Marks", "WorkGlyph", "Workflow canvas · live", "Workflow canvas · editing", "Subtask graph"]) {
          const slug = name.toLowerCase().replace(/[^a-z]+/g, "-");
          await page.getByRole("region", { name }).screenshot({ path: `e2e/screenshots/lab-${slug}-${scheme}.png` });
        }
      }
      expect(errors).toEqual([]);
      await context.close();
    });
  }
}

test("an agent's ring turns while its session runs, and stands still under reduced motion", async ({ browser }) => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const context = await browser.newContext({ reducedMotion });
    const page = await context.newPage();
    await open(page);
    const first = await spin(page);
    await page.waitForTimeout(300);
    const later = await spin(page);
    if (reducedMotion === "reduce") expect(later).toBe(first);
    else expect(later).not.toBe(first);
    await context.close();
  }
});

test("the editing canvas: select, drag, connect, add and tidy, each a callback", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const canvas = page.getByRole("region", { name: "Workflow, editing" });
  const log = page.getByRole("list", { name: "Callbacks" });
  await canvas.scrollIntoViewIfNeeded();

  const build = canvas.locator(".react-flow__node").filter({ has: page.getByText("Build", { exact: true }) });
  await build.click();
  await expect(log).toContainText("onSelect(Build)");
  await expect(canvas.getByRole("region", { name: "Selected" })).toContainText("Connectors out");

  // Drag the step a little: one onMove, on the drop.
  const box = (await build.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 52, { steps: 8 });
  await page.mouse.up();
  await expect(log).toContainText(/onMove\(Build, \d+, \d+\)/);

  // Draw a Connector from Docs' out into Done's in.
  const docs = canvas.locator(".react-flow__node").filter({ has: page.getByText("Docs", { exact: true }) });
  await docs.hover();
  const from = (await docs.locator("[data-handleid=out]").boundingBox())!;
  const done = canvas.locator(".react-flow__node").filter({ has: page.getByText("Done", { exact: true }) });
  const into = (await done.locator("[data-handleid=in]").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(into.x + into.width / 2, into.y + into.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(log).toContainText("onAddConnector(Docs → Done)");

  await docs.hover();
  await canvas.getByRole("button", { name: "Add a step after Docs" }).click();
  await expect(log).toContainText("onAddStep(Docs)");

  await canvas.getByRole("button", { name: "Tidy up" }).click();
  await expect(log).toContainText(/onLayout\(\d+ steps\)/);
  await canvas.screenshot({ path: "e2e/screenshots/lab-editing-after.png" });
  expect(errors).toEqual([]);
});
