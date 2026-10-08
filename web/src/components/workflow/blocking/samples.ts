// The Blocking view's sample Projects, as the deps round drew them (frag-r2-deps.html, DEP-2):
// MAIN, with a cross-Parent Blocking and a double block, and BIG, with 9 Blockings, a 4-chain and
// a double block. The layout's tests and the design lab read them.
import type { GraphStep } from "../graph";
import type { BlockingTask } from "./layout";

export const me = { id: "m-tu", name: "tuongaz", kind: "human" as const };
const builder = { id: "m-builder", name: "builder", kind: "agent" as const };
const qa = { id: "m-qa", name: "qa", kind: "agent" as const };
const reviewer = { id: "m-reviewer", name: "reviewer", kind: "agent" as const };
const designer = { id: "m-design", name: "designer", kind: "agent" as const };

/** The samples' clock: 10:42:05. */
export const sampleNow = Date.parse("2026-10-08T10:42:05Z");
const ago = (min: number) => sampleNow - min * 60_000;

const task = (project: string, n: number, title: string, rest: Partial<BlockingTask> & { since: number }): BlockingTask => ({
  id: `${project.toLowerCase()}-${n}`,
  key: `${project}-${n}`,
  title,
  projectId: `p-${project.toLowerCase()}`,
  parent: false,
  rank: 9,
  blockedBy: [],
  takeable: false,
  takeableByMe: false,
  ...rest,
});

export const mainSteps: GraphStep[] = [
  { id: "s-backlog", name: "Backlog" },
  { id: "s-plan", name: "Plan", skill: { id: "k-breakdown", name: "breakdown" } },
  { id: "s-build", name: "Build", skill: { id: "k-engineer", name: "engineer" } },
  { id: "s-qa", name: "QA", skill: { id: "k-qa", name: "qa" } },
  { id: "s-review", name: "Review", skill: { id: "k-review", name: "review" } },
  { id: "s-retro", name: "Retro", skill: { id: "k-retro", name: "retro" } },
];

const M = (n: number, title: string, rest: Partial<BlockingTask> & { since: number }) => task("MAIN", n, title, rest);
const main7 = "main-7";
export const mainTasks: BlockingTask[] = [
  M(7, "Emoji reactions on support messages", { parent: true, rank: 1, since: ago(120) }),
  M(10, "Show reaction counts", { parentId: main7, rank: 1, stepId: "s-build", holder: { ...builder, working: "running" }, since: ago(0) }),
  M(11, "Notify the author of a reaction", { parentId: main7, rank: 1, stepId: "s-build", blockedBy: ["main-10"], since: ago(43) }),
  M(18, "Reaction analytics", { parentId: main7, rank: 1, stepId: "s-build", blockedBy: ["main-11"], since: ago(9) }),
  M(12, "Admin can remove a reaction", { parentId: main7, rank: 1, stepId: "s-review", takeable: true, since: ago(5) }),
  M(9, "Reaction picker on mobile", { parentId: main7, rank: 1, stepId: "s-qa", holder: { ...qa, working: "running" }, since: ago(5) }),
  M(4, "Coordinator export times out", { rank: 2, stepId: "s-build", blockedBy: ["main-13"], since: ago(62) }),
  M(13, "Which export format do coordinators use?", { rank: 3, aimedAt: me, takeable: true, takeableByMe: true, since: ago(36) }),
  M(19, "Export reactions", { rank: 4, stepId: "s-build", blockedBy: ["main-12", "main-4"], since: ago(7) }),
  M(6, "Audit log for reactions", { rank: 5, stepId: "s-review", holder: { ...reviewer, working: "waiting" }, since: ago(22) }),
  M(5, "Dark mode for the widget", { rank: 6, stepId: "s-backlog", since: ago(18 * 60) }),
  M(14, "Retrospective: Saved replies", { parentId: "main-2", rank: 7, stepId: "s-retro", takeable: true, since: ago(17 * 60) }),
];

export const bigSteps: GraphStep[] = [
  "Backlog",
  "Triage",
  "Plan",
  "Design",
  "Build",
  "Code review",
  "QA",
  "Security review",
  "Docs",
  "Acceptance",
  "Release",
  "Retro",
].map((name, i) => ({ id: `b-${i}`, name, skill: i === 0 ? undefined : { id: `bk-${i}`, name: name.toLowerCase() } }));
const step = (name: string) => bigSteps.find((s) => s.name === name)!.id;

const B = (n: number, title: string, rest: Partial<BlockingTask> & { since: number }) => task("BIG", n, title, rest);
const billing = "big-25";
const sso = "big-26";
export const bigTasks: BlockingTask[] = [
  B(25, "Billing v2", { parent: true, rank: 1, since: ago(300) }),
  B(26, "Single sign-on", { parent: true, rank: 2, since: ago(300) }),
  B(7, "Invoice layout", { parentId: billing, rank: 1, stepId: step("Design"), holder: { ...designer, working: "running" }, since: ago(25) }),
  B(10, "Invoice totals", { parentId: billing, rank: 1, stepId: step("Build"), blockedBy: ["big-7", "big-9"], since: ago(100) }),
  B(12, "Invoice email", { parentId: billing, rank: 1, stepId: step("Build"), blockedBy: ["big-10"], since: ago(55) }),
  B(19, "Billing end-to-end", { parentId: billing, rank: 1, stepId: step("QA"), blockedBy: ["big-12"], since: ago(30) }),
  B(9, "Tax engine", { parentId: billing, rank: 1, stepId: step("Build"), holder: { ...builder, working: "running" }, since: ago(12) }),
  B(11, "Tax report", { parentId: billing, rank: 1, stepId: step("Build"), blockedBy: ["big-9"], since: ago(70) }),
  B(15, "SAML login", { parentId: sso, rank: 2, stepId: step("Code review"), holder: { ...reviewer, working: "running" }, since: ago(8) }),
  B(20, "SSO threat model", { parentId: sso, rank: 2, stepId: step("Security review"), blockedBy: ["big-15"], since: ago(120) }),
  B(23, "SSO rollout", { parentId: sso, rank: 2, stepId: step("Release"), blockedBy: ["big-20"], since: ago(180) }),
  B(17, "SSO login tests", { parentId: sso, rank: 2, stepId: step("QA"), holder: { ...qa, working: "running" }, since: ago(15) }),
  B(22, "SSO sign-off", { parentId: sso, rank: 2, stepId: step("Acceptance"), blockedBy: ["big-17"], since: ago(50) }),
  B(5, "Rate limit spec", { rank: 3, stepId: step("Triage"), takeable: true, since: ago(40) }),
  B(8, "Rate limit page", { rank: 4, stepId: step("Design"), blockedBy: ["big-5"], since: ago(65) }),
  ...[1, 2, 3].map((n, i) => B(n, `Backlog idea ${n}`, { rank: 10 + i, stepId: step("Backlog"), since: ago(600) })),
  ...[4, 6].map((n, i) => B(n, `Worked ${n}`, { rank: 13 + i, stepId: step("Build"), holder: { ...builder, working: "running" }, since: ago(20) })),
  ...[13, 14, 16, 18, 21, 24].map((n, i) => B(n, `Waiting ${n}`, { rank: 15 + i, stepId: step("Docs"), takeable: true, since: ago(90) })),
];
