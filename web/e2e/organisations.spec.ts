import { expect, request, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Organisation switching (scenario 12) against the real binary. The Organisation menu's Switch
// Organisation always opens: on Local, which holds exactly one Organisation and whose /v1/me carries
// no `organisations`, it lists that one, ticked; a sign-in that reaches two (Cloud) is played by
// answering /v1/me with a second one added, which is listed but not opened (/v1 cannot switch).

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

/** Opens the Organisation menu on Switch Organisation, with O then W, and returns the submenu. */
async function switchOrganisation(page: Page) {
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await page.keyboard.press("o");
  await page.keyboard.press("w");
  const menus = page.getByRole("menu");
  await expect(menus).toHaveCount(2);
  return menus.nth(1);
}

test("Switch Organisation lists Local's one Organisation, ticked; a sign-in reaching two lists both", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await signIn(page);
  const me = await page.evaluate(() => fetch("/v1/me").then((r) => r.json()));
  expect(me.organisations).toBeUndefined();
  let sub = await switchOrganisation(page);
  await expect(sub.getByRole("menuitem")).toHaveText(["E2E Organisation", "Account settings"].map((t) => new RegExp(t)));
  await expect(sub.getByRole("menuitem", { name: "E2E Organisation" })).toHaveAttribute("aria-current", "true");
  await page.screenshot({ path: "e2e/screenshots/organisations/one.png", animations: "disabled" });
  await page.keyboard.press("Escape");

  await page.route("**/v1/me", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, organisations: [body.organisation, { id: "o-other", name: "Other Co" }] } });
  });
  await page.reload();
  sub = await switchOrganisation(page);
  await expect(sub.getByRole("menuitem", { name: "Other Co" })).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: "e2e/screenshots/organisations/two.png", animations: "disabled" });
  expect(errors).toEqual([]);
});
