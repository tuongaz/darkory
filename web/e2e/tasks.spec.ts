import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
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
  await expect(dialog).toContainText(`under ${held.task.key}`);
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

test("8 · the Subtasks on the line: each at its Step, a Blocking mark, the chain on selection, a ring on the worked token", async ({ browser }) => {
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
  await expect(token(b.task.key)).toContainText(`by ${a.task.key}`);
  await expect(token(c.task.key)).toHaveAttribute("aria-label", `${c.task.key} Refund email, waiting`);
  await shot(page, "8-line");
  await token(b.task.key).click();
  const callout = page.getByRole("dialog", { name: `${b.task.key} Blocking` });
  await expect(callout).toContainText(`Unblocks when ${a.task.key} ends`);
  await shot(page, "8-line-chain");
  await callout.getByRole("button", { name: new RegExp(`Open ${b.task.key}`) }).click();
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
  await expect(bob.page.getByRole("region", { name: "Aimed at you" }).locator(`[data-task="${question.key}"]`)).toContainText(`blocks ${standalone.task.key}`);
  await shot(bob.page, "5-bob-inbox");
  expect(errors).toEqual([]);
  expect(bob.errors).toEqual([]);
});
