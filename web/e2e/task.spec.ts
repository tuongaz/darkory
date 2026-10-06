import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// The Task and Feature screens' journeys (docs/build/ui-plan.md, scenarios 5, 6, 10, 11, 15),
// against the Install e2e/server.ts started. The smoke suite uses its startup login link, so this
// file signs in with a link ada's token asks /v1 for. Its records live in a Team of their own
// (TSK), seeded through /v1 with tokens; the agents are this file calling /v1 as they would.
// The tests run in order and build on each other's records.
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/task/", import.meta.url));
const base = () => process.env.DARKORY_E2E_BASE_URL!;
let signedIn: BrowserContextOptions["storageState"];

type Who = { token: string; session: string };
const as: Record<"ada" | "builder" | "reviewer", Who> = {
  ada: { token: "", session: "e2e-task-ada" },
  builder: { token: "", session: "tsk-builder-1" },
  reviewer: { token: "", session: "tsk-reviewer-1" },
};

/** Calls /v1 as a Member's token and Session, as the CLI does; a refusal throws with its code. */
async function v1<T = unknown>(who: Who, method: string, path: string, body?: unknown, raw?: { type: string; data: string }): Promise<T> {
  const r = await send(who, method, path, body, raw);
  if (r.status >= 300) throw new Error(`${method} ${path} answered ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

async function send(who: Who, method: string, path: string, body?: unknown, raw?: { type: string; data: string }) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${who.token}`,
      "Darkory-Session": who.session,
      "Idempotency-Key": randomUUID(),
      "Content-Type": raw?.type ?? "application/json",
    },
    body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

type Task = { id: string; key: string; title: string; blocked: boolean; state: string; kind: string };
type FeatureDetail = { feature: { id: string; key: string; state: string }; tasks: Task[] };

/** A page signed in as ada, collecting what the page logs as an error. */
async function open(browser: Browser): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ storageState: signedIn });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return { page, errors };
}

function shot(page: Page, name: string) {
  return page.screenshot({ path: `${shots}${name}.png`, animations: "disabled" });
}

/** The properties rail of the Task page. */
const rail = (page: Page) => page.getByRole("complementary", { name: "Properties" });

test.beforeAll(async ({ browser }) => {
  as.ada.token = process.env.DARKORY_E2E_ADMIN_TOKEN!;
  expect(as.ada.token, "e2e/server.ts exports ada's token").toMatch(/^dk_/);

  // A login link of ada's own: the startup link is the smoke suite's.
  const { url } = await v1<{ url: string }>(as.ada, "POST", "/v1/members/ada/login-links");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base()}/inbox`);
  signedIn = await ctx.storageState();
  await ctx.close();

  // A Team of this file's own, with two agents; tsk-builder reports to ada.
  await v1(as.ada, "POST", "/v1/teams", { key: "TSK", name: "Task journeys" });
  for (const who of ["builder", "reviewer"] as const) {
    const name = `tsk-${who}`;
    await v1(as.ada, "POST", "/v1/members", { name, kind: "agent" });
    as[who].token = (await v1<{ secret: string }>(as.ada, "POST", `/v1/members/${name}/tokens`, { name: "e2e" })).secret;
  }
  await v1(as.ada, "PUT", "/v1/members/tsk-builder/manager", { manager: "ada" });
  for (const m of ["ada", "tsk-builder", "tsk-reviewer"]) await v1(as.ada, "PUT", `/v1/teams/TSK/members/${m}`);
  await v1(as.ada, "POST", "/v1/skills", { name: "tsk-engineer", kind: "generic", body: "Build what the Task asks for." });
  await v1(as.ada, "POST", "/v1/skills", {
    name: "tsk-web",
    kind: "company",
    base_skill: "tsk-engineer",
    body: "1. Reuse the cart component.\n2. Ship behind a flag.\n",
  });
  const grants: [string, string][] = [
    ["tsk-builder", "tsk-engineer"],
    ["tsk-builder", "tsk-web"],
    ["tsk-reviewer", "skill-review"],
    ["ada", "breakdown"],
    ["ada", "retro"],
  ];
  for (const [m, s] of grants) await v1(as.ada, "PUT", `/v1/members/${m}/skills/${s}`);
});

// Shared between the tests, in the order they run.
let checkout: FeatureDetail;
let cart: Task;
let payment: Task;
let retro: Task;

test("15 · the peek opens from the Feature's list, and the page from the peek", async ({ browser }) => {
  checkout = await v1<FeatureDetail>(as.ada, "POST", "/v1/features", { team: "TSK", title: "Checkout flow", description: "Cart, address, payment." });
  const breakdown = checkout.tasks[0];
  await v1(as.ada, "POST", `/v1/tasks/${breakdown.key}/claim`, { heartbeat_timeout_seconds: 0 });
  cart = (await v1<{ task: Task }>(as.ada, "POST", "/v1/tasks", { feature: checkout.feature.key, title: "Build the cart page", skill: "tsk-web" })).task;
  payment = (await v1<{ task: Task }>(as.ada, "POST", "/v1/tasks", { feature: checkout.feature.key, title: "Payment form validation", skill: "tsk-web" })).task;
  await v1(as.ada, "POST", `/v1/tasks/${breakdown.key}/complete`, { note: "Two Tasks." });
  // builder works the cart page from its CLI: a Session-bound Claim, a Note, Evidence.
  await v1(as.builder, "POST", `/v1/tasks/${cart.key}/claim`, { heartbeat_timeout_seconds: 900, model_label: "claude-opus-5-5" });
  await v1(as.builder, "POST", `/v1/tasks/${cart.key}/notes`, { body: "Cart component reused; quantity stepper done." });
  await v1(as.builder, "POST", `/v1/tasks/${cart.key}/evidence?filename=e2e.log`, undefined, { type: "text/plain", data: "PASS 12 tests\n" });

  const { page, errors } = await open(browser);
  await page.goto(`${base()}/features/${checkout.feature.key}`);
  await expect(page.getByRole("heading", { name: "Checkout flow" })).toBeVisible();
  const tasks = page.getByRole("region", { name: "Tasks" });
  await expect(tasks.getByRole("link", { name: `${cart.key} Build the cart page` })).toBeVisible();
  // The Feature page merges its Tasks' Evidence and credits the Task.
  await expect(page.getByRole("region", { name: "Evidence" }).getByRole("link", { name: "e2e.log" })).toBeVisible();
  await shot(page, "feature");

  await tasks.getByRole("link", { name: `${cart.key} Build the cart page` }).click();
  const peek = page.getByRole("dialog", { name: `Task ${cart.key}` });
  await expect(peek).toBeVisible();
  await expect(peek.getByText("claude-opus-5-5", { exact: true })).toBeVisible();
  await expect(peek.getByText("Only tsk-builder can add a Note")).toBeVisible();
  await expect(peek.getByRole("article", { name: "Note by tsk-builder" })).toContainText("quantity stepper done");
  await shot(page, "peek");

  await peek.getByRole("link", { name: "Open page" }).click();
  await expect(page).toHaveURL(`${base()}/tasks/${cart.key}`);
  await expect(page.getByRole("heading", { name: "Build the cart page", level: 1 })).toBeVisible();
  await expect(rail(page).getByText("tsk-builder", { exact: true })).toBeVisible();
  await shot(page, "page");
  expect(errors).toEqual([]);
});

test("5 · Ship is refused with the open Tasks named, then ships once they end, and the Retrospective appears", async ({ browser }) => {
  const { page, errors } = await open(browser);
  await page.goto(`${base()}/features/${checkout.feature.key}`);
  await page.getByRole("button", { name: "Ship", exact: true }).click();
  const toast = page.getByRole("listitem").filter({ hasText: "Not shipped: 2 Tasks open" });
  await expect(toast).toBeVisible();
  for (const t of [cart, payment]) await expect(toast.getByRole("link", { name: t.key })).toBeVisible();
  await expect(toast).toContainText("Each must be Done or Dropped");
  await shot(page, "ship-refused");

  // The toast's keys open the peek; the owner drops the payment form from it.
  await toast.getByRole("link", { name: payment.key }).click();
  const peek = page.getByRole("dialog", { name: `Task ${payment.key}` });
  await expect(peek).toBeVisible();
  await peek.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Drop Task" }).click();
  const drop = page.getByRole("dialog", { name: `Drop ${payment.key}?` });
  await drop.getByRole("textbox", { name: "Reason" }).fill("Covered by the provider's form.");
  await drop.getByRole("button", { name: "Drop Task", exact: true }).click();
  await expect(drop).toHaveCount(0);
  await peek.getByRole("button", { name: "Close" }).click();

  // builder finishes the cart page.
  await v1(as.builder, "POST", `/v1/tasks/${cart.key}/complete`, { note: "Done; e2e green." });
  await expect(page.getByRole("region", { name: "Tasks" }).getByRole("img", { name: "Done" })).toHaveCount(2);

  await page.getByRole("button", { name: "Ship", exact: true }).click();
  await expect(page.getByText("Shipped", { exact: true }).first()).toBeVisible();
  const tasks = page.getByRole("region", { name: "Tasks" });
  await expect(tasks.getByRole("link", { name: /Retrospective: Checkout flow/ })).toBeVisible();
  // An ended Feature offers its owner no Ship.
  await expect(page.getByRole("button", { name: "Ship", exact: true })).toHaveCount(0);
  await shot(page, "shipped");

  const shipped = await v1<FeatureDetail>(as.ada, "GET", `/v1/features/${checkout.feature.key}`);
  expect(shipped.feature.state).toBe("shipped");
  retro = shipped.tasks.find((t) => t.kind === "retrospective")!;
  // The only error is the browser's report of the refused Ship.
  expect(errors.filter((e) => !e.includes("status of 409"))).toEqual([]);
});

test("11 · a proposal written on the Retrospective and reviewed shows as version 2", async ({ browser }) => {
  const { page, errors } = await open(browser);
  await page.goto(`${base()}/tasks/${retro.key}`);
  await expect(page.getByRole("heading", { name: "Retrospective: Checkout flow", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByRole("button", { name: "Complete" })).toBeVisible();

  // Propose: the current text comes prefilled; add a line.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Propose a Skill version" }).click();
  const propose = page.getByRole("dialog", { name: "Propose a Skill version" });
  await propose.getByRole("combobox", { name: "Skill" }).click();
  await page.getByRole("option", { name: "tsk-web" }).click();
  const text = propose.getByRole("textbox", { name: "Text" });
  await expect(text).toHaveValue(/Reuse the cart component/);
  await text.fill(`${await text.inputValue()}3. Point e2e at Mailpit when the change sends email.\n`);
  await propose.getByRole("button", { name: "Propose", exact: true }).click();
  await expect(propose).toHaveCount(0);

  const card = page.getByRole("region", { name: "Proposal" });
  await expect(card).toContainText("tsk-web version 2");
  await expect(card).toContainText("Pending review");
  await expect(card.getByLabel("Changes").locator("[data-op=add]")).toHaveText("+ 3. Point e2e at Mailpit when the change sends email.");

  // Hand over to skill-review, moving it to In review.
  await page.getByRole("button", { name: "More ways to end the Claim" }).click();
  await page.getByRole("menuitem", { name: "Hand over" }).click();
  const handover = page.getByRole("dialog", { name: `Hand over ${retro.key}` });
  await handover.getByRole("combobox", { name: "Skill it needs next" }).click();
  await page.getByRole("option", { name: "skill-review" }).click();
  await expect(handover.getByText(/^Takeable by .*tsk-reviewer/)).toBeVisible();
  await handover.getByRole("combobox", { name: "Status after hand over" }).click();
  await page.getByRole("option", { name: "In review" }).click();
  await shot(page, "hand-over");
  await handover.getByRole("button", { name: "Hand over", exact: true }).click();
  await expect(handover).toHaveCount(0);
  await expect(rail(page).getByText("In review")).toBeVisible();
  await expect(card).toContainText("Completing this review publishes version 2");

  // The reviewer agent takes the review and completes it, which publishes the version.
  await v1(as.reviewer, "POST", `/v1/tasks/${retro.key}/claim`, { heartbeat_timeout_seconds: 900 });
  await v1(as.reviewer, "POST", `/v1/tasks/${retro.key}/complete`, {});
  await expect(card).toContainText("Published");
  await expect(card).toContainText("tsk-web version 2");
  const skill = await v1<{ skill: { current_version: number } }>(as.ada, "GET", "/v1/skills/tsk-web");
  expect(skill.skill.current_version).toBe(2);
  await shot(page, "published");
  expect(errors).toEqual([]);
});

test("6 · Take back while a bot heartbeats: its next Heartbeat answers taken_back and the Task returns to Todo", async ({ browser }) => {
  const search = await v1<FeatureDetail>(as.ada, "POST", "/v1/features", { team: "TSK", title: "Search" });
  const index = (await v1<{ task: Task }>(as.ada, "POST", "/v1/tasks", { feature: search.feature.key, title: "Index products", skill: "tsk-engineer" })).task;
  const bot: Who = { ...as.builder, session: "tsk-builder-heartbeat" };
  await v1(bot, "POST", `/v1/tasks/${index.key}/claim`, { heartbeat_timeout_seconds: 900, model_label: "claude-sonnet-5-5" });
  const replies: string[] = [];
  const beat = setInterval(() => {
    void send(bot, "POST", `/v1/tasks/${index.key}/heartbeat`).then((r) => replies.push(r.body?.status ?? r.body?.code));
  }, 300);
  try {
    await expect.poll(() => replies.length).toBeGreaterThan(0);
    expect(replies.every((s) => s === "ok")).toBe(true);

    const { page, errors } = await open(browser);
    await page.goto(`${base()}/tasks/${index.key}`);
    await expect(rail(page).getByText("In progress")).toBeVisible();
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Take back" }).click();
    const dialog = page.getByRole("dialog", { name: `Take back ${index.key}?` });
    await expect(dialog).toContainText("tsk-builder's Claim ends now");
    await expect(dialog).toContainText("Status → Todo");
    await expect(dialog).toContainText("Its next Heartbeat answers taken back");
    await shot(page, "take-back");
    await dialog.getByRole("textbox", { name: "Reason" }).fill("Stuck for an hour.");
    await dialog.getByRole("button", { name: "Take back", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(() => replies.at(-1), { timeout: 10_000 }).toBe("taken_back");
    await expect(rail(page).getByText("Todo", { exact: true })).toBeVisible();
    await expect(rail(page).getByText("Nobody", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Activity" })).toContainText("tsk-builder's Claim was taken back");
    await shot(page, "taken-back");
    expect(errors).toEqual([]);
  } finally {
    clearInterval(beat);
  }
});

test("10 · answering a question aimed at me — Claim, Note, Complete — unblocks the asker's Task", async ({ browser }) => {
  const search = (await v1<{ items: { key: string; title: string }[] }>(as.ada, "GET", "/v1/features?team=TSK")).items.find((f) => f.title === "Search")!;
  const box = (await v1<{ task: Task }>(as.ada, "POST", "/v1/tasks", { feature: search.key, title: "Wire the search box", skill: "tsk-engineer" })).task;
  await v1(as.builder, "POST", `/v1/tasks/${box.key}/claim`, { heartbeat_timeout_seconds: 900 });
  const question = (await v1<{ task: Task }>(as.builder, "POST", "/v1/tasks", { title: "Which index do we query?", aimed_at: "ada", blocks: box.key })).task;
  expect((await v1<{ task: Task }>(as.ada, "GET", `/v1/tasks/${box.key}`)).task.blocked).toBe(true);

  const { page, errors } = await open(browser);
  await page.goto(`${base()}/tasks/${box.key}`);
  await expect(rail(page).getByRole("link", { name: new RegExp(question.key) })).toBeVisible();

  await page.goto(`${base()}/tasks/${question.key}`);
  await expect(rail(page)).toContainText("aimed at");
  // Nobody holds it, so there is no composer and no rule about it.
  await expect(page.getByRole("textbox", { name: "Note" })).toHaveCount(0);
  await page.getByRole("button", { name: "Claim", exact: true }).click();

  const note = page.getByRole("textbox", { name: "Note" });
  await note.fill("Query the products_v2 index; the old one is going away.");
  await page.getByRole("button", { name: "Add Note" }).click();
  await expect(page.getByRole("article", { name: "Note by ada" })).toContainText("products_v2");
  await expect(note).toHaveValue("");
  await shot(page, "question-held");

  await page.getByRole("button", { name: "Complete" }).click();
  const complete = page.getByRole("dialog", { name: `Complete ${question.key}` });
  await complete.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(complete).toHaveCount(0);
  await expect(rail(page).getByText("Done", { exact: true })).toBeVisible();

  expect((await v1<{ task: Task }>(as.ada, "GET", `/v1/tasks/${box.key}`)).task.blocked).toBe(false);
  await page.goto(`${base()}/tasks/${box.key}`);
  await expect(page.getByRole("heading", { name: "Wire the search box", level: 1 })).toBeVisible();
  await expect(rail(page).getByText("Blocked by")).toHaveCount(0);
  await shot(page, "unblocked");
  expect(errors).toEqual([]);
});
