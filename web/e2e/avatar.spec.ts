import { expect, test, type Browser, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startInstall, type Install } from "./server";

// Avatars against the real binary: an admin uploads an agent's Avatar from its settings header,
// and every mark of the agent shows it: the Agents table, the Workflow line. The server makes the
// image a 256-pixel PNG; the page loads it from /v1/files under the app's CSP. Screenshots go to
// e2e/screenshots/avatar/, or DARKORY_E2E_SHOTS when set.
test.describe.configure({ mode: "serial" });

const shots = process.env.DARKORY_E2E_SHOTS ?? fileURLToPath(new URL("./screenshots/avatar/", import.meta.url));
mkdirSync(shots, { recursive: true });

let install: Install;
let base = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  install = await startInstall({ roster: true });
  base = install.base;
});

test.afterAll(async () => {
  await install?.stop();
});

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer) {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A 600x400 PNG: a warm gradient with a light disc a little left of the middle, so the square crop shows. */
function portrait(): Buffer {
  const w = 600;
  const h = 400;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const d = Math.hypot(x - 280, y - 170);
      const disc = d < 110 ? 1 : 0;
      raw[i] = disc ? 250 : 40 + Math.round((150 * x) / w);
      raw[i + 1] = disc ? 230 : 90 + Math.round((80 * y) / h);
      raw[i + 2] = disc ? 200 : 200 - Math.round((120 * x) / w);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function signedIn(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(install.link);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base}/inbox`);
  return { ctx, page, errors };
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${shots}/${name}.png`, animations: "disabled" });

/** The image a mark shows has loaded: the browser decoded it, so /v1/files served it and the CSP let it in. */
async function loaded(mark: ReturnType<Page["getByRole"]>) {
  await expect(mark).toHaveAttribute("data-avatar", "image");
  await expect.poll(() => mark.locator("img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(256);
}

test("an admin uploads an agent's Avatar; the Agents table and the Workflow line show it", async ({ browser }) => {
  const { ctx, page, errors } = await signedIn(browser);

  await test.step("the agent's settings header offers Upload", async () => {
    await page.goto(`${base}/settings/organisation/agents/builder`);
    await expect(page.getByRole("button", { name: "Upload an Avatar for builder" })).toBeVisible();
    await shot(page, "01-settings-header-before");
  });

  await test.step("choosing an image previews it in the ring; Save Avatar sets it", async () => {
    await page.getByLabel("Avatar image for builder").setInputFiles({ name: "builder.jpg", mimeType: "image/png", buffer: portrait() });
    const dialog = page.getByRole("dialog", { name: "New Avatar for builder" });
    await expect(dialog.getByText("builder.jpg")).toBeVisible();
    await shot(page, "02-preview");
    await dialog.getByRole("button", { name: "Save Avatar" }).click();
    await expect(dialog).toBeHidden();
    const mark = page.getByRole("button", { name: "Change the Avatar of builder" }).getByRole("img", { name: "builder (agent)" });
    await loaded(mark);
    await shot(page, "03-settings-header-after");
  });

  await test.step("the Agents table shows it", async () => {
    await page.goto(`${base}/settings/organisation/agents`);
    await loaded(page.getByRole("img", { name: "builder (agent)" }).first());
    await shot(page, "04-agents-table");
  });

  await test.step("the Workflow line shows it on builder's Step", async () => {
    await page.goto(`${base}/projects/MAIN/workflows`);
    await loaded(page.getByRole("img", { name: /^builder \(agent\)/ }).first());
    await shot(page, "05-workflow-line");
  });

  await test.step("hovering builder's mark opens its card, whose large mark shows the Avatar", async () => {
    await page.getByRole("img", { name: /^builder \(agent\)/ }).first().hover();
    const card = page.locator('[data-slot="hover-card-content"]');
    await expect(card).toBeVisible();
    await loaded(card.getByRole("img", { name: /^builder \(agent\)/ }).first());
    await shot(page, "06-hover-card");
  });

  await test.step("Remove goes back to initials", async () => {
    await page.goto(`${base}/settings/organisation/agents/builder`);
    await page.getByRole("button", { name: "Change the Avatar of builder" }).click();
    await page.getByRole("menuitem", { name: "Remove Avatar" }).click();
    const mark = page.getByRole("button", { name: "Upload an Avatar for builder" }).getByRole("img", { name: "builder (agent)" });
    await expect(mark).not.toHaveAttribute("data-avatar", "image");
    await expect(mark).toHaveText("BL");
  });

  expect(errors).toEqual([]);
  await ctx.close();
});
