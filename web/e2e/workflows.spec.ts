import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall } from "./server";

// Named Workflows (ADR 0019; docs/build/named-workflows-plan.md, Task 17) against the real binary,
// on an Install of its own: Project ACC with ADR 0019's five Workflows, seeded through /v1 in one
// PUT of its whole graph. The board and the Workflow page show one Workflow at a time, picked by
// the chip; a Task advanced along a crossing outcome leaves one board for another without a
// reload; the line shows exits and entries; the editor adds and deletes a Workflow.
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/workflows/", import.meta.url));

type Who = { token: string; session: string };
type Task = { id: string; key: string; title: string; state: string; step_id?: string; workflow_id?: string };
type Detail = { task: Task };
type Graph = { workflows: { id: string; name: string; position: number }[]; steps: { id: string; name: string; workflow_id: string }[] };

let stop: (() => Promise<void>) | undefined;
let base = "";
let signedIn: Awaited<ReturnType<BrowserContext["storageState"]>>;
// ada triages; cleo fixes (engineer, twice), bob reviews and dan verifies: whoever has held a Task
// under one Skill takes it again only under that Skill, so the path needs one Member per Skill.
const as: Record<"ada" | "cleo" | "bob" | "dan", Who> = {
  ada: { token: "", session: "e2e-workflows-ada" },
  cleo: { token: "", session: "e2e-workflows-cleo" },
  bob: { token: "", session: "e2e-workflows-bob" },
  dan: { token: "", session: "e2e-workflows-dan" },
};
let graph: Graph;
const wf = (name: string) => graph.workflows.find((w) => w.name === name)!.id;
const stepOf = (name: string) => graph.steps.find((s) => s.name === name)!.id;

/** A /v1 call as a Member's token and Session; a refusal throws with its body. */
async function v1<T = unknown>(who: Who, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${who.token}`,
      "Darkory-Session": who.session,
      "Idempotency-Key": crypto.randomUUID(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** ADR 0019's five Workflows of ACC, in one body: Triage leads into each of the others. */
function fiveWorkflows() {
  const workflows = ["Triage", "Bugs", "Features", "Prototypes", "Support"].map((name) => ({ name }));
  const steps: { workflow: string; name: string; skill?: string }[] = [
    { workflow: "Triage", name: "Triage", skill: "triage" },
    { workflow: "Bugs", name: "Investigate", skill: "engineer" },
    { workflow: "Bugs", name: "Fix", skill: "engineer" },
    { workflow: "Bugs", name: "Review", skill: "review" },
    { workflow: "Bugs", name: "Verify", skill: "qa" },
    { workflow: "Features", name: "Build", skill: "engineer" },
    { workflow: "Features", name: "Code review", skill: "review" },
    { workflow: "Features", name: "QA", skill: "qa" },
    { workflow: "Features", name: "Release", skill: "devops" },
    { workflow: "Prototypes", name: "Sketch", skill: "design" },
    { workflow: "Prototypes", name: "Prototype review", skill: "review" },
    { workflow: "Support", name: "Support", skill: "support" },
    { workflow: "Support", name: "Awaiting customer" },
    { workflow: "Support", name: "Ops", skill: "ops" },
    { workflow: "Support", name: "Approve", skill: "finance" },
  ];
  const outs: [from: string, name: string, to?: string][] = [
    ["Triage", "bug", "Investigate"],
    ["Triage", "feature", "Build"],
    ["Triage", "prototype", "Sketch"],
    ["Triage", "question", "Support"],
    ["Investigate", "fix", "Fix"],
    ["Fix", "ready", "Review"],
    ["Review", "pass", "Verify"],
    ["Review", "needs changes", "Fix"],
    ["Verify", "pass"],
    ["Verify", "fail", "Fix"],
    ["Build", "ready for review", "Code review"],
    ["Code review", "pass", "QA"],
    ["Code review", "needs changes", "Build"],
    ["QA", "pass", "Release"],
    ["QA", "fail", "Build"],
    ["Release", "released"],
    ["Sketch", "ready", "Prototype review"],
    ["Prototype review", "approved"],
    ["Prototype review", "redesign", "Sketch"],
    ["Support", "answered"],
    ["Support", "waiting on the customer", "Awaiting customer"],
    ["Support", "account change", "Ops"],
    ["Support", "exception", "Approve"],
    ["Ops", "done", "Support"],
    ["Approve", "approved", "Ops"],
    ["Approve", "declined", "Support"],
  ];
  const connectors = outs.map(([from, name, to]) => ({ from, name, ...(to ? { to } : {}) }));
  const created = ["triage", "qa", "devops", "design", "support", "ops", "finance"];
  const skills = created.map((name) => ({ name, body: `The ${name} work of ACC.` }));
  const every = [...created, "engineer", "review"];
  const grants = [
    ...every.map((skill) => ({ member: "ada", skill })),
    { member: "cleo", skill: "engineer" },
    { member: "bob", skill: "review" },
    { member: "dan", skill: "qa" },
  ];
  // The Workflow ACC started with, Work, is left out: deleted, its empty Backlog with it.
  return { workflows, steps, connectors, skills, joins: ["ada", "cleo", "bob", "dan"], grants };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const install = await startInstall();
  ({ stop, base } = install);
  as.ada.token = install.token;
  for (const name of ["cleo", "bob", "dan"] as const) {
    await v1(as.ada, "POST", "/v1/members", { name, kind: "human" });
    as[name].token = (await v1<{ secret: string }>(as.ada, "POST", `/v1/members/${name}/tokens`, { name: "e2e" })).secret;
  }
  await v1(as.ada, "POST", "/v1/projects", { key: "ACC", name: "Accounts", workflow: "empty", members: ["ada"] });
  graph = await v1<Graph>(as.ada, "PUT", "/v1/projects/ACC/workflow", fiveWorkflows());
  expect(graph.workflows.map((w) => w.name)).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);

  const { url } = await v1<{ url: string }>(as.ada, "POST", "/v1/members/ada/login-links");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: /^Sign in as / }).click();
  await expect(page).toHaveURL(`${base}/inbox`);
  signedIn = await ctx.storageState();
  await ctx.close();
});

test.afterAll(async () => {
  await stop?.();
});

/** A page signed in as ada at `path`, collecting what it logs as an error. */
async function open(browser: Browser, path: string, size = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ storageState: signedIn, viewport: size });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}${path}`);
  return { ctx, page, errors };
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${shots}${name}.png`, animations: "disabled" });
const board = (workflow?: string) => `/projects/ACC/tasks?view=board${workflow ? `&workflow=${workflow}` : ""}`;
const chip = (page: Page) => page.getByRole("button", { name: /^Workflow: / });
/** The board's columns, by name, in order. */
const columns = (page: Page) => page.getByRole("main").getByRole("region");
const columnNames = (page: Page) => columns(page).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
const card = (page: Page, key: string) => page.getByRole("main").locator(`[data-task="${key}"]`);
/** The group labels of the open listbox, in order. */
const groupsOfListbox = (page: Page) =>
  page
    .getByRole("listbox")
    .getByRole("group")
    .evaluateAll((els) => els.map((g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent ?? ""));

let filed: Task;

test("1 · the board opens on Triage, its one Step; the chip lists the five", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, board());
  await expect(chip(page)).toHaveText("Triage");
  await expect.poll(() => columnNames(page)).toEqual(["Triage", "Done", "Dropped"]);
  await shot(page, "board-triage");
  await chip(page).click();
  await expect(page.getByRole("option")).toHaveText(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
  await shot(page, "chip-open");
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("2 · each Workflow's board holds its own Steps", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, board(wf("Bugs")));
  await expect(chip(page)).toHaveText("Bugs");
  await expect.poll(() => columnNames(page)).toEqual(["Investigate", "Fix", "Review", "Verify", "Done", "Dropped"]);
  await shot(page, "board-bugs");
  await page.goto(`${base}${board(wf("Support"))}`);
  await expect(chip(page)).toHaveText("Support");
  await expect.poll(() => columnNames(page)).toEqual(["Support", "Awaiting customer", "Ops", "Approve", "Done", "Dropped"]);
  await shot(page, "board-support");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("3 · a Task filed lands on Triage's board; advanced along bug it leaves for Bugs' board, no reload", async ({ browser }) => {
  const triage = await open(browser, board(wf("Triage")));
  const bugs = await open(browser, board(wf("Bugs")));
  await expect.poll(() => columnNames(triage.page)).toEqual(["Triage", "Done", "Dropped"]);
  await expect.poll(() => columnNames(bugs.page)).toEqual(["Investigate", "Fix", "Review", "Verify", "Done", "Dropped"]);

  filed = (await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "ACC", title: "Totals round twice" })).task;
  expect(filed.step_id).toBe(stepOf("Triage"));
  await expect(triage.page.getByRole("region", { name: "Triage", exact: true }).locator(`[data-task="${filed.key}"]`)).toBeVisible();
  await expect(card(bugs.page, filed.key)).toHaveCount(0);

  await v1(as.ada, "POST", `/v1/tasks/${filed.key}/claim`, {});
  await v1(as.ada, "POST", `/v1/tasks/${filed.key}/advance`, { outcome: "bug" });
  await expect(card(triage.page, filed.key)).toHaveCount(0);
  await expect(bugs.page.getByRole("region", { name: "Investigate", exact: true }).locator(`[data-task="${filed.key}"]`)).toBeVisible();
  await shot(bugs.page, "board-bugs-task");

  expect([...triage.errors, ...bugs.errors]).toEqual([]);
  await triage.ctx.close();
  await bugs.ctx.close();
});

test("4 · completed at Verify, its card sits in Bugs' Done and in no other Workflow's", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, board(wf("Bugs")));
  await expect(card(page, filed.key)).toBeVisible();
  const advance = async (who: Who, outcome: string, at: string) => {
    await v1(who, "POST", `/v1/tasks/${filed.key}/claim`, {});
    await v1(who, "POST", `/v1/tasks/${filed.key}/advance`, { outcome });
    if (at !== "Done") await expect(page.getByRole("region", { name: at, exact: true }).locator(`[data-task="${filed.key}"]`)).toBeVisible();
  };
  // ada held it at Triage under triage: she may not take it again under engineer, though she has it.
  await expect(v1(as.ada, "POST", `/v1/tasks/${filed.key}/claim`, {})).rejects.toThrow(/not_takeable/);
  await advance(as.cleo, "fix", "Fix");
  await advance(as.cleo, "ready", "Review");
  await advance(as.bob, "pass", "Verify");
  await advance(as.dan, "pass", "Done");
  await expect(page.getByRole("region", { name: "Done", exact: true }).locator(`[data-task="${filed.key}"]`)).toBeVisible();
  const ended = (await v1<Detail>(as.ada, "GET", `/v1/tasks/${filed.key}`)).task;
  expect(ended.state).toBe("done");
  await shot(page, "board-bugs-done");

  for (const other of ["Triage", "Features", "Prototypes", "Support"]) {
    await page.goto(`${base}${board(wf(other))}`);
    await expect(chip(page)).toHaveText(other);
    await expect(page.getByRole("region", { name: "Done", exact: true })).toBeVisible();
    await expect(card(page, filed.key)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await ctx.close();
});

test("5 · the line of Triage shows an exit chip per crossing outcome; Bugs' shows the entry from Triage", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, `/projects/ACC/workflow?workflow=${wf("Triage")}`);
  const line = page.getByRole("region", { name: "Workflow", exact: true });
  await expect(line.locator('[data-head="Triage"]')).toBeVisible();
  await expect(line.locator('[data-chip="exit"]')).toHaveText(["bug → Bugs › Investigate", "feature → Features › Build", "prototype → Prototypes › Sketch", "question → Support › Support"]);
  await shot(page, "line-triage-exits");
  await chip(page).click();
  await page.getByRole("option", { name: "Bugs" }).click();
  await expect(chip(page)).toHaveText("Bugs");
  await expect(line.locator('[data-head="Investigate"]')).toBeVisible();
  await expect(line.getByText("from Triage · bug")).toBeVisible();
  await shot(page, "line-bugs-entry");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("6 · the editor's rail: a Workflow added with a Step and saved, the chip shows six; deleted with a Task, it asks where the Task goes", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, "/settings/projects/ACC/workflow");
  const rail = page.getByRole("list", { name: "Workflows" });
  await expect(rail.getByRole("listitem")).toHaveCount(5);
  await expect(rail.getByRole("button", { name: "Triage", exact: true })).toHaveAttribute("aria-current", "true");
  await shot(page, "editor-rail");

  // Ops, with Deploy at devops.
  await page.getByRole("button", { name: "Add a Workflow" }).click();
  const name = page.getByRole("textbox", { name: "Name of the Workflow" });
  await expect(name).toHaveValue("Workflow 2");
  await name.fill("Ops");
  await name.press("Enter");
  await expect(rail.getByRole("listitem")).toHaveCount(6);
  await expect(rail.getByRole("button", { name: "Ops", exact: true })).toHaveAttribute("aria-current", "true");
  await page.getByRole("button", { name: "Add a Step at the end of the line" }).click();
  await page.getByRole("textbox", { name: "Name of Step 1" }).fill("Deploy");
  await page.getByRole("combobox", { name: "Skill of Deploy" }).click();
  await page.getByPlaceholder("Find or name a Skill").fill("devops");
  await page.getByRole("option", { name: /^devops/ }).click();
  await expect(page.getByRole("button", { name: "Editing · 2 changes: list them" })).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/projects\/ACC\/workflow\?workflow=/);
  graph = await v1<Graph>(as.ada, "GET", "/v1/projects/ACC/workflow");
  expect(graph.workflows.map((w) => w.name)).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support", "Ops"]);
  expect(graph.steps.find((s) => s.name === "Deploy")?.workflow_id).toBe(wf("Ops"));

  // The board's chip lists six.
  const boardPage = await open(browser, board(wf("Bugs")));
  await chip(boardPage.page).click();
  await expect(boardPage.page.getByRole("option")).toHaveText(["Triage", "Bugs", "Features", "Prototypes", "Support", "Ops"]);
  await boardPage.page.keyboard.press("Escape");

  // An outcome's target out of a Bugs Step: its own Workflow's Steps first, then each other's under its name.
  await page.goto(`${base}/settings/projects/ACC/workflow?workflow=${wf("Bugs")}&step=${stepOf("Fix")}`);
  await page.getByRole("combobox", { name: "Where ready out of Fix leads" }).click();
  await expect.poll(() => groupsOfListbox(page)).toEqual(["Bugs", "Triage", "Features", "Prototypes", "Support", "Ops"]);
  await shot(page, "editor-outcome-groups");
  await page.keyboard.press("Escape");

  // A Task at Deploy: deleting Ops asks where it goes; it goes to Triage.
  const deploying = (await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "ACC", title: "Roll the ledger service", step: "Deploy" })).task;
  await page.goto(`${base}/settings/projects/ACC/workflow?workflow=${wf("Ops")}`);
  await expect(rail.getByRole("button", { name: "Ops", exact: true })).toHaveAttribute("aria-current", "true");
  await rail.getByRole("button", { name: "Delete Ops" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Ops" });
  await expect(dialog.getByText("1 Task at Deploy")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete Ops" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Step that receives the Tasks at Deploy" }).click();
  await page.getByRole("option", { name: "Triage", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete Ops" }).click();
  await expect(rail.getByRole("listitem")).toHaveCount(5);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/projects\/ACC\/workflow/);
  await expect.poll(async () => (await v1<Detail>(as.ada, "GET", `/v1/tasks/${deploying.key}`)).task.step_id).toBe(stepOf("Triage"));
  graph = await v1<Graph>(as.ada, "GET", "/v1/projects/ACC/workflow");
  expect(graph.workflows.map((w) => w.name)).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);

  expect([...errors, ...boardPage.errors]).toEqual([]);
  await boardPage.ctx.close();
  await ctx.close();
});

test("7 · File Task's Step picker groups the Steps by Workflow; the list heads each Step group with its Workflow", async ({ browser }) => {
  await v1(as.ada, "POST", "/v1/tasks", { project: "ACC", title: "Crash on save", step: "Investigate" });
  const { page, errors, ctx } = await open(browser, board(wf("Bugs")));
  await expect.poll(() => columnNames(page)).toEqual(["Investigate", "Fix", "Review", "Verify", "Done", "Dropped"]);
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "File a Task" });
  await dialog.getByRole("combobox", { name: "Step" }).click();
  await expect.poll(() => groupsOfListbox(page)).toEqual(["Triage", "Bugs", "Features", "Prototypes", "Support"]);
  await shot(page, "file-task-step-groups");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.goto(`${base}/projects/ACC/tasks?view=list`);
  await expect(page.getByRole("main").getByRole("region", { name: "Bugs › Investigate" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("region", { name: "Triage › Triage" })).toBeVisible();
  await shot(page, "list-headings");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("8 · on a phone, Bugs' board does not scroll sideways and the chip shows", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, board(wf("Bugs")), { width: 390, height: 844 });
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toHaveText("Bugs");
  await expect(page.getByRole("region", { name: "Investigate", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  await shot(page, "phone-board-bugs");
  expect(errors).toEqual([]);
  await ctx.close();
});
