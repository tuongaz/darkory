import { expect, request, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Organisation switching (scenario 12) against the real binary. Local holds exactly one
// Organisation, so /v1/me carries no `organisations` and the switcher has no Switch Organisation
// row; a sign-in that reaches two (Cloud) is played by answering /v1/me with a second one added.

const base = () => process.env.DARKORY_E2E_BASE_URL!;

async function signIn(page: Page) {
  const admin = await request.newContext({
    baseURL: base(),
    extraHTTPHeaders: { Authorization: `Bearer ${process.env.DARKORY_E2E_ADMIN_TOKEN!}`, "Darkory-Session": "e2e-orgs-ada" },
  });
  const res = await admin.post("/v1/members/ada/login-links", { headers: { "Idempotency-Key": randomUUID() } });
  const link = ((await res.json()) as { url: string }).url;
  await admin.dispose();
  await page.goto(link);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base()}/inbox`);
}

async function switcher(page: Page) {
  await page.getByRole("button", { name: /^Project: / }).click();
  return page.getByRole("menu");
}

test("Local's switcher has no Switch Organisation; a sign-in reaching two shows it", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await signIn(page);
  const me = await page.evaluate(() => fetch("/v1/me").then((r) => r.json()));
  expect(me.organisations).toBeUndefined();
  let menu = await switcher(page);
  await expect(menu.getByRole("menuitem", { name: /Switch Organisation/ })).toHaveCount(0);
  await page.screenshot({ path: "e2e/screenshots/organisations/one.png", animations: "disabled" });
  await page.keyboard.press("Escape");

  await page.route("**/v1/me", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, organisations: [body.organisation, { id: "o-other", name: "Other Co" }] } });
  });
  await page.reload();
  menu = await switcher(page);
  await expect(menu.getByRole("menuitem", { name: /Switch Organisation/ })).toBeVisible();
  await page.screenshot({ path: "e2e/screenshots/organisations/two.png", animations: "disabled" });
  expect(errors).toEqual([]);
});
