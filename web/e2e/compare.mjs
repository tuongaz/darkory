// Shoots a seeded Install (scripts/seed-fixture.mjs) frame by frame and lays each shot beside the
// final design's frame it answers (vf-1 … vf-10), in one page: e2e/screenshots/compare/index.html.
//
// The runbook, from the worktree's root (never the owner's .dev, never port 7357):
//
//   (cd web && npm run build)                        # the app the binary embeds (web/embed.go)
//   go build -o bin/darkory ./cmd/darkory            # always -o: never a binary at the root
//   S=<scratchpad>/compare-install && rm -rf "$S"
//   bin/darkory init --data "$S" --org Sacca --name "Tuong Le" --no-agents > "$S.init.txt"
//   export DARKORY_TOKEN=$(awk '/^Token for/{getline; print $1}' "$S.init.txt")
//   PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
//   bin/darkory serve --data "$S" --listen 127.0.0.1:$PORT --runner=off --no-browser --no-update-check &
//   export DARKORY_URL=http://127.0.0.1:$PORT
//   node scripts/seed-fixture.mjs                    # prints each Project's counts per Step and the keys it filed
//   (cd web && node e2e/compare.mjs)                 # writes e2e/screenshots/compare/index.html
//
// The token is the seeding admin's; the shots are taken signed in as them. Mockups are read from
// MOCKUPS (default: the wf-round's dir-e in the session scratchpad). What differs and why it stays
// is written under each pair from compare.notes.json, keyed by frame, which a reviewer keeps up to
// date.
import { chromium } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "screenshots", "compare");
const mockups = process.env.MOCKUPS ?? "/private/tmp/claude-501/-Users-tuongaz-dev-darkory/066e879e-2e98-43de-93f7-a295eb3f5238/scratchpad/wf-round/dir-e";
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

/** A Workflow's page (`/projects/:key/workflows/:id`), by the Workflow's name. */
async function workflow(key, name) {
  const { workflows } = await v1("GET", `/v1/projects/${key}/workflow`);
  const w = workflows.find((x) => x.name === name);
  if (!w) throw new Error(`${key} has no Workflow ${name}`);
  return `/projects/${key}/workflows/${w.id}`;
}
const dark = await workflow("DARK", "Implementation");
const darkG1 = await workflow("DARKG1", "Implementation");
const bugs = await workflow("DARK", "Bug triage");
const acme = await workflow("ACME", "Platform");
const news = await workflow("NEWS", "Editorial");
const own = await workflow("OWN", "Implementation");

/** Each frame: its mockup (vf-N.png), the size, how to reach it. */
const screens = [
  { name: "vf-1", size: "desktop", go: dark },
  { name: "vf-2", size: "desktop", go: darkG1 },
  { name: "vf-3", size: "desktop", go: bugs },
  {
    name: "vf-4",
    size: "desktop",
    go: dark,
    // Build's count, a control that opens the Step's list in place.
    act: async (page) => page.getByRole("button", { name: "Build: 13 Tasks waiting" }).click(),
  },
  { name: "vf-5", size: "desktop", go: acme },
  { name: "vf-6", size: "desktop", go: news },
  {
    name: "vf-7",
    size: "desktop",
    go: dark,
    // DARK-21's held chip; the strip "DARK-21's way" comes above the line.
    act: async (page) => {
      await page.locator('button[data-task="DARK-21"]').first().click();
      await page.getByText("DARK-21's way").waitFor();
      // The Connector hover, as vf-7 draws it on Review's needs changes.
      await page.locator("[data-return]", { hasText: "needs changes" }).first().hover();
    },
  },
  { name: "vf-8", size: "desktop", go: "/projects/DARK/workflows" },
  {
    name: "vf-9",
    size: "desktop",
    go: `${dark}/edit`,
    // QA added after Review, unsaved: Review's pass → QA; QA pass → Done, fail → Build.
    act: async (page) => {
      await page.getByRole("button", { name: "More for Review" }).click();
      await page.getByRole("menuitem", { name: "Add Step after Review" }).click();
      await page.getByRole("textbox", { name: "Name of the new Step" }).fill("QA");
      await page.getByRole("combobox", { name: "Skill of QA" }).click();
      await page.getByPlaceholder("Find or name a Skill").fill("qa");
      await page.getByRole("option", { name: /^qa/ }).click();
      const lead = async (outcome, from, to) => {
        await page.getByRole("combobox", { name: `Where ${outcome} out of ${from} leads` }).click();
        await page.getByRole("option", { name: to, exact: true }).click();
      };
      await lead("pass", "Review", "QA");
      for (const [outcome, to] of [["pass", "Done"], ["fail", "Build"]]) {
        await page.getByRole("button", { name: "Add an outcome out of QA" }).click();
        await page.getByRole("textbox", { name: "Outcome out of QA" }).fill(outcome);
        await lead(outcome, "QA", to);
      }
      await page.mouse.move(0, 0);
    },
  },
  { name: "vf-10", size: "phone", go: dark },
  // No frame: the owner's own MAIN shape (8 Steps, QA's and Acceptance's loops), read for breakage.
  { name: "own-page", size: "desktop", go: own },
  { name: "own-list", size: "desktop", go: "/projects/OWN/workflows" },
  { name: "own-page-phone", size: "phone", go: own },
  { name: "own-list-phone", size: "phone", go: "/projects/OWN/workflows" },
];

const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const shots = [];
for (const size of ["desktop", "phone"]) {
  const ctx = await browser.newContext({ viewport: sizes[size], deviceScaleFactor: 1, colorScheme: "light" });
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
    const mock = `${s.name}.png`;
    const hasMock = existsSync(join(mockups, mock));
    if (hasMock) copyFileSync(join(mockups, mock), join(out, `mock-${mock}`));
    shots.push({ ...s, mock: hasMock ? mock : null, errors: [...errors] });
    errors.length = 0;
  }
  await ctx.close();
}
await browser.close();
shots.sort((a, b) => screens.indexOf(screens.find((x) => x.name === a.name)) - screens.indexOf(screens.find((x) => x.name === b.name)));

const notesFile = join(here, "compare.notes.json");
const NOTES = existsSync(notesFile) ? JSON.parse(readFileSync(notesFile, "utf8")) : {};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const html = `<!doctype html><meta charset="utf-8"><title>Workflow page vs vf frames</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#222;background:#fafafa}
  h1{font-size:20px} h2{font-size:16px;margin:36px 0 8px}
  .pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
  .pair.phone{grid-template-columns:repeat(2,minmax(0,420px))}
  figure{margin:0;background:#fff;border:1px solid #ddd;padding:8px} figure img{width:100%;display:block}
  figcaption{font-size:12px;color:#666;margin-top:4px}
  ul{margin:8px 0 0 18px} .err{color:#b00}
</style>
<h1>The Workflow page against the final design (vf-1 … vf-10)</h1>
<p>Left: the seeded Install (scripts/seed-fixture.mjs from e2e/fixture/workflow-reads.json), ${esc(new Date().toISOString())}. Right: the frame. Ages and medians are the seed's own seconds; the fixture's clock (Fri 10 Oct 14:30 AEDT) cannot be set.</p>
${shots
  .map(
    (s) => `<h2>${esc(s.name)}</h2>
<div class="pair ${s.size}">
  <figure><img src="${esc(s.name)}.png"><figcaption>Real, ${esc(s.size)}</figcaption></figure>
  ${s.mock ? `<figure><img src="mock-${esc(s.mock)}"><figcaption>Mockup</figcaption></figure>` : `<figure><figcaption>No frame draws this one.</figcaption></figure>`}
</div>
${s.errors.length ? `<p class="err">Console errors: ${esc(s.errors.join(" | "))}</p>` : ""}
${NOTES[s.name]?.length ? `<ul>${NOTES[s.name].map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`,
  )
  .join("\n")}`;
writeFileSync(join(out, "index.html"), html);
console.log(`wrote ${join(out, "index.html")} (${shots.length} screens)`);
