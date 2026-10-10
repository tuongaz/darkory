import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The Tasks screens' journeys on model v2 (docs/build/model-v2-plan.md, Scenarios 3, 4, 7, 8),
// against the Install e2e/server.ts started. Its records live in a Project of their own (TSK) on
// the default Workflow, seeded through /v1 with tokens; the agent is this file calling /v1 as it
// would. The tests run in order and build on each other's records.
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/tasks-e2e/", import.meta.url));
const base = () => process.env.DARKORY_E2E_BASE_URL!;
let signedIn: BrowserContextOptions["storageState"];

type Who = { token: string; session: string };
const as: Record<"ada" | "builder" | "bob", Who> = {
  ada: { token: "", session: "e2e-tasks-ada" },
  builder: { token: "", session: "tsk-builder-1" },
  bob: { token: "", session: "tsk-bob-1" },
};

type Task = { id: string; key: string; title: string; state: string; step_id?: string; parent_id?: string; subtask_counts?: { open: number } };
type Detail = { task: Task; subtasks: Task[]; claims: { how_ended?: string }[] };
type Step = { id: string; name: string };

/** Calls /v1 as a Member's token and Session, as the CLI does; a refusal throws with its code. */
async function v1<T = unknown>(who: Who, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "Darkory-Session": who.session, "Idempotency-Key": randomUUID(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A page signed in as ada (or another storage state), collecting what the page logs as an error. */
async function open(browser: Browser, state = signedIn): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, errors };
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${shots}${name}.png`, animations: "disabled" });

let steps: Step[] = [];
const stepId = (name: string) => steps.find((s) => s.name === name)!.id;
let bobState: BrowserContextOptions["storageState"];

async function signIn(browser: Browser, member: string): Promise<BrowserContextOptions["storageState"]> {
  const { url } = await v1<{ url: string }>(as.ada, "POST", `/v1/members/${member}/login-links`);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base()}/inbox`);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

test.beforeAll(async ({ browser }) => {
  as.ada.token = process.env.DARKORY_E2E_ADMIN_TOKEN!;
  expect(as.ada.token, "e2e/server.ts exports ada's token").toMatch(/^dk_/);
  await v1(as.ada, "POST", "/v1/members", { name: "tsk-builder", kind: "agent" });
  await v1(as.ada, "POST", "/v1/members", { name: "tsk-bob", kind: "human" });
  for (const [who, name] of [["builder", "tsk-builder"], ["bob", "tsk-bob"]] as const) {
    as[who].token = (await v1<{ secret: string }>(as.ada, "POST", `/v1/members/${name}/tokens`, { name: "e2e" })).secret;
  }
  // ada directs the builder; bob is a Member of the Project with no authority over its Claims.
  await v1(as.ada, "PUT", "/v1/members/tsk-builder/manager", { manager: "ada" });
  await v1(as.ada, "PUT", "/v1/members/tsk-builder/skills/engineer");
  await v1(as.ada, "POST", "/v1/projects", { key: "TSK", name: "Task journeys", members: ["ada", "tsk-builder", "tsk-bob"] });
  steps = (await v1<{ steps: Step[] }>(as.ada, "GET", "/v1/projects/TSK/workflow")).steps;
  signedIn = await signIn(browser, "ada");
  bobState = await signIn(browser, "tsk-bob");
});

test("3 · a standalone Task filed at Build is worked and completed by advancing into Done", async ({ browser }) => {
  const { page, errors } = await open(browser);
  await page.goto(`${base()}/projects/TSK/tasks`);
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "File a Task" });
  await expect(dialog.getByRole("combobox", { name: "Step" })).toContainText("Build");
  await dialog.getByLabel("Title").fill("Support emoji in names");
  await dialog.getByRole("button", { name: "File Task" }).click();
  await expect(page.getByRole("link", { name: /Support emoji in names/ })).toBeVisible();

  const [filed] = (await v1<{ items: Task[] }>(as.ada, "GET", "/v1/tasks?project=TSK")).items.filter((t) => t.title === "Support emoji in names");
  expect(filed.step_id).toBe(stepId("Build"));
  await v1(as.builder, "POST", `/v1/tasks/${filed.id}/claim`, {});
  await v1(as.builder, "POST", `/v1/tasks/${filed.id}/advance`, { outcome: "pass", note: "Done in the name field" });
  // At Review: nobody in TSK has review, so its Owner, ada, may take it, and completes it.
  await page.goto(`${base()}/tasks/${filed.key}`);
  await expect(page.getByRole("list", { name: "Path through the Steps" })).toContainText("Review");
  await page.getByRole("button", { name: "Claim" }).click();
  await page.getByRole("button", { name: "Complete · pass" }).click();
  await page.getByRole("dialog", { name: `Complete ${filed.key} · pass` }).getByRole("button", { name: "Complete" }).click();
  await expect(page.getByRole("heading", { level: 1 }).locator("..")).toContainText("Done");
  await shot(page, "3-completed");
  expect(errors).toEqual([]);
});

test("4 · the holder splits a held Task: the Claim ends split, it becomes a Parent, its Subtasks start at Build", async ({ browser }) => {
  const held = await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "TSK", title: "Checkout with saved cards" });
  await v1(as.builder, "POST", `/v1/tasks/${held.task.id}/claim`, {});
  // The builder's split, as the agent files it; the page then shows it.
  await v1(as.builder, "POST", "/v1/tasks", { parent: held.task.key, title: "Card vault client", note: "Two parts" });
  const { page, errors } = await open(browser);
  await page.goto(`${base()}/tasks/${held.task.key}?view=list`);
  await expect(page.getByText("split it into Subtasks; their Claim ended")).toBeVisible();
  const subtasks = page.getByRole("region", { name: "Subtasks" });
  await expect(subtasks.getByRole("link", { name: /Card vault client/ })).toContainText("Build");
  // A Member files the second from the page.
  await subtasks.getByRole("button", { name: "Add Subtask" }).click();
  const dialog = page.getByRole("dialog", { name: "File a Task" });
  await expect(dialog.getByRole("combobox", { name: "Parent" })).toContainText(held.task.key);
  await dialog.getByLabel("Title").fill("Saved cards list");
  await dialog.getByRole("button", { name: "File Task" }).click();
  await expect(subtasks.getByRole("link", { name: /Saved cards list/ })).toBeVisible();
  const detail = await v1<Detail>(as.ada, "GET", `/v1/tasks/${held.task.key}`);
  expect(detail.claims.at(-1)?.how_ended).toBe("split");
  expect(detail.subtasks.every((s) => s.step_id === stepId("Build"))).toBe(true);
  await shot(page, "4-split");
  expect(errors).toEqual([]);
});

test("7 · the board: drag between Steps; a held card is refused for bob and moved by its Owner, ending the Claim", async ({ browser }) => {
  const free = await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "TSK", title: "Order history export", step: stepId("Backlog") });
  const held = await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "TSK", title: "Gift wrapping" });
  await v1(as.builder, "POST", `/v1/tasks/${held.task.id}/claim`, {});
  const drag = async (page: Page, key: string, column: string) => {
    const card = page.locator(`[data-task="${key}"]`);
    const to = page.getByRole("region", { name: column, exact: true });
    const a = (await card.boundingBox())!;
    const b = (await to.boundingBox())!;
    await page.mouse.move(a.x + 20, a.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + 60, { steps: 12 });
    await page.mouse.up();
  };

  const owner = await open(browser);
  await owner.page.goto(`${base()}/projects/TSK/tasks?view=board`);
  await drag(owner.page, free.task.key, "Build");
  await expect(owner.page.getByRole("region", { name: "Build", exact: true }).locator(`[data-task="${free.task.key}"]`)).toBeVisible();

  const other = await open(browser, bobState);
  await other.page.goto(`${base()}/projects/TSK/tasks?view=board`);
  await drag(other.page, held.task.key, "Review");
  await expect(other.page.getByText(`tsk-builder holds ${held.task.key}: only the Owner, ada, or someone above tsk-builder moves it.`)).toBeVisible();
  await expect(other.page.locator(".card-overlay *")).toHaveCount(0);
  await shot(other.page, "7-refused");

  await drag(owner.page, held.task.key, "Review");
  await expect(owner.page.getByText("tsk-builder's Claim on it ended.")).toBeVisible();
  await expect(owner.page.locator(".card-overlay *")).toHaveCount(0);
  await shot(owner.page, "7-moved");
  const after = await v1<Detail>(as.ada, "GET", `/v1/tasks/${held.task.key}`);
  expect(after.task.step_id).toBe(stepId("Review"));
  expect(owner.errors).toEqual([]);
  expect(other.errors).toEqual([]);
});

test("8 · the Subtasks on the line: held ones as chips, waiting ones in their Step's list, a Blocking mark, the way on selection, a ring on the worked token", async ({ browser }) => {
  const parent = await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "TSK", title: "Refunds" });
  const a = await v1<Detail>(as.ada, "POST", "/v1/tasks", { parent: parent.task.key, title: "Refund API" });
  const b = await v1<Detail>(as.ada, "POST", "/v1/tasks", { parent: parent.task.key, title: "Refund button" });
  const c = await v1<Detail>(as.ada, "POST", "/v1/tasks", { parent: parent.task.key, title: "Refund email", step: stepId("Review") });
  await v1(as.ada, "PUT", `/v1/tasks/${b.task.id}/blockers/${a.task.id}`);
  await v1(as.builder, "POST", `/v1/tasks/${a.task.id}/claim`, {});
  const { page, errors } = await open(browser);
  await page.goto(`${base()}/tasks/${parent.task.key}`);
  const line = page.getByRole("region", { name: "Subtask line" });
  await expect(line.locator('[data-head="Build"]')).toBeVisible();
  await expect(line.locator('[data-head="Review"]')).toBeVisible();
  const token = (key: string) => line.locator(`button[data-task="${key}"]`);
  await expect(token(a.task.key)).toHaveAttribute("aria-label", `${a.task.key} Refund API, held by tsk-builder (agent)`);
  await expect(token(a.task.key).getByRole("img", { name: /tsk-builder \(agent\), working/ })).toBeVisible();
  // The waiting Subtasks are their Step's count, which opens the Step's list in place.
  await line.getByRole("button", { name: "Review: 1 Task waiting" }).click();
  await expect(token(c.task.key)).toHaveAttribute("aria-label", `${c.task.key} Refund email, waiting`);
  await line.getByRole("button", { name: "Build: 1 Task waiting" }).click();
  await expect(token(b.task.key)).toContainText(`by ${a.task.key}`);
  await shot(page, "8-line");
  // Picked from the list, its way stands over the line: what it waits on, and its key opens it.
  await token(b.task.key).click();
  const way = page.getByRole("region", { name: `${b.task.key}'s way` });
  await expect(way).toContainText(`Unblocks when ${a.task.key} ends`);
  await shot(page, "8-line-chain");
  await way.getByRole("button", { name: `Open ${b.task.key}` }).click();
  await expect(page.getByRole("dialog", { name: `Task ${b.task.key}` })).toBeVisible();
  await shot(page, "8-line-peek");
  expect(errors).toEqual([]);
});

test("5 · a question from a standalone Task stands alone in the Project and blocks it", async ({ browser }) => {
  const standalone = await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "TSK", title: "Price rounding" });
  const { page, errors } = await open(browser);
  await page.goto(`${base()}/tasks/${standalone.task.key}`);
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Ask a question" }).click();
  const dialog = page.getByRole("dialog", { name: "File a Task" });
  await expect(dialog.getByRole("combobox", { name: "Blocks" })).toContainText(standalone.task.key);
  await dialog.getByRole("combobox", { name: "Aim at" }).click();
  await page.getByRole("option", { name: "tsk-bob" }).click();
  await dialog.getByLabel("Title").fill("Round half up or to even?");
  await shot(page, "5-ask");
  await dialog.getByRole("button", { name: "File Task" }).click();
  await expect(dialog).toHaveCount(0);

  const question = (await v1<{ items: Task[] }>(as.ada, "GET", "/v1/tasks?project=TSK")).items.find((t) => t.title === "Round half up or to even?")!;
  // Beside nothing: no Parent, and at no Step, with bob.
  expect(question.parent_id).toBeUndefined();
  expect(question.step_id).toBeUndefined();
  const properties = page.getByRole("complementary", { name: "Properties" });
  await expect(properties).toContainText("Blocked by");
  await expect(properties).toContainText(question.key);
  await shot(page, "5-blocked");
  // bob sees it aimed at him.
  const bob = await open(browser, bobState);
  await bob.page.goto(`${base()}/inbox`);
  await expect(bob.page.getByRole("region", { name: "Needs you" }).locator(`[data-task="${question.key}"]`)).toContainText(`unblocks ${standalone.task.key}`);
  await shot(bob.page, "5-bob-inbox");
  expect(errors).toEqual([]);
  expect(bob.errors).toEqual([]);
});

test("the Claim's Session id reads on one line in the rail at 1440, its 22 characters whole", async ({ browser }) => {
  const filed = await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "TSK", title: "Session id on one line" });
  // A Session id the copy chose as a UUID: the API names it by its 22-character short form.
  await v1({ ...as.builder, session: randomUUID() }, "POST", `/v1/tasks/${filed.task.id}/claim`, { heartbeat_timeout_seconds: 0 });
  const { page, errors } = await open(browser);
  await page.goto(`${base()}/tasks/${filed.task.key}`);
  const claim = page.getByRole("complementary", { name: "Properties" }).getByRole("region", { name: "Claim" });
  const id = claim.getByText(/^[1-9A-HJ-NP-Za-km-z]{22}$/);
  await expect(id).toBeVisible();
  const fit = await id.evaluate((el) => {
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    return { lines: Math.round(el.getBoundingClientRect().height / lineHeight), cut: el.scrollWidth > el.clientWidth };
  });
  expect(fit).toEqual({ lines: 1, cut: false });
  await shot(page, "session-id-one-line");
  expect(errors).toEqual([]);
});

test("a Done Task's pull request reads on its facts line and in its rail, a link to GitHub; with no Runner there is no Merge", async ({ browser }) => {
  // TSK lands its branches through pull requests from here on: its default Workspace is in pull_request mode.
  await v1(as.ada, "POST", "/v1/workspaces", { name: "tsk-repo", path: "/srv/tsk", mode: "pull_request", default_branch: "main" });
  await v1(as.ada, "PATCH", "/v1/projects/TSK", { default_workspace: "tsk-repo" });
  const filed = await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "TSK", title: "A sidebar trigger on desktop" });
  await v1(as.builder, "POST", `/v1/tasks/${filed.task.id}/claim`, {});
  await v1(as.builder, "POST", `/v1/tasks/${filed.task.id}/advance`, { outcome: "pass" });
  await v1(as.ada, "POST", `/v1/tasks/${filed.task.id}/claim`, {});
  await v1(as.ada, "POST", `/v1/tasks/${filed.task.id}/advance`, { outcome: "pass" });
  const url = "https://github.com/o/r/pull/7";
  await v1(as.ada, "PUT", `/v1/tasks/${filed.task.id}/pull-request`, { number: 7, url, state: "open" });

  const { page, errors } = await open(browser);
  await page.goto(`${base()}/tasks/${filed.task.key}`);
  const head = page.getByRole("heading", { level: 1 }).locator("xpath=ancestor::header[1]");
  await expect(head).toContainText("Done");
  await expect(head.getByRole("link", { name: "#7 open" })).toHaveAttribute("href", url);
  const workspace = page.getByRole("complementary", { name: "Properties" }).getByRole("region", { name: "Workspace" });
  await expect(workspace).toContainText("Pull request");
  await expect(workspace.getByRole("link", { name: "#7 open" })).toHaveAttribute("href", url);
  await expect(page.getByRole("button", { name: "Merge" })).toHaveCount(0);
  await shot(page, "pull-request-open");

  await v1(as.ada, "PUT", `/v1/tasks/${filed.task.id}/pull-request`, { number: 7, url, state: "merged" });
  await page.reload();
  await expect(head.getByRole("link", { name: "#7 merged" })).toHaveAttribute("href", url);
  await shot(page, "pull-request-merged");
  expect(errors).toEqual([]);
});

/** Runs the `darkory` CLI e2e/server.ts built, as a Member's token in their Session. */
function darkory(who: Who, ...args: string[]): string {
  return execFileSync(process.env.DARKORY_E2E_BIN!, args, {
    env: { ...process.env, DARKORY_URL: base(), DARKORY_TOKEN: who.token, DARKORY_SESSION: who.session, DARKORY_NO_UPDATE_CHECK: "1" },
    stdio: "pipe",
  }).toString();
}

test("Evidence shows itself: the holder's screenshots fold into one row of thumbnails; the Shift's log is a chip on the release, not Evidence", async ({ browser }) => {
  const filed = await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "TSK", title: "Evidence shows itself" });
  const key = filed.task.key;
  await v1(as.builder, "POST", `/v1/tasks/${filed.task.id}/claim`, { heartbeat_timeout_seconds: 900 });
  const dir = mkdtempSync(join(tmpdir(), "darkory-e2e-evidence-"));
  try {
    // Two real screenshots of a page, and the Shift's terminal log.
    const { page: shooter } = await open(browser);
    await shooter.setContent("<h1 style='font:40px sans-serif'>Delete Workflow 3</h1><p>The Steps of Workflow 3 go with it.</p>");
    for (const name of ["03-workflow-page.png", "07-delete-dialog.png"]) await shooter.screenshot({ path: join(dir, name) });
    await shooter.context().close();
    darkory(as.builder, "attach", key, join(dir, "03-workflow-page.png"));
    darkory(as.builder, "attach", key, join(dir, "07-delete-dialog.png"));
    writeFileSync(join(dir, "triage-log.md"), "# Triage log, the delete\n\n| Where | Width | Delete |\n");
    darkory(as.builder, "attach", key, join(dir, "triage-log.md"));
    await v1(as.builder, "POST", `/v1/tasks/${filed.task.id}/release`, {});
    // The Runner attaches the Shift's log once the Session has exited, naming the Claim it ran under.
    const claimId = (await v1<{ claims: { id: string }[] }>(as.ada, "GET", `/v1/tasks/${key}`)).claims.at(-1)!.id;
    const filename = `shift-${key}-tsk-builder-101600.log`;
    const res = await fetch(`${base()}/v1/tasks/${key}/evidence?${new URLSearchParams({ filename, kind: "log", claim: claimId })}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${as.builder.token}`, "Darkory-Session": `${as.builder.session}-runner`, "Idempotency-Key": randomUUID(), "Content-Type": "text/plain" },
      body: "$ make web-check\n".repeat(400),
    });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(((await res.json()) as { claim_id?: string }).claim_id).toBe(claimId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const { page, errors } = await open(browser);
  await page.goto(`${base()}/tasks/${key}`);
  const record = page.getByRole("list", { name: "Record" });
  const attached = record.getByRole("listitem").filter({ hasText: "tsk-builder attached 3 Evidence" });
  await expect(attached).toBeVisible();
  // A small text file's first lines, read through the page's own fetch (its cookie, the CSP).
  const box = attached.getByRole("figure", { name: "triage-log.md" });
  await expect(box.locator("pre")).toContainText("# Triage log, the delete");
  await expect(box.getByRole("link", { name: "open ↗" })).toHaveAttribute("href", /\/v1\/evidence\/.+\/content$/);
  // Each image a thumbnail that loads, though its download is an attachment.
  for (const name of ["03-workflow-page.png", "07-delete-dialog.png"]) {
    const img = attached.getByRole("img", { name });
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
    expect(await img.evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([148, 92]);
    await expect(attached.getByRole("link", { name: new RegExp(name.replace(".", "\\.")) })).toHaveAttribute("href", /\/v1\/evidence\/.+\/content$/);
  }
  // The log rides on the release as a chip; no row says it was attached.
  const released = record.getByRole("listitem").filter({ hasText: "tsk-builder released it" });
  await expect(released.getByRole("link", { name: /^Shift log · / })).toBeVisible();
  await expect(record.getByText(`shift-${key}-tsk-builder-101600.log`)).toHaveCount(0);
  await expect(record.getByRole("listitem").filter({ hasText: /attached/ })).toHaveCount(1);
  await shot(page, "evidence-thumbnails");
  expect(errors).toEqual([]);
});
