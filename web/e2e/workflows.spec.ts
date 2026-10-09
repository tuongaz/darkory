import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall } from "./server";

// Named Workflows (ADR 0019; docs/build/named-workflows-plan.md, Task 17) against the real binary,
// on an Install of its own: Project ACC with ADR 0019's five Workflows, seeded through /v1 in one
// PUT of its whole graph. The board and the Workflow page show one Workflow at a time, picked by
// the chip; a Task advanced along a crossing outcome leaves one board for another without a
// reload; the line shows exits and entries. Round 2 (list first): Workflows opens on a list of
// them with their figures, a row opening one Workflow's page. Round 3 (shell-navigation-plan.md,
// Task 3): the list is the Workflows of every Project, one included, and carries its acts: it adds,
// moves and deletes one at once, and opens one Workflow's editor in the app, its name in its head.
test.describe.configure({ mode: "serial" });

const shots = fileURLToPath(new URL("./screenshots/workflows/", import.meta.url));

type Who = { token: string; session: string };
type Task = { id: string; key: string; title: string; state: string; step_id?: string; workflow_id?: string };
type Detail = { task: Task };
type Graph = {
  workflows: { id: string; name: string; position: number }[];
  steps: { id: string; name: string; workflow_id: string; skill_id?: string; position: number }[];
  connectors: { id: string; from_step_id: string; to_step_id?: string; name: string; position: number }[];
};

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
/** The address of a page of this Install, anchored: nothing before `base`. */
const address = (path: string) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${path}`);

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

/** ACC's graph as `/v1` serves it now. */
const readGraph = () => v1<Graph>(as.ada, "GET", "/v1/projects/ACC/workflow");

/** Renames one of ACC's Workflows through `/v1`: its whole graph sent back, every id carried. */
async function renameWorkflow(from: string, to: string) {
  const g = await readGraph();
  graph = await v1<Graph>(as.ada, "PUT", "/v1/projects/ACC/workflow", {
    workflows: g.workflows.map((w) => ({ id: w.id, name: w.name === from ? to : w.name, position: w.position })),
    steps: g.steps.map((st) => ({ id: st.id, workflow: st.workflow_id, name: st.name, ...(st.skill_id ? { skill: st.skill_id } : {}), position: st.position })),
    connectors: g.connectors.map((c) => ({ id: c.id, from: c.from_step_id, ...(c.to_step_id ? { to: c.to_step_id } : {}), name: c.name, position: c.position })),
  });
  expect(graph.workflows.map((w) => w.name)).toContain(to);
}

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
  const done = page.getByRole("region", { name: "Done", exact: true });
  await expect(done.locator(`[data-task="${filed.key}"]`)).toBeVisible();
  const ended = (await v1<Detail>(as.ada, "GET", `/v1/tasks/${filed.key}`)).task;
  expect(ended.state).toBe("done");
  expect(ended.workflow_id).toBe(wf("Bugs"));
  await done.scrollIntoViewIfNeeded();
  await shot(page, "board-bugs-done");

  for (const other of ["Triage", "Features", "Prototypes", "Support"]) {
    await page.goto(`${base}${board(wf(other))}`);
    await expect(chip(page)).toHaveText(other);
    // The board has read its Tasks: its Done column counts none of them.
    await expect(page.getByRole("region", { name: "Done", exact: true }).getByText("0 Tasks", { exact: true })).toBeVisible();
    await expect(card(page, filed.key)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await ctx.close();
});

test("5 · the line of Triage shows an exit chip per crossing outcome; Bugs' shows the entry from Triage", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, `/projects/ACC/workflows/${wf("Triage")}`);
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

/** The Workflows table, its rows' names in order. */
const workflowsTable = (page: Page) => page.getByRole("table", { name: "Workflows" });
const rowNames = (page: Page) => workflowsTable(page).getByRole("row").evaluateAll((rows) => rows.slice(1).map((r) => r.getAttribute("aria-label")));
const five = ["Triage", "Bugs", "Features", "Prototypes", "Support"];

test("6 · the Workflows list: added, named and saved; moved later and back; deleted with a Task and an outcome into it, the dialog asking where each goes", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, "/projects/ACC/workflows");
  await expect.poll(() => rowNames(page)).toEqual(five);
  await expect(workflowsTable(page).getByRole("button", { name: "Move Triage earlier" })).toBeDisabled();
  await expect(workflowsTable(page).getByRole("button", { name: "Move Support later" })).toBeDisabled();
  await expect(workflowsTable(page).getByRole("link", { name: "Edit Bugs" })).toBeVisible();
  // From `sm` up the acts sit in the row; the ⋯ is the phone's.
  await expect(workflowsTable(page).getByRole("button", { name: "More for Bugs" })).toBeHidden();
  await shot(page, "list-acts");

  // + Workflow, the bar's primary: written at once, and its editor opens in the app with its name to type.
  await page.getByRole("group", { name: "Page" }).getByRole("button", { name: "Workflow", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Name of the Workflow" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Workflow 6");
  await expect(page).toHaveURL(address("/projects/ACC/workflows/[^/?]+/edit$"));
  await expect.poll(async () => (graph = await readGraph()).workflows.map((w) => w.name)).toEqual([...five, "Workflow 6"]);
  await name.fill("Releases");
  await name.press("Enter");
  await expect(name).not.toBeFocused();
  await expect(page.getByRole("button", { name: "Editing · 1 change: list them" })).toBeVisible();
  await shot(page, "editor-rename");
  // Escape puts back the name the field had when entered.
  await name.click();
  await name.fill("Ship it");
  await name.press("Escape");
  await expect(name).toHaveValue("Releases");

  // A Step, Deploy at devops; Save opens the Workflow's live page.
  await page.getByRole("button", { name: "Add a Step at the end of the line" }).click();
  await page.getByRole("textbox", { name: "Name of Step 1" }).fill("Deploy");
  await page.getByRole("combobox", { name: "Skill of Deploy" }).click();
  await page.getByPlaceholder("Find or name a Skill").fill("devops");
  await page.getByRole("option", { name: /^devops/ }).click();
  await expect(page.getByRole("button", { name: "Editing · 2 changes: list them" })).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(address("/projects/ACC/workflows/[^/?]+$"));
  await expect(chip(page)).toHaveText("Releases");
  await expect.poll(async () => (graph = await readGraph()).workflows.map((w) => w.name)).toEqual([...five, "Releases"]);
  expect(graph.steps.find((s) => s.name === "Deploy")?.workflow_id).toBe(wf("Releases"));
  await page.goto(`${base}/projects/ACC/workflows`);
  await expect.poll(() => rowNames(page)).toEqual([...five, "Releases"]);

  // An outcome's target out of a Bugs Step: its own Workflow's Steps first, then each other's under its name.
  await page.goto(`${base}/projects/ACC/workflows/${wf("Bugs")}/edit?step=${stepOf("Fix")}`);
  await expect(name).toHaveValue("Bugs");
  await page.getByRole("combobox", { name: "Where ready out of Fix leads" }).click();
  await expect.poll(() => groupsOfListbox(page)).toEqual(["Bugs", "Triage", "Features", "Prototypes", "Support", "Releases"]);
  await shot(page, "editor-outcome-groups");
  await page.keyboard.press("Escape");

  // › moves Triage later at once: the list, the record and the list open in another window read the new order.
  await page.goto(`${base}/projects/ACC/workflows`);
  const live = await open(browser, "/projects/ACC/workflows");
  await expect.poll(() => rowNames(live.page)).toEqual([...five, "Releases"]);
  await workflowsTable(page).getByRole("button", { name: "Move Triage later" }).click();
  const moved = ["Bugs", "Triage", "Features", "Prototypes", "Support", "Releases"];
  await expect.poll(() => rowNames(page)).toEqual(moved);
  await expect.poll(async () => (await readGraph()).workflows.map((w) => w.name)).toEqual(moved);
  await expect.poll(() => rowNames(live.page)).toEqual(moved);
  await shot(page, "list-moved");
  // ‹ puts it back.
  await workflowsTable(page).getByRole("button", { name: "Move Triage earlier" }).click();
  await expect.poll(() => rowNames(page)).toEqual([...five, "Releases"]);
  await expect.poll(() => rowNames(live.page)).toEqual([...five, "Releases"]);

  // An outcome out of Triage into Deploy: a crossing the delete must ask about.
  await page.goto(`${base}/projects/ACC/workflows/${wf("Triage")}/edit`);
  await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: "1. Triage" }).click();
  await page.getByRole("button", { name: "Add an outcome out of Triage" }).click();
  await page.getByRole("textbox", { name: "Outcome out of Triage" }).last().fill("release");
  await page.getByRole("combobox", { name: "Where release out of Triage leads" }).click();
  await page.getByRole("option", { name: "Deploy", exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(address(`/projects/ACC/workflows/${wf("Triage")}`));
  graph = await readGraph();
  const release = () => graph.connectors.find((c) => c.from_step_id === stepOf("Triage") && c.name === "release");
  expect(release()?.to_step_id).toBe(stepOf("Deploy"));

  // A Task at Deploy: deleting Releases asks where it goes (to Triage) and where release leads
  // instead (nowhere: the outcome is removed); confirmed, it is written at once.
  const deploying = (await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "ACC", title: "Roll the ledger service", step: "Deploy" })).task;
  await page.goto(`${base}/projects/ACC/workflows`);
  await workflowsTable(page).getByRole("button", { name: "Delete Releases" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Releases" });
  await expect(dialog.getByText("1 Task at Deploy")).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Where release out of Triage leads instead" })).toHaveText("Remove this outcome");
  await expect(dialog.getByRole("button", { name: "Delete Releases" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Step that receives the Tasks at Deploy" }).click();
  await page.getByRole("option", { name: "Triage", exact: true }).click();
  await shot(page, "list-delete-asks");
  await dialog.getByRole("button", { name: "Delete Releases" }).click();
  await expect.poll(() => rowNames(page)).toEqual(five);
  await expect.poll(async () => (await v1<Detail>(as.ada, "GET", `/v1/tasks/${deploying.key}`)).task.step_id).toBe(stepOf("Triage"));
  await expect.poll(async () => (graph = await readGraph()).workflows.map((w) => w.name)).toEqual(five);
  expect(release()).toBeUndefined();
  expect(graph.connectors.filter((c) => c.from_step_id === stepOf("Triage")).map((c) => c.name)).toEqual(["bug", "feature", "prototype", "question"]);
  await expect.poll(() => rowNames(live.page)).toEqual(five);

  expect([...errors, ...live.errors]).toEqual([]);
  await live.ctx.close();
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

  // The list is the whole Project: each Step group headed with its Workflow, in the Project's
  // order; Done is no Workflow's and carries no prefix.
  await page.goto(`${base}/projects/ACC/tasks?view=list`);
  await expect(page.getByRole("main").getByRole("region", { name: "Bugs › Investigate" })).toBeVisible();
  await expect.poll(() => columnNames(page)).toEqual(["Triage › Triage", "Bugs › Investigate", "Done"]);
  await shot(page, "list-headings");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("8 · a Project of one Workflow has no chip; its board renders", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, "/projects/MAIN/tasks?view=board");
  await expect(columns(page).first()).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  const names = await columnNames(page);
  expect(names.slice(-2)).toEqual(["Done", "Dropped"]);
  expect(names.length).toBeGreaterThan(2);
  expect(errors).toEqual([]);
  await ctx.close();
});

/** The chip reads its whole name and its caret, inside a phone's 390 px, and the page does not scroll sideways (decision 8). */
async function chipReadsWhole(page: Page, name: string) {
  await expect(chip(page)).toBeVisible();
  await expect(chip(page)).toHaveText(name);
  const label = chip(page).locator("span").first();
  await expect(chip(page)).toBeInViewport({ ratio: 1 });
  await expect(chip(page).locator("svg")).toBeInViewport({ ratio: 1 });
  // Not clipped: the name's text fits its box, and the chip its own.
  expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await chip(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await insideThePhone(page, label);
}

/**
 * The chip, its name and its caret inside 390 px and inside the breadcrumb, the Project's mark
 * before it and the Project's name out of the bar; the page does not scroll sideways.
 */
async function insideThePhone(page: Page, label: ReturnType<Page["locator"]>) {
  const crumbNav = page.getByRole("navigation", { name: "Breadcrumb" });
  const mark = crumbNav.locator("[data-hue]");
  await expect(mark).toBeInViewport({ ratio: 1 });
  await expect(crumbNav.getByText("Accounts", { exact: true })).not.toBeInViewport();
  const markBox = await mark.boundingBox();
  expect(markBox!.width).toBeGreaterThanOrEqual(19);
  expect(markBox!.x + markBox!.width).toBeLessThan((await chip(page).boundingBox())!.x);
  for (const box of [markBox, await chip(page).boundingBox(), await label.boundingBox(), await chip(page).locator("svg").boundingBox()]) {
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  // Nothing in the bar is cut by what holds it: the chip ends inside the breadcrumb, and what the
  // page does sits on the bar's second row, under it.
  const crumbs = await page.getByRole("navigation", { name: "Breadcrumb" }).boundingBox();
  const whole = await chip(page).boundingBox();
  expect(whole!.x + whole!.width).toBeLessThanOrEqual(crumbs!.x + crumbs!.width + 0.5);
  const second = page.getByRole("group", { name: "Page" });
  if ((await second.count()) > 0) expect((await second.boundingBox())!.y).toBeGreaterThanOrEqual(crumbs!.y + crumbs!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
}

test("9 · on a phone, every Workflow's board and page reads the chip whole; a long name truncates before its caret", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, board(wf("Bugs")), { width: 390, height: 844 });
  for (const name of ["Triage", "Bugs", "Features", "Prototypes", "Support"]) {
    await page.goto(`${base}${board(wf(name))}`);
    await expect(columns(page).first()).toBeVisible();
    await chipReadsWhole(page, name);
    // The bar's second row: the List | Board switch as its two icons, then Views, Filter and
    // Display as icon buttons and the File Task primary, nothing folded.
    const row = page.getByRole("group", { name: "Page" });
    await expect(page.getByRole("button", { name: /^View: / })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
    await expect(row.getByRole("navigation", { name: "View" }).getByRole("link")).toHaveCount(2);
    await expect(row.getByRole("navigation", { name: "View" })).toBeInViewport({ ratio: 1 });
    for (const action of ["Views", "Filter", "Display", "File Task"]) await expect(row.getByRole("button", { name: action, exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
    await shot(page, `phone-board-${name.toLowerCase()}`);
  }
  await page.goto(`${base}/projects/ACC/workflows/${wf("Bugs")}`);
  await expect(page.getByRole("region", { name: "Workflow" })).toBeVisible();
  await chipReadsWhole(page, "Bugs");
  // Here the Project's crumb is a link, and on a phone its mark is all of it.
  const toProject = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Accounts", exact: true });
  await expect(toProject).toBeInViewport({ ratio: 1 });
  await expect(toProject).toHaveAttribute("href", "/projects/ACC/tasks");
  // Line | Blocking | Text stays three segments on the bar's second row, nothing folded.
  await expect(page.getByRole("button", { name: /^View: / })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Page" }).getByRole("group", { name: "View" })).toBeInViewport({ ratio: 1 });
  await shot(page, "phone-workflow-bugs");

  // A long name stops before the caret with an ellipsis; the caret stays in view.
  await renameWorkflow("Prototypes", "Prototypes and experiments");
  try {
    await page.goto(`${base}${board(wf("Prototypes and experiments"))}`);
    await expect(columns(page).first()).toBeVisible();
    await expect(chip(page)).toHaveText("Prototypes and experiments");
    const label = chip(page).locator("span").first();
    expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await label.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
    await expect(chip(page)).toBeInViewport({ ratio: 1 });
    await expect(chip(page).locator("svg")).toBeInViewport({ ratio: 1 });
    await insideThePhone(page, label);
    await shot(page, "phone-board-long-name");
  } finally {
    await renameWorkflow("Prototypes and experiments", "Prototypes");
  }
  expect(errors).toEqual([]);
  await ctx.close();
});

test("10 · on a phone, a board with no chip keeps the List | Board switch as two icons", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, "/projects/MAIN/tasks?view=board", { width: 390, height: 844 });
  await expect(columns(page).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^View: / })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "View" }).getByRole("link")).toHaveCount(2);
  await expect(page.getByRole("navigation", { name: "View" })).toBeInViewport({ ratio: 1 });
  // And Views, Filter and Display as three buttons.
  await expect(page.getByRole("button", { name: "More" })).toHaveCount(0);
  for (const action of ["Views", "Filter", "Display"]) await expect(page.getByRole("button", { name: action, exact: true })).toBeInViewport({ ratio: 1 });
  expect(errors).toEqual([]);
  await ctx.close();
});

/** The list's rows as their figures read: Workflow, Steps, Waiting, Working, Done today (an admin's act cells follow). */
const figures = (page: Page) =>
  workflowsTable(page)
    .getByRole("row")
    .evaluateAll((rows) => rows.slice(1).map((r) => [...r.querySelectorAll('[role="cell"]')].slice(0, 5).map((c) => c.textContent?.trim())));

test("11 · Workflows opens on a list of the five with their figures", async ({ browser }) => {
  // What the spec has left: "Totals round twice" done today in Bugs (4); "Roll the ledger service"
  // moved to Triage by the delete (6); "Crash on save" at Investigate (7). Now cleo takes Crash on
  // save, ada a Support Task, and one waits at Awaiting customer.
  const crash = (await v1<{ items: Task[] }>(as.ada, "GET", "/v1/tasks?project=ACC&state=open")).items.find((t) => t.title === "Crash on save")!;
  await v1(as.cleo, "POST", `/v1/tasks/${crash.key}/claim`, {});
  const refund = (await v1<Detail>(as.ada, "POST", "/v1/tasks", { project: "ACC", title: "Refund charged twice", step: "Support" })).task;
  await v1(as.ada, "POST", `/v1/tasks/${refund.key}/claim`, {});
  await v1(as.ada, "POST", "/v1/tasks", { project: "ACC", title: "Card declined abroad", step: "Awaiting customer" });

  const { page, errors, ctx } = await open(browser, "/projects/ACC/workflows");
  // The figures' heads, then an admin's act columns, named for a screen reader.
  await expect(workflowsTable(page).getByRole("columnheader")).toHaveText(["Workflow", "Steps", "Waiting", "Working", "Done today", "Order", "Edit or delete"]);
  // Waiting = a Workflow's open Tasks at its Steps less those worked; Working = those held; Done
  // today = the Tasks ended today listed in it.
  await expect
    .poll(() => figures(page))
    .toEqual([
      ["Triage", "1", "1", "0", "0"],
      ["Bugs", "4", "0", "1", "1"],
      ["Features", "4", "0", "0", "0"],
      ["Prototypes", "2", "0", "0", "0"],
      ["Support", "4", "1", "1", "0"],
    ]);
  // No chip: the list is every Workflow; rows are 36 px.
  await expect(chip(page)).toHaveCount(0);
  expect((await workflowsTable(page).getByRole("row", { name: "Bugs" }).boundingBox())!.height).toBe(36);
  await shot(page, "list");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("12 · a row opens Bugs' page; the chip goes to Support's; Edit opens its editor; the crumb leads back to the list", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, "/projects/ACC/workflows");
  await workflowsTable(page).getByRole("row", { name: "Bugs" }).click();
  await expect(page).toHaveURL(`${base}/projects/ACC/workflows/${wf("Bugs")}`);
  await expect(chip(page)).toHaveText("Bugs");
  const line = page.getByRole("region", { name: "Workflow", exact: true });
  await expect(line.locator('[data-head="Investigate"]')).toBeVisible();
  await chip(page).click();
  await page.getByRole("option", { name: "Support" }).click();
  await expect(page).toHaveURL(`${base}/projects/ACC/workflows/${wf("Support")}`);
  await expect(chip(page)).toHaveText("Support");
  await expect(line.locator('[data-head="Support"]')).toBeVisible();
  // The chip's pick is the board's too.
  expect(await page.evaluate(() => localStorage.getItem("darkory.workflow.ACC"))).toBe(wf("Support"));
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Workflows" })).toHaveAttribute("href", "/projects/ACC/workflows");
  // Edit names the Workflow and opens its editor in the app.
  await page.getByRole("group", { name: "Page" }).getByRole("link", { name: "Edit Support" }).click();
  await expect(page).toHaveURL(`${base}/projects/ACC/workflows/${wf("Support")}/edit`);
  await expect(page.getByRole("textbox", { name: "Name of the Workflow" })).toHaveValue("Support");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveText(/Accounts\s*\/\s*Workflows\s*\/\s*Support/);
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Workflows" }).click();
  await expect(page).toHaveURL(`${base}/projects/ACC/workflows`);
  await expect.poll(() => rowNames(page)).toEqual(five);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("13 · a Project of one Workflow lists it, with + Workflow", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, "/projects/MAIN/workflows");
  await expect(workflowsTable(page).getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("group", { name: "Page" }).getByRole("button", { name: "Workflow", exact: true })).toBeEnabled();
  // The last Workflow stays: its trash is off.
  await expect(workflowsTable(page).getByRole("button", { name: /^Delete / })).toBeDisabled();
  await expect(chip(page)).toHaveCount(0);
  await shot(page, "list-one");
  // Its row opens its page, with no chip.
  await workflowsTable(page).getByRole("row").nth(1).getByRole("link").first().click();
  await expect(page).toHaveURL(address("/projects/MAIN/workflows/[^/?]+$"));
  await expect(page.getByRole("region", { name: "Workflow", exact: true })).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Workflows" })).toHaveAttribute("href", "/projects/MAIN/workflows");
  expect(errors).toEqual([]);
  await ctx.close();
});

test("14 · on a phone, the list is a plain table with a ⋯ per row and no sideways scroll", async ({ browser }) => {
  const { page, errors, ctx } = await open(browser, "/projects/ACC/workflows", { width: 390, height: 844 });
  await expect.poll(() => rowNames(page)).toEqual(five);
  for (const name of five) {
    await expect(workflowsTable(page).getByRole("link", { name, exact: true })).toBeInViewport({ ratio: 1 });
    await expect(workflowsTable(page).getByRole("button", { name: `More for ${name}` })).toBeInViewport({ ratio: 1 });
  }
  await expect(workflowsTable(page).getByRole("button", { name: /^More for / })).toHaveCount(five.length);
  // The row's own acts fold into the ⋯ below `sm`.
  await expect(workflowsTable(page).getByRole("button", { name: "Delete Support" })).toBeHidden();
  await expect(workflowsTable(page).getByRole("columnheader", { name: "Done today" })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  await shot(page, "phone-list");
  await workflowsTable(page).getByRole("button", { name: "More for Bugs" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Edit", "Move earlier", "Move later", "Delete"]);
  await shot(page, "phone-list-more");
  await menu.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page).toHaveURL(`${base}/projects/ACC/workflows/${wf("Bugs")}/edit`);
  expect(errors).toEqual([]);
  await ctx.close();
});
