// Shoots a seeded Install (scripts/seed-sample.sh) screen by screen and lays each shot beside the
// approved mockup it was built from, in one page: e2e/screenshots/compare/index.html.
//
//   DARKORY_URL=http://127.0.0.1:7791 DARKORY_TOKEN=dk_... node e2e/compare.mjs
//
// The token is the seeding admin's; the shots are taken signed in as them. Mockups are read from
// MOCKUPS (default: ../../mock-workflow/shots beside this worktree). What differs and why stays is
// written under each pair from NOTES below, which a reviewer keeps up to date.
import { chromium } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "screenshots", "compare");
const mockups = process.env.MOCKUPS ?? join(here, "..", "..", "..", "mock-workflow", "shots");
const base = (process.env.DARKORY_URL ?? "").replace(/\/$/, "");
const token = process.env.DARKORY_TOKEN ?? "";
if (!base || !token) throw new Error("set DARKORY_URL and DARKORY_TOKEN");

async function v1(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Darkory-Session": "compare", "Idempotency-Key": crypto.randomUUID(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const me = (await v1("GET", "/v1/me")).member;
const open = (await v1("GET", "/v1/tasks?project=SAM&state=open")).items;
const byTitle = (t) => open.find((x) => x.title === t)?.key;
const keys = {
  exportReactions: byTitle("Export reactions"),
  emoji: byTitle("Emoji reactions on support messages"),
  picker: byTitle("Reaction picker on a message"),
  abn: byTitle("Invoice PDF shows the wrong ABN"),
};

/** A Project's first Workflow's page (`/projects/:key/workflows/:id`): the line is one Workflow's, the list's address only lists them. */
async function firstWorkflow(key) {
  const { workflows } = await v1("GET", `/v1/projects/${key}/workflow`);
  const first = [...workflows].sort((a, b) => a.position - b.position)[0];
  if (!first) throw new Error(`${key} has no Workflow`);
  return `/projects/${key}/workflows/${first.id}`;
}
const sam = await firstWorkflow("SAM");
const big = await firstWorkflow("BIG");

/** Each screen: its name, the mockup it answers, the size, how to reach it, and what stays different. */
const screens = [
  { name: "page", mock: "r2-final-1.png", size: "desktop", go: sam },
  {
    name: "selected",
    mock: "r2-final-2.png",
    size: "desktop",
    go: sam,
    act: async (page) => page.locator(`button[data-task="${keys.exportReactions}"]`).click(),
  },
  { name: "blocking", mock: "r2-deps-6.png", size: "desktop", go: `${sam}?view=blocking` },
  { name: "big-line", mock: "d-11.png", size: "desktop", go: big },
  { name: "big-blocking", mock: "r2-deps-8.png", size: "desktop", go: `${big}?view=blocking` },
  {
    name: "scope-menu",
    mock: "r2-scope-6.png",
    size: "desktop",
    go: sam,
    act: async (page) => {
      // The ScopeChip's button, named "Scope: <what the line shows>".
      await page.getByRole("button", { name: /^Scope: / }).click();
      await page.getByRole("option", { name: new RegExp(keys.emoji) }).hover();
    },
  },
  { name: "parent-line", mock: "r2-scope-3.png", size: "desktop", go: `/tasks/${keys.emoji}?view=line` },
  { name: "subtask-peek", mock: "r2-scope-4.png", size: "desktop", go: `/projects/SAM/tasks?view=board&task=${keys.picker}` },
  { name: "standalone", mock: "r2-scope-5.png", size: "desktop", go: `/tasks/${keys.abn}` },
  { name: "editor", mock: "d-6.png", size: "desktop", go: `${sam}/edit` },
  { name: "inbox", mock: null, size: "desktop", go: "/inbox" },
  { name: "phone", mock: "r2-final-5.png", size: "phone", go: sam },
];

const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const shots = [];
for (const size of ["desktop", "phone"]) {
  const ctx = await browser.newContext({ viewport: sizes[size], deviceScaleFactor: 2, colorScheme: "light" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("WebSocket connection") && errors.push(m.text()));
  const { url } = await v1("POST", `/v1/members/${me.id}/login-links`);
  await page.goto(url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await page.waitForURL(`${base}/inbox`);
  for (const s of screens.filter((x) => x.size === size)) {
    await page.goto(`${base}${s.go}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    if (s.act) {
      await s.act(page);
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: join(out, `${s.name}.png`) });
    if (s.mock && existsSync(join(mockups, s.mock))) copyFileSync(join(mockups, s.mock), join(out, `mock-${s.mock}`));
    shots.push({ ...s, errors: [...errors] });
    errors.length = 0;
  }
  await ctx.close();
}
await browser.close();

const NOTES = existsSync(join(here, "compare.notes.json")) ? JSON.parse((await import("node:fs")).readFileSync(join(here, "compare.notes.json"), "utf8")) : {};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const html = `<!doctype html><meta charset="utf-8"><title>Workflow line vs mockups</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}
  h1{font-size:20px} h2{font-size:16px;margin:36px 0 8px}
  .pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
  .pair.phone{grid-template-columns:repeat(2,minmax(0,420px))}
  figure{margin:0;background:#fff;border:1px solid #ddd;padding:8px} figure img{width:100%;display:block}
  figcaption{font-size:12px;color:#666;margin-top:4px}
  ul{margin:8px 0 0 18px} .err{color:#b00}
</style>
<h1>The Workflow line against the approved mockups</h1>
<p>Left: the seeded Install (scripts/seed-sample.sh), ${esc(new Date().toISOString())}. Right: the mockup. Keys read SAM-n where the fixture has MAIN-n; times are relative to when the seed ran.</p>
${shots
  .map(
    (s) => `<h2>${esc(s.name)}${s.mock ? ` · ${esc(s.mock)}` : ""}</h2>
<div class="pair ${s.size}">
  <figure><img src="${esc(s.name)}.png"><figcaption>Real, ${esc(s.size)}</figcaption></figure>
  ${s.mock ? `<figure><img src="mock-${esc(s.mock)}"><figcaption>Mockup</figcaption></figure>` : "<figure><figcaption>No mockup: the shipped Inbox, for its words about this data.</figcaption></figure>"}
</div>
${s.errors.length ? `<p class="err">Console errors: ${esc(s.errors.join(" | "))}</p>` : ""}
${NOTES[s.name] ? `<ul>${NOTES[s.name].map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`,
  )
  .join("\n")}`;
writeFileSync(join(out, "index.html"), html);
console.log(`wrote ${join(out, "index.html")} (${shots.length} screens)`);
