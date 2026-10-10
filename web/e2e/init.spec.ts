import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { startInstall, type Install } from "./server";

// Scenario 11 of docs/build/model-v2-plan.md in the browser: a fresh `darkory init` with its roster
// (outside a git repository, so no Workspace) makes the Organisation, the builtin Skills,
// engineer, review, triage and qa, the five agents (planner, builder, reviewer, tester and retro),
// and MAIN on the default Workflows (Implementation, Bug triage and Retrospective,
// docs/build/sample-workflows-plan.md), and prints a login link; the
// Install checklist leads from there to the first Task. Init on each engine is e2e/init_test.go's
// (`make e2e`, `make e2e-pg`); this is the SQLite Install the web suite runs.
const shots = fileURLToPath(new URL("./screenshots/init/", import.meta.url));

let install: Install;

const shot = (page: Page, name: string) => page.screenshot({ path: `${shots}${name}.png`, animations: "disabled" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  install = await startInstall({ roster: true });
});

test.afterAll(async () => {
  await install?.stop();
});

async function ask<T>(path: string): Promise<T> {
  const res = await fetch(`${install.base}${path}`, { headers: { Authorization: `Bearer ${install.token}`, "Darkory-Session": "e2e-init-ada" } });
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}

test("scenario 11: a fresh init's record, its printed link, and the checklist to the first Task", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await test.step("init says what it made", async () => {
    expect(install.init).toContain('Initialised the Organisation "E2E Organisation"');
    expect(install.init).toContain("First Member: ada (human, admin)");
    expect(install.init).toContain("Project MAIN (Main), on the default Workflows, holds ada and the agents below.");
    expect(install.init).toContain("No Workspace: init ran outside a git repository.");
    // The roster table, line by line: the reviewer holds review and skill-review alone, the tester qa.
    for (const line of [
      /^ {2}planner\s+breakdown, triage\s+claude-opus-5-5$/m,
      /^ {2}builder\s+engineer\s+claude-sonnet-5-5$/m,
      /^ {2}reviewer\s+review, skill-review\s+claude-opus-5-5$/m,
      /^ {2}tester\s+qa\s+claude-sonnet-5-5$/m,
      /^ {2}retro\s+retro\s+claude-opus-5-5$/m,
    ])
      expect(install.init).toMatch(line);
    expect(install.init).toMatch(/http:\/\/\S+\/v1\/login-links\/\S+/);
  });

  await test.step("the record: the builtin Skills, engineer, review, triage and qa, the roster, MAIN's two default Workflows", async () => {
    const skills = (await ask<{ items: { name: string; builtin: boolean }[] }>("/v1/skills")).items;
    expect(skills.filter((s) => s.builtin).map((s) => s.name).sort()).toEqual(["acceptance", "breakdown", "retro", "skill-review"]);
    expect(skills.filter((s) => !s.builtin).map((s) => s.name).sort()).toEqual(["engineer", "qa", "review", "triage"]);
    const members = (await ask<{ items: { name: string; kind: string; manager_id?: string; id: string }[] }>("/v1/members")).items;
    const ada = members.find((m) => m.name === "ada")!;
    const agents = members.filter((m) => m.kind === "agent");
    expect(agents.map((m) => m.name).sort()).toEqual(["builder", "planner", "retro", "reviewer", "tester"]);
    expect(agents.every((m) => m.manager_id === ada.id)).toBe(true);
    const projects = (await ask<{ items: { key: string }[] }>("/v1/projects")).items;
    expect(projects.map((p) => p.key)).toEqual(["MAIN"]);
    const wf = await ask<{ workflows: { id: string; name: string; position: number }[]; steps: { name: string; workflow_id: string; position: number }[] }>("/v1/projects/MAIN/workflow");
    const workflows = [...wf.workflows].sort((a, b) => a.position - b.position);
    expect(workflows.map((w) => w.name)).toEqual(["Implementation", "Bug triage", "Retrospective"]);
    const stepsOf = (id: string) => wf.steps.filter((s) => s.workflow_id === id).sort((a, b) => a.position - b.position).map((s) => s.name);
    expect(stepsOf(workflows[0].id)).toEqual(["Backlog", "Plan", "Build", "Review"]);
    expect(stepsOf(workflows[1].id)).toEqual(["Triage", "Fix", "Code review", "Verify"]);
    expect(stepsOf(workflows[2].id)).toEqual(["Retro", "Skill review"]);
  });

  await test.step("init's printed link signs in once serve runs", async () => {
    // init names the address it will listen on; this serve took a free port.
    const printed = new URL(/http:\/\/\S+\/v1\/login-links\/\S+/.exec(install.init)![0]);
    const link = new URL(printed.pathname, install.base).toString();
    await page.goto(link);
    await expect(page.getByRole("button", { name: "Sign in as ada" })).toBeVisible();
    await shot(page, "01-init-link");
    await page.getByRole("button", { name: "Sign in as ada" }).click();
    await expect(page).toHaveURL(`${install.base}/inbox`);
  });

  const setup = page.getByRole("region", { name: "Set up E2E Organisation" });
  await test.step("the checklist: a Project and Members already, File Task next", async () => {
    await expect(setup.getByLabel("1 of 3, done")).toBeVisible();
    await expect(setup).toContainText("Project: Main");
    await expect(setup.getByLabel("2 of 3, done")).toBeVisible();
    await expect(setup.getByRole("button", { name: "File Task" })).toBeEnabled();
    // MAIN is current: unfolded in the sidebar's Projects.
    await expect(page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "Main", exact: true })).toHaveAttribute("aria-expanded", "true");
    await shot(page, "02-checklist");
  });

  await test.step("File Task files MAIN-1 at Build, where builder takes it; the Inbox replaces the checklist", async () => {
    await setup.getByRole("button", { name: "File Task" }).click();
    const dialog = page.getByRole("dialog", { name: "File a Task" });
    await expect(dialog.getByRole("combobox", { name: "Project" })).toContainText("Main");
    const stepField = dialog.getByRole("combobox", { name: "Step" });
    await expect(stepField).toContainText("Build");
    await expect(stepField.getByLabel("Taken by builder")).toBeVisible();
    await dialog.getByLabel("Title").fill("Write the README");
    await shot(page, "03-file-first-task");
    await dialog.getByRole("button", { name: "File Task" }).click();
    await expect(setup).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeAttached();
    await page.goto(`${install.base}/projects/MAIN/tasks?view=board`);
    await expect(page.getByRole("region", { name: "Build", exact: true }).locator("[data-task=MAIN-1]")).toContainText("Write the README");
    await shot(page, "04-first-task-on-the-board");
    // MAIN's Workflows list its three, Implementation first; its row opens its page, the line.
    await page.goto(`${install.base}/projects/MAIN/workflows`);
    const rows = page.getByRole("table", { name: "Workflows" }).getByRole("row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(1).getByRole("link").first()).toHaveText("Implementation");
    await expect(rows.nth(2).getByRole("link").first()).toHaveText("Bug triage");
    await expect(rows.nth(3).getByRole("link").first()).toHaveText("Retrospective");
    await rows.nth(1).getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`^${install.base}/projects/MAIN/workflows/[^/?]+$`));
    await expect(page.getByRole("region", { name: "Workflow", exact: true }).locator('button[data-task="MAIN-1"]')).toBeVisible();
    await shot(page, "05-default-workflow");
  });

  expect(errors).toEqual([]);
});
