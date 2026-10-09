import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall, type Install } from "./server";

// Work flowing through a Workflow, watched in the browser, against the real binary on an Install of
// its own (docs/build/model-v2-plan.md, Scenarios 1 and 2):
//
//   1. In a Project shaped like Sacca's (Plan · Build · QA · Review · Acceptance · Retro), ada files
//      a Task with Break down, Auto-complete and Acceptance from the web; the agents, played here
//      through /v1 with their own tokens, take it on: the planner files the Subtasks, the builder
//      advances `pass` to QA, qa `fail`s it back to Build with a Note, then `pass`es it, the reviewer
//      advances it into Done. Each Claim shows live, with its holder and Heartbeat. ada accepts the
//      whole in the web; the Parent completes itself and its Retrospective is filed.
//   2. An accounting Project (Backlog · Gather · Prepare · Partner review, Partner review into Done
//      along `lodged`) worked by humans alone in their browsers: Kai, the partner, moves a return out
//      of Backlog on the board, Lan gathers, Mai prepares, and Kai lodges it. No agent, no Workspace.
//
// (The review's merge into the default branch needs a git Workspace; e2e/runner_test.go covers it.)
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/flow/", import.meta.url));

let install: Install;
let base = "";

type Who = { token: string; session: string };
type Task = { id: string; key: string; title: string; state: string; kind: string; step_id?: string; parent_id?: string; claim?: { holder_id: string } };
type Detail = { task: Task; subtasks: Task[] };
type Step = { id: string; name: string };

async function call<T = unknown>(who: Who, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "Darkory-Session": who.session, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

let ada: Who;
const ask = <T = unknown>(method: string, path: string, body?: unknown) => call<T>(ada, method, path, body);

/** A Member with a token of their own, in a Session they name. */
async function member(name: string, kind: "human" | "agent", skills: string[], project: string): Promise<Who> {
  await ask("POST", "/v1/members", { name, kind });
  await ask("PUT", `/v1/members/${name}/manager`, { manager: "ada" });
  await ask("PUT", `/v1/projects/${project}/members/${name}`);
  for (const s of skills) await ask("PUT", `/v1/members/${name}/skills/${s}`);
  const { secret } = await ask<{ secret: string }>("POST", `/v1/members/${name}/tokens`, { name: "e2e" });
  return { token: secret, session: `${name.toLowerCase().replace(/\W+/g, "-")}-1` };
}

async function skill(name: string, body: string) {
  await ask("POST", "/v1/skills", { name, kind: "generic", body });
}

/** A browser signed in as `name` through a login link ada asks /v1 for. */
async function signIn(browser: Browser, name: string): Promise<Awaited<ReturnType<BrowserContext["storageState"]>>> {
  const { url } = await ask<{ url: string }>("POST", `/v1/members/${encodeURIComponent(name)}/login-links`);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base}/inbox`);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function open(browser: Browser, state: Awaited<ReturnType<BrowserContext["storageState"]>>) {
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return { ctx, page, errors };
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${shots}${name}.png`, animations: "disabled" });

async function markLoaded(page: Page) {
  await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));
}
async function notReloaded(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded)).toBe(true);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  install = await startInstall();
  base = install.base;
  ada = { token: install.token, session: "e2e-flow-ada" };
});

test.afterAll(async () => {
  await install?.stop();
});

test("scenario 1: Break down, Subtasks through Build, QA and Review, Acceptance, the Parent completes itself, its Retro filed", async ({ browser }) => {
  // The Sacca shape: the default Workflow's Steps with QA between Build and Review, and Acceptance.
  // qa is init's, seeded beside engineer and review for Bug triage's Verify (sample-workflows-plan.md).
  await ask("POST", "/v1/projects", { key: "SAC", name: "Sacca", members: ["ada"], workflow: "empty" });
  await ask("PUT", "/v1/projects/SAC/workflow", {
    // Its one Workflow, Work, as the empty Project started it (ADR 0019).
    workflows: [{ name: "Work" }],
    steps: [
      { workflow: "Work", name: "Backlog", position: 1 },
      { workflow: "Work", name: "Plan", skill: "breakdown", position: 2 },
      { workflow: "Work", name: "Build", skill: "engineer", position: 3 },
      { workflow: "Work", name: "QA", skill: "qa", position: 4 },
      { workflow: "Work", name: "Review", skill: "review", position: 5 },
      { workflow: "Work", name: "Acceptance", skill: "acceptance", position: 6 },
      { workflow: "Work", name: "Retro", skill: "retro", position: 7 },
    ],
    connectors: [
      { from: "Plan", name: "done", position: 1 },
      { from: "Build", to: "QA", name: "pass", position: 1 },
      { from: "QA", to: "Review", name: "pass", position: 1 },
      { from: "QA", to: "Build", name: "fail", position: 2 },
      { from: "Review", name: "pass", position: 1 },
      { from: "Review", to: "Build", name: "needs changes", position: 2 },
      { from: "Acceptance", name: "accepted", position: 1 },
      { from: "Retro", name: "done", position: 1 },
    ],
  });
  const planner = await member("planner", "agent", ["breakdown"], "SAC");
  const builder = await member("builder", "agent", ["engineer"], "SAC");
  const qa = await member("qa-bot", "agent", ["qa"], "SAC");
  const reviewer = await member("reviewer", "agent", ["review"], "SAC");
  // ada accepts the whole; retro is nobody's, so its Retrospective waits at Retro.
  await ask("PUT", "/v1/members/ada/skills/acceptance");
  const steps = (await ask<{ steps: Step[] }>("GET", "/v1/projects/SAC/workflow")).steps;
  const stepId = (name: string) => steps.find((s) => s.name === name)!.id;
  const hb = { heartbeat_timeout_seconds: 600 };

  const { ctx, page, errors } = await open(browser, await signIn(browser, "ada"));
  let parent: Task;

  await test.step("ada files the Task from the web with Break down, Auto-complete and Acceptance", async () => {
    await page.goto(`${base}/projects/SAC/tasks`);
    await page.getByRole("button", { name: "File Task" }).first().click();
    const dialog = page.getByRole("dialog", { name: "File a Task" });
    await dialog.getByLabel("Title").fill("Saved cards at checkout");
    await dialog.getByRole("switch", { name: "Break down" }).click();
    await dialog.getByRole("switch", { name: "Auto-complete" }).click();
    await dialog.getByRole("switch", { name: "Acceptance" }).click();
    // Filed as a Parent it is at no Step; its ⓘ says where the Breakdown waits.
    await expect(dialog.getByRole("combobox", { name: "Step" })).toContainText("None: a Parent");
    await dialog.getByRole("button", { name: "About Break down" }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "Files its Breakdown at Plan" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await shot(page, "1-01-file-with-breakdown");
    await dialog.getByRole("button", { name: "File Task" }).click();
    await expect(dialog).toHaveCount(0);
    const filed = (await ask<{ items: Task[] }>("GET", "/v1/tasks?project=SAC")).items;
    parent = filed.find((t) => t.title === "Saved cards at checkout")!;
    const breakdown = filed.find((t) => t.kind === "breakdown")!;
    expect(breakdown.parent_id).toBe(parent.id);
    expect(breakdown.step_id).toBe(stepId("Plan"));
    await page.goto(`${base}/tasks/${parent.key}`);
    await expect(page.getByRole("region", { name: "Subtasks" })).toContainText("Plan");
    // An open Parent's head says Open; its Subtasks' progress is their section's alone.
    await expect(page.getByRole("heading", { level: 1 }).locator("..")).toContainText("Open");
    await expect(page.getByText(/Its Subtasks/)).toHaveCount(0);
    await shot(page, "1-02-parent-with-breakdown");
  });

  await test.step("the planner's Claim shows live, with its holder and Heartbeat", async () => {
    const breakdown = (await ask<Detail>("GET", `/v1/tasks/${parent.key}`)).subtasks.find((t) => t.kind === "breakdown")!;
    await page.goto(`${base}/tasks/${breakdown.key}`);
    const properties = page.getByRole("complementary", { name: "Properties" });
    await expect(properties).toContainText("Held byNobody");
    await markLoaded(page);
    await call(planner, "POST", `/v1/tasks/${breakdown.id}/claim`, hb);
    await expect(properties).toContainText(/Held by(PL)?planner/);
    await expect(properties.getByText(/lapses in (9|10)m/)).toBeVisible();
    await notReloaded(page);
    await shot(page, "1-03-planner-claim-live");

    // The planner files the two Subtasks under the Parent and completes its Breakdown.
    await call(planner, "POST", "/v1/tasks", { parent: parent.key, title: "Card vault client" });
    await call(planner, "POST", "/v1/tasks", { parent: parent.key, title: "Saved cards list" });
    await call(planner, "POST", `/v1/tasks/${breakdown.id}/advance`, { outcome: "done", note: "Two Subtasks, both at Build" });
    await expect(page.getByRole("heading", { level: 1 }).locator("..")).toContainText("Done");
    await shot(page, "1-04-breakdown-done");
  });

  const subtask = async (title: string) => (await ask<Detail>("GET", `/v1/tasks/${parent.key}`)).subtasks.find((t) => t.title === title)!;
  const subtasks = page.getByRole("region", { name: "Subtasks" });
  const row = (title: string) => subtasks.getByRole("link", { name: new RegExp(title) });

  await test.step("the builder advances each pass to QA; qa fails one back to Build with a Note", async () => {
    await page.goto(`${base}/tasks/${parent.key}?view=list`);
    await markLoaded(page);
    for (const title of ["Card vault client", "Saved cards list"]) {
      const t = await subtask(title);
      await call(builder, "POST", `/v1/tasks/${t.id}/claim`, hb);
      await expect(row(title)).toContainText("Build");
      await call(builder, "POST", `/v1/tasks/${t.id}/advance`, { outcome: "pass", note: "Built, with tests" });
      await expect(row(title)).toContainText("QA");
    }
    await shot(page, "1-05-both-at-qa");
    const vault = await subtask("Card vault client");
    await call(qa, "POST", `/v1/tasks/${vault.id}/claim`, hb);
    await call(qa, "POST", `/v1/tasks/${vault.id}/advance`, { outcome: "fail", note: "Expired cards are still offered" });
    await expect(row("Card vault client")).toContainText("Build");
    await notReloaded(page);
    await shot(page, "1-06-qa-failed-back-to-build");
    // The Note travels with the Task: the builder reads it on the way back.
    await page.goto(`${base}/tasks/${vault.key}`);
    await expect(page.getByText("Expired cards are still offered")).toBeVisible();
    await expect(page.getByRole("list", { name: "Path through the Steps" })).toContainText("fail");
    await shot(page, "1-07-fail-note");
  });

  await test.step("built again, qa passes both, the reviewer advances them into Done; Acceptance is filed", async () => {
    const vault = await subtask("Card vault client");
    // No one judges their own work: the builder holds it again under engineer, as before.
    await call(builder, "POST", `/v1/tasks/${vault.id}/claim`, hb);
    await call(builder, "POST", `/v1/tasks/${vault.id}/advance`, { outcome: "pass", note: "Expired cards filtered" });
    await page.goto(`${base}/tasks/${parent.key}?view=list`);
    await markLoaded(page);
    for (const title of ["Card vault client", "Saved cards list"]) {
      const t = await subtask(title);
      await call(qa, "POST", `/v1/tasks/${t.id}/claim`, hb);
      await call(qa, "POST", `/v1/tasks/${t.id}/advance`, { outcome: "pass" });
      await call(reviewer, "POST", `/v1/tasks/${t.id}/claim`, hb);
      await call(reviewer, "POST", `/v1/tasks/${t.id}/advance`, { outcome: "pass" });
      await expect(row(title)).toContainText("Done");
    }
    await expect(subtasks.getByRole("link", { name: /Acceptance/ })).toBeVisible();
    await notReloaded(page);
    await shot(page, "1-08-acceptance-filed");
  });

  await test.step("ada claims the Acceptance and completes it in the web; the Parent completes itself; the Retro is filed", async () => {
    const acceptance = (await ask<Detail>("GET", `/v1/tasks/${parent.key}`)).subtasks.find((t) => t.kind === "acceptance")!;
    expect(acceptance.step_id).toBe(stepId("Acceptance"));
    await page.goto(`${base}/tasks/${acceptance.key}`);
    await page.getByRole("button", { name: "Claim" }).click();
    await page.getByRole("button", { name: "Complete · accepted" }).click();
    const confirm = page.getByRole("dialog", { name: `Complete ${acceptance.key} · accepted` });
    await shot(page, "1-09-accept");
    await confirm.getByRole("button", { name: "Complete" }).click();
    await expect(page.getByRole("heading", { level: 1 }).locator("..")).toContainText("Done");

    await expect.poll(async () => (await ask<Detail>("GET", `/v1/tasks/${parent.key}`)).task.state).toBe("done");
    const after = await ask<Detail>("GET", `/v1/tasks/${parent.key}`);
    const retro = after.subtasks.find((t) => t.kind === "retrospective")!;
    expect(retro.state).toBe("open");
    expect(retro.step_id).toBe(stepId("Retro"));
    await page.goto(`${base}/tasks/${parent.key}?view=list`);
    await expect(page.getByRole("heading", { level: 1 }).locator("..")).toContainText("Done");
    await expect(subtasks.getByRole("link", { name: /Retrospective/ })).toContainText("Retro");
    // It completed itself; ada completed only the Acceptance, the planner only the Breakdown.
    await expect(page.getByText(`Completed itself (Auto-complete) when ${acceptance.key} ended`)).toBeVisible();
    await expect(page.getByText(/(planner|ada) completed it$/)).toHaveCount(0);
    await shot(page, "1-10-parent-done-retro-filed");
    await page.goto(`${base}/tasks/${parent.key}?view=line`);
    await expect(page.getByRole("region", { name: "Subtask line" })).toBeVisible();
    await shot(page, "1-11-line");
  });

  expect(errors).toEqual([]);
  await ctx.close();
});

test("scenario 2: an accounting Project worked by humans alone: out of Backlog, gathered, prepared, lodged", async ({ browser }) => {
  for (const [name, body] of [
    ["client-comms", "Ask the client for what the return needs."],
    ["bookkeeping", "Prepare the return from what was gathered."],
    ["partner-review", "Review a prepared return before it is lodged."],
  ]) {
    await skill(name, body);
  }
  await ask("POST", "/v1/projects", { key: "TAX", name: "Tax", members: ["ada"], workflow: "empty" });
  await ask("PUT", "/v1/projects/TAX/workflow", {
    // Its one Workflow, Work, as the empty Project started it (ADR 0019).
    workflows: [{ name: "Work" }],
    steps: [
      { workflow: "Work", name: "Backlog", position: 1 },
      { workflow: "Work", name: "Gather", skill: "client-comms", position: 2 },
      { workflow: "Work", name: "Prepare", skill: "bookkeeping", position: 3 },
      { workflow: "Work", name: "Partner review", skill: "partner-review", position: 4 },
    ],
    connectors: [
      { from: "Gather", to: "Prepare", name: "gathered", position: 1 },
      { from: "Prepare", to: "Partner review", name: "prepared", position: 1 },
      { from: "Partner review", name: "lodged", position: 1 },
      { from: "Partner review", to: "Prepare", name: "needs changes", position: 2 },
    ],
  });
  await member("Lan Pham", "human", ["client-comms"], "TAX");
  await member("Mai Tran", "human", ["bookkeeping"], "TAX");
  const kai = await member("Kai Nguyen", "human", ["partner-review"], "TAX");
  // Kai owns the return, filed ahead into Backlog, where nobody is offered it.
  const filed = await call<Detail>(kai, "POST", "/v1/tasks", { project: "TAX", title: "Q1 BAS for Harbour Cafe", step: "Backlog" });
  const key = filed.task.key;

  const kaiPage = await open(browser, await signIn(browser, "Kai Nguyen"));
  const lanPage = await open(browser, await signIn(browser, "Lan Pham"));
  const maiPage = await open(browser, await signIn(browser, "Mai Tran"));

  await test.step("in Backlog it is nobody's to take: Lan's Inbox does not offer it", async () => {
    await lanPage.page.goto(`${base}/inbox`);
    await expect(lanPage.page.getByRole("heading", { name: "Inbox" })).toBeAttached();
    await expect(lanPage.page.locator(`[data-task="${key}"]`)).toHaveCount(0);
    await shot(lanPage.page, "2-01-lan-inbox-empty");
    await markLoaded(lanPage.page);
  });

  await test.step("Kai, a human, moves it out of Backlog to Gather on the board", async () => {
    const page = kaiPage.page;
    await page.goto(`${base}/projects/TAX/tasks?view=board`);
    const card = page.locator(`[data-task="${key}"]`);
    await expect(page.getByRole("region", { name: "Backlog", exact: true }).locator(`[data-task="${key}"]`)).toBeVisible();
    await shot(page, "2-02-board-backlog");
    const to = page.getByRole("region", { name: "Gather", exact: true });
    const a = (await card.boundingBox())!;
    const b = (await to.boundingBox())!;
    await page.mouse.move(a.x + 20, a.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + 60, { steps: 12 });
    await page.mouse.up();
    await expect(to.locator(`[data-task="${key}"]`)).toBeVisible();
    // The lifted card has settled into its column.
    await expect(page.locator(".card-overlay *")).toHaveCount(0);
    await shot(page, "2-03-board-moved-to-gather");
  });

  await test.step("Lan's Inbox offers it now, live; she claims it and advances it along gathered", async () => {
    const page = lanPage.page;
    const takeable = page.getByRole("region", { name: "Takeable by you" }).locator(`[data-task="${key}"]`);
    await expect(takeable).toContainText("Gather");
    await notReloaded(page);
    await shot(page, "2-04-lan-takeable");
    await page.goto(`${base}/tasks/${key}`);
    await page.getByRole("button", { name: "Claim" }).click();
    await page.getByRole("button", { name: "Advance · gathered" }).click();
    const dialog = page.getByRole("dialog", { name: `Advance ${key} · gathered` });
    await dialog.getByRole("textbox").first().fill("Bank statements and receipts are in the folder.");
    await shot(page, "2-05-lan-advance");
    await dialog.getByRole("button", { name: "Advance" }).click();
    await expect(page.getByRole("list", { name: "Path through the Steps" })).toContainText("Prepare");
  });

  await test.step("Mai prepares it and advances it along prepared", async () => {
    const page = maiPage.page;
    await page.goto(`${base}/tasks/${key}`);
    await expect(page.getByText("Bank statements and receipts are in the folder.")).toBeVisible();
    await page.getByRole("button", { name: "Claim" }).click();
    await page.getByRole("button", { name: "Advance · prepared" }).click();
    await page.getByRole("dialog", { name: `Advance ${key} · prepared` }).getByRole("button", { name: "Advance" }).click();
    await expect(page.getByRole("list", { name: "Path through the Steps" })).toContainText("Partner review");
    await shot(page, "2-06-mai-prepared");
  });

  await test.step("Kai, the partner, completes it along lodged", async () => {
    const page = kaiPage.page;
    await page.goto(`${base}/tasks/${key}`);
    await page.getByRole("button", { name: "Claim" }).click();
    await page.getByRole("button", { name: "Complete · lodged" }).click();
    await page.getByRole("dialog", { name: `Complete ${key} · lodged` }).getByRole("button", { name: "Complete" }).click();
    await expect(page.getByRole("heading", { level: 1 }).locator("..")).toContainText("Done");
    const path = page.getByRole("list", { name: "Path through the Steps" });
    for (const s of ["Backlog", "Gather", "gathered", "Prepare", "prepared", "Partner review", "lodged", "Done"]) await expect(path).toContainText(s);
    await shot(page, "2-07-lodged");
  });

  await test.step("no agent and no Workspace took part", async () => {
    const agents = (await ask<{ items: { kind: string }[] }>("GET", "/v1/members")).items.filter((m) => m.kind === "agent");
    const tax = (await ask<{ project: { id: string }; members: { kind: string }[] }>("GET", "/v1/projects/TAX")).members;
    expect(tax.every((m) => m.kind === "human")).toBe(true);
    expect((await ask<{ items: unknown[] }>("GET", "/v1/workspaces")).items).toEqual([]);
    // The agents of scenario 1 are SAC's, never TAX's.
    expect(agents.length).toBeGreaterThan(0);
    await kaiPage.page.goto(`${base}/projects/TAX/agents`);
    await expect(kaiPage.page.getByText("Tax has no agent Member yet.")).toBeVisible();
    await shot(kaiPage.page, "2-08-no-agents");
  });

  for (const p of [kaiPage, lanPage, maiPage]) {
    expect(p.errors).toEqual([]);
    await p.ctx.close();
  }
});
