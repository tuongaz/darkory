import type { Page, Route } from "@playwright/test";

// A mocked /v1 for the Workflow line under `vite dev` (`npm run lab`): Project MAIN at Sacca on
// Thursday 8 Oct 2026 at 10:42:05, exactly as mock-workflow/fixture.md and the deps round's
// additions write it (MAIN-18 blocked by MAIN-11; MAIN-19 blocked by MAIN-12 and MAIN-4), so each
// shot can be laid beside the approved mockup; and Project BIG, the heavy 12-Step / 7-loop
// Workflow of the brief's F8 with 24 open Tasks.

/** The fixture's clock: 10:42:05 local, the instant builder picks up MAIN-10. */
export const CLOCK = new Date(2026, 9, 8, 10, 42, 5);
const t = (h: number, m: number, s = 0, dayOffset = 0) => new Date(2026, 9, 8 + dayOffset, h, m, s).toISOString();
const at = t(9, 0);

const human = (id: string, name: string, admin = false) => ({ id, name, kind: "human", admin, created_at: at });
const agent = (id: string, name: string, model: string, paused = false) => ({
  id,
  name,
  kind: "agent",
  admin: false,
  created_at: at,
  agent: { command: "claude", args: [], model, env: {}, unattended: true, paused },
});
export const members = [
  human("m-tu", "tuongaz", true),
  agent("m-pl", "planner", "claude-opus-5-5"),
  agent("m-bu", "builder", "claude-sonnet-5-5"),
  agent("m-qa", "qa", "claude-sonnet-5-5"),
  agent("m-rv", "reviewer", "claude-opus-5-5"),
  agent("m-rt", "retro", "claude-opus-5-5", true),
  agent("m-ar", "architect", "claude-opus-5-5"),
  agent("m-sc", "security", "claude-opus-5-5"),
  agent("m-dv", "devops", "claude-sonnet-5-5"),
];
const who = (id: string) => {
  const x = members.find((y) => y.id === id)!;
  return { id: x.id, name: x.name, kind: x.kind };
};
const skill = (name: string, builtin = false) => ({ id: `s-${name}`, name, kind: "generic", builtin, current_version: 1, created_at: at });
const skills = ["breakdown", "acceptance", "retro", "skill-review"].map((n) => skill(n, true)).concat(["engineer", "qa", "review", "triage", "design", "security", "docs", "release", "architecture", "devops"].map((n) => skill(n)));

const MAIN = { id: "p-main", key: "MAIN", name: "Main", auto_complete: false, acceptance: true, created_at: at };
const BIG = { id: "p-big", key: "BIG", name: "Big", auto_complete: false, acceptance: true, created_at: at };
const SW = { id: "p-sw", key: "SW", name: "Software", auto_complete: true, acceptance: true, created_at: at };
const projects = [MAIN, BIG, SW];

const step = (id: string, name: string, position: number, skillName: string | undefined, takers: string[], median?: number) => ({
  id,
  name,
  skill_id: skillName ? `s-${skillName}` : undefined,
  position,
  x: 0,
  y: 0,
  tasks: 0,
  working: 0,
  takers: takers.map(who),
  median_ms: median,
});
const conn = (from: string, name: string, to: string | undefined, position: number) => ({ id: `c-${from}-${name.replace(/\W+/g, "-")}`, from_step_id: from, to_step_id: to, name, position });
const min = 60_000;

const mainWorkflow = {
  project_id: MAIN.id,
  steps: [
    step("backlog", "Backlog", 1, undefined, []),
    step("plan", "Plan", 2, "breakdown", ["m-pl"], 6 * min),
    step("build", "Build", 3, "engineer", ["m-bu"], 18 * min),
    step("qa", "QA", 4, "qa", ["m-qa"], 9 * min),
    step("review", "Review", 5, "review", ["m-rv"], 12 * min),
    step("acceptance", "Acceptance", 6, "acceptance", ["m-qa"], 11 * min),
    step("retro", "Retro", 7, "retro", ["m-rt"]),
    step("skillreview", "Skill review", 8, "skill-review", ["m-rv"]),
  ],
  connectors: [
    conn("plan", "done", undefined, 1),
    conn("build", "pass", "qa", 1),
    conn("build", "no UI change", "review", 2),
    conn("qa", "pass", "review", 1),
    conn("qa", "fail", "build", 2),
    conn("review", "pass", undefined, 1),
    conn("review", "needs changes", "build", 2),
    conn("review", "needs QA", "qa", 3),
    conn("acceptance", "pass", undefined, 1),
    conn("acceptance", "fail", "build", 2),
    conn("retro", "done", undefined, 1),
    conn("retro", "propose", "skillreview", 2),
    conn("skillreview", "publish", undefined, 1),
    conn("skillreview", "needs changes", "retro", 2),
  ],
};

const bigSteps: [string, string, string | undefined][] = [
  ["b-backlog", "Backlog", undefined],
  ["b-triage", "Triage", "triage"],
  ["b-plan", "Plan", "breakdown"],
  ["b-design", "Design", "design"],
  ["b-build", "Build", "engineer"],
  ["b-creview", "Code review", "review"],
  ["b-qa", "QA", "qa"],
  ["b-sec", "Security review", "security"],
  ["b-docs", "Docs", "docs"],
  ["b-acc", "Acceptance", "acceptance"],
  ["b-release", "Release", "release"],
  ["b-retro", "Retro", "retro"],
];
const bigWorkflow = {
  project_id: BIG.id,
  steps: bigSteps.map(([id, name, s], i) => step(id, name, i + 1, s, s ? ["m-bu"] : [])),
  connectors: [
    ...bigSteps.slice(0, -1).map(([id], i) => conn(id, "pass", bigSteps[i + 1][0], 1)),
    conn("b-retro", "pass", undefined, 1),
    conn("b-plan", "no design needed", "b-build", 2),
    conn("b-design", "rework", "b-plan", 2),
    conn("b-creview", "needs changes", "b-build", 2),
    conn("b-qa", "fail", "b-build", 2),
    conn("b-sec", "fail", "b-build", 2),
    conn("b-docs", "needs changes", "b-build", 2),
    conn("b-acc", "fail", "b-build", 2),
    conn("b-release", "rollback", "b-qa", 2),
  ],
};

// The software Workflow (examples/workflows/software/workflow.json): 14 Steps, loops into Design
// and Build, skips over Design and over Security review, and the branch after a Parent.
const swSteps: [string, string, string | undefined, string[]][] = [
  ["sw-backlog", "Backlog", undefined, []],
  ["sw-triage", "Triage", "triage", ["m-pl"]],
  ["sw-plan", "Plan", "breakdown", ["m-pl"]],
  ["sw-design", "Design", "architecture", ["m-ar"]],
  ["sw-threat", "Threat model", "security", ["m-sc"]],
  ["sw-dreview", "Design review", "review", ["m-rv"]],
  ["sw-build", "Build", "engineer", ["m-bu"]],
  ["sw-creview", "Code review", "review", ["m-rv"]],
  ["sw-sreview", "Security review", "security", ["m-sc"]],
  ["sw-qa", "QA", "qa", ["m-qa"]],
  ["sw-release", "Release", "devops", ["m-dv"]],
  ["sw-acc", "Acceptance", "acceptance", ["m-qa"]],
  ["sw-retro", "Retro", "retro", ["m-rt"]],
  ["sw-skrev", "Skill review", "skill-review", ["m-rv"]],
];
const swWorkflow = {
  project_id: SW.id,
  steps: swSteps.map(([id, name, s, takers], i) => step(id, name, i + 1, s, takers, s ? (8 + i) * min : undefined)),
  connectors: [
    conn("sw-triage", "no design needed", "sw-build", 1),
    conn("sw-plan", "done", undefined, 1),
    conn("sw-design", "security impact", "sw-threat", 1),
    conn("sw-design", "no security impact", "sw-dreview", 2),
    conn("sw-threat", "accepted", "sw-dreview", 1),
    conn("sw-threat", "redesign", "sw-design", 2),
    conn("sw-dreview", "approved", undefined, 1),
    conn("sw-dreview", "redesign", "sw-design", 2),
    conn("sw-build", "ready for review", "sw-creview", 1),
    conn("sw-creview", "pass", "sw-qa", 1),
    conn("sw-creview", "security review", "sw-sreview", 2),
    conn("sw-creview", "needs changes", "sw-build", 3),
    conn("sw-sreview", "pass", "sw-qa", 1),
    conn("sw-sreview", "needs changes", "sw-build", 2),
    conn("sw-qa", "pass", "sw-release", 1),
    conn("sw-qa", "fail", "sw-build", 2),
    conn("sw-release", "released", undefined, 1),
    conn("sw-release", "not ready", "sw-build", 2),
    conn("sw-acc", "pass", "sw-release", 1),
    conn("sw-acc", "fixes filed", undefined, 2),
    conn("sw-retro", "done", undefined, 1),
    conn("sw-retro", "propose", "sw-skrev", 2),
    conn("sw-skrev", "publish", undefined, 1),
    conn("sw-skrev", "needs changes", "sw-retro", 2),
  ],
};
const workflows = new Map<string, typeof mainWorkflow>([
  [MAIN.id, mainWorkflow],
  [BIG.id, bigWorkflow],
  [SW.id, swWorkflow],
]);

type Rec = Record<string, unknown> & { id: string; key: string; project_id: string; state: string; step_id?: string; parent_id?: string };
const stepSkill = (id: string | undefined) => [...mainWorkflow.steps, ...bigWorkflow.steps, ...swWorkflow.steps].find((s) => s.id === id)?.skill_id;
const brief = (id: string) => ({ id, key: id.replace("k-", "MAIN-"), title: titles[id] ?? "" });
const titles: Record<string, string> = {
  "k-1": "Saved cards at checkout",
  "k-4": "Coordinator export times out",
  "k-5": "Participant search ignores accents",
  "k-6": "Invoice PDF shows the wrong ABN",
  "k-7": "Emoji reactions on support messages",
  "k-8": "Break down: Emoji reactions…",
  "k-9": "Reaction picker on a message",
  "k-10": "Show reaction counts",
  "k-11": "Notify the author of a reaction",
  "k-12": "Admin can remove a reaction",
  "k-13": "Which export format do coordinators use?",
  "k-14": "Retrospective · Saved cards",
  "k-18": "Reaction analytics",
  "k-19": "Export reactions",
};
const claimOf = (n: number, holder: string, started: string, ended?: string, how?: string) => ({
  id: `cl-${n}-${holder}`,
  task_id: `k-${n}`,
  holder_id: holder,
  session_id: `sess-${n}`,
  heartbeat_timeout_seconds: 600,
  started_at: started,
  ...(ended ? { ended_at: ended, how_ended: how } : { expires_at: new Date(CLOCK.getTime() + 9 * min).toISOString() }),
});
function task(n: number, extra: Partial<Rec> & { step_id?: string }): Rec {
  const id = `k-${n}`;
  return {
    id,
    key: `MAIN-${n}`,
    project_id: MAIN.id,
    kind: "work",
    title: titles[id],
    description: "",
    state: "open",
    owner_id: "m-tu",
    rank: n,
    skill_id: stepSkill(extra.step_id),
    breakdown: false,
    auto_complete: false,
    acceptance: false,
    blocked: false,
    filed_by: "m-tu",
    waiting_since: (extra.step_since as string) ?? at,
    created_at: t(9, 50),
    ...extra,
  };
}
const blockedBy = (...ns: number[]) => ({ blocked: true, open_blockers: ns.map((n) => brief(`k-${n}`)) });

export function mainTasks(): Rec[] {
  return [
    task(7, { rank: 1, auto_complete: true, acceptance: true, breakdown: true, subtask_counts: { open: 5, working: 2, done: 1, dropped: 0 } }),
    task(8, { parent_id: "k-7", kind: "breakdown", state: "done", rank: undefined, ended_at: t(9, 58, 30), filed_by: undefined }),
    task(9, { parent_id: "k-7", rank: undefined, step_id: "qa", step_since: t(10, 29, 30), claim: claimOf(9, "m-qa", t(10, 36, 50)), filed_by: "m-pl" }),
    task(10, { parent_id: "k-7", rank: undefined, step_id: "build", step_since: t(9, 58, 30), claim: claimOf(10, "m-bu", t(10, 42, 5)), filed_by: "m-pl" }),
    task(11, { parent_id: "k-7", rank: undefined, step_id: "build", step_since: t(9, 58, 30), filed_by: "m-pl", ...blockedBy(10) }),
    task(12, { parent_id: "k-7", rank: undefined, step_id: "review", step_since: t(10, 36, 40), filed_by: "m-pl" }),
    task(18, { parent_id: "k-7", rank: undefined, step_id: "build", step_since: t(10, 33, 0), filed_by: "m-pl", ...blockedBy(11) }),
    task(6, { rank: 2, step_id: "review", step_since: t(10, 18, 44), claim: claimOf(6, "m-rv", t(10, 20, 3)) }),
    task(4, { rank: 3, step_id: "build", step_since: t(9, 40), ...blockedBy(13) }),
    task(13, { rank: 4, aimed_at_id: "m-tu", filed_by: "m-bu", created_at: t(10, 5, 20), waiting_since: t(10, 5, 20) }),
    task(5, { rank: 5, step_id: "backlog", step_since: t(16, 10, 0, -1) }),
    task(1, { rank: 6, state: "done", ended_at: t(17, 2, 0, -1), acceptance: false, subtask_counts: { open: 1, working: 0, done: 3, dropped: 0 } }),
    task(14, { parent_id: "k-1", kind: "retrospective", rank: undefined, step_id: "retro", step_since: t(17, 2, 0, -1), filed_by: undefined }),
    task(19, { rank: 7, step_id: "build", step_since: t(10, 34, 51), ...blockedBy(12, 4) }),
  ];
}

/** BIG's 24 open Tasks over its 12 Steps: 6 held, 3 blocked, as F8 spreads them. */
export function bigTasks(): Rec[] {
  const spread: [string, number[], number[]][] = [
    ["b-backlog", [1, 2, 3], []],
    ["b-triage", [4, 5], [4]],
    ["b-plan", [6], [6]],
    ["b-design", [7, 8], [7]],
    ["b-build", [9, 10, 11, 12, 13, 14], [9]],
    ["b-creview", [15, 16], [15]],
    ["b-qa", [17, 18, 19], [17]],
    ["b-sec", [20], []],
    ["b-docs", [21], []],
    ["b-acc", [22], []],
    ["b-release", [23], []],
    ["b-retro", [24], []],
  ];
  const blocks: Record<number, number> = { 10: 9, 11: 9, 12: 7 };
  // BIG-25, a Parent whose Subtasks are spread over the line; two of them ended Done.
  const children = new Set([2, 5, 7, 10, 13, 16, 18, 20, 21, 23]);
  const parent: Rec = {
    id: "big-25",
    key: "BIG-25",
    project_id: BIG.id,
    kind: "work",
    title: "Big Parent across the line",
    description: "",
    state: "open",
    owner_id: "m-tu",
    rank: 25,
    breakdown: true,
    auto_complete: true,
    acceptance: true,
    blocked: false,
    subtask_counts: { open: children.size, working: 1, done: 2, dropped: 0 },
    waiting_since: t(9, 0),
    created_at: t(9, 0),
  };
  const ended: Rec[] = [26, 27].map((n) => ({ ...parent, id: `big-${n}`, key: `BIG-${n}`, title: `Big Subtask ${n}`, parent_id: "big-25", state: "done", ended_at: t(9, 40), subtask_counts: undefined, breakdown: false, rank: undefined }));
  return [parent, ...ended, ...spread.flatMap(([stepId, ns, held]) =>
    ns.map((n) => ({
      id: `big-${n}`,
      key: `BIG-${n}`,
      project_id: BIG.id,
      kind: "work",
      title: `Big Task ${n}`,
      description: "",
      state: "open",
      owner_id: "m-tu",
      rank: n,
      step_id: stepId,
      step_since: t(9, 0),
      skill_id: stepSkill(stepId),
      breakdown: false,
      auto_complete: false,
      acceptance: false,
      blocked: !!blocks[n],
      ...(blocks[n] ? { open_blockers: [{ id: `big-${blocks[n]}`, key: `BIG-${blocks[n]}`, title: `Big Task ${blocks[n]}` }] } : {}),
      ...(held.includes(n) ? { claim: { id: `bc-${n}`, task_id: `big-${n}`, holder_id: "m-bu", session_id: `bs-${n}`, started_at: t(9, 30), expires_at: new Date(CLOCK.getTime() + 9 * min).toISOString() } } : {}),
      waiting_since: t(9, 0),
      created_at: t(9, 0),
      ...(children.has(n) ? { parent_id: "big-25" } : {}),
    })),
  )];
}

/** Software's Tasks: the Parent SW-1 through design into slices, and Tasks at Triage and design. */
export function swTasks(): Rec[] {
  const base = (n: number, title: string, extra: Partial<Rec>): Rec => ({
    id: `sw-${n}`,
    key: `SW-${n}`,
    project_id: SW.id,
    kind: "work",
    title,
    description: "",
    state: "open",
    owner_id: "m-tu",
    rank: n,
    skill_id: stepSkill(extra.step_id),
    breakdown: false,
    auto_complete: false,
    acceptance: false,
    blocked: false,
    filed_by: "m-tu",
    waiting_since: (extra.step_since as string) ?? t(9, 0),
    created_at: t(9, 0),
    ...extra,
  });
  const held = (n: number, holder: string, started = t(10, 30)) => ({
    claim: { id: `swc-${n}`, task_id: `sw-${n}`, holder_id: holder, session_id: `sws-${n}`, heartbeat_timeout_seconds: 600, started_at: started, expires_at: new Date(CLOCK.getTime() + 9 * min).toISOString() },
  });
  const sub = { parent_id: "sw-1", rank: undefined, filed_by: "m-ar" };
  return [
    base(1, "Only callers with an API key can create short links", { auto_complete: true, acceptance: true, subtask_counts: { open: 8, working: 3, done: 2, dropped: 0 } }),
    base(2, "Design: Only callers with an API key can create short links", { ...sub, filed_by: "m-pl", state: "done", ended_at: t(9, 50) }),
    base(3, "Keys are issued out of band and revocable", { ...sub, step_id: "sw-backlog", step_since: t(9, 51) }),
    base(4, "Creating a link requires an API key", { ...sub, step_id: "sw-build", step_since: t(9, 52), ...held(4, "m-bu") }),
    base(5, "Each key is rate limited", { ...sub, step_id: "sw-build", step_since: t(9, 52), blocked: true, open_blockers: [{ id: "sw-4", key: "SW-4", title: "Creating a link requires an API key" }] }),
    base(6, "A health check a load balancer can poll", { ...sub, step_id: "sw-creview", step_since: t(10, 10) }),
    base(7, "Callers learn when they are limited", { ...sub, step_id: "sw-sreview", step_since: t(10, 12), ...held(7, "m-sc") }),
    base(8, "The service ships as a container image", { ...sub, step_id: "sw-qa", step_since: t(10, 20) }),
    base(9, "A CI pipeline builds and tests every push", { ...sub, step_id: "sw-release", step_since: t(10, 25), ...held(9, "m-dv") }),
    base(10, "Deploy and roll back notes", { ...sub, step_id: "sw-threat", step_since: t(10, 26) }),
    base(11, "Short codes never collide", { ...sub, state: "done", ended_at: t(10, 0) }),
    base(12, "Links expire after a set time", { step_id: "sw-triage", step_since: t(10, 31), ...held(12, "m-pl") }),
    base(13, "Custom short codes", { step_id: "sw-triage", step_since: t(10, 33) }),
    base(14, "Design: Click analytics per link", { parent_id: "sw-15", rank: undefined, filed_by: "m-pl", step_id: "sw-design", step_since: t(10, 2), ...held(14, "m-ar") }),
    base(15, "Click analytics per link", { subtask_counts: { open: 1, working: 1, done: 0, dropped: 0 } }),
    base(16, "Design: Bulk link import", { parent_id: "sw-17", rank: undefined, filed_by: "m-pl", step_id: "sw-dreview", step_since: t(10, 15) }),
    base(17, "Bulk link import", { subtask_counts: { open: 1, working: 0, done: 0, dropped: 0 } }),
    base(18, "A short code that does not exist answers 404", { step_id: "sw-build", step_since: t(10, 5) }),
  ];
}

const sessionOf = (n: number, member: string, state: string, started: string, since = started) => ({ task_id: `k-${n}`, member_id: member, session_id: `sess-${n}`, host: "mac-mini", tmux: `dk-MAIN-${n}`, started_at: started, state, state_since: since, log_path: `/tmp/MAIN-${n}.log` });
const sessions = [sessionOf(10, "m-bu", "running", t(10, 41, 50)), sessionOf(9, "m-qa", "running", t(10, 36, 50)), sessionOf(6, "m-rv", "waiting", t(10, 20, 3), t(10, 39))];

let seq = 0;
const entry = (kind: string, subject: string, actor: string | undefined, payload: Record<string, unknown>, when: string) => ({
  seq: ++seq,
  at: when,
  kind,
  subject_type: "task",
  subject_id: subject,
  ...(actor ? { actor_id: actor } : {}),
  payload,
});
/** Today's Activity, oldest first (fixture.md's list). */
export const activity = [
  entry("task.filed", "k-6", "m-tu", { key: "MAIN-6", project_id: MAIN.id, step_id: "build" }, t(9, 20)),
  entry("task.claimed", "k-6", "m-bu", { step_id: "build" }, t(9, 31)),
  entry("task.filed", "k-7", "m-tu", { key: "MAIN-7", project_id: MAIN.id }, t(9, 50)),
  entry("task.claimed", "k-8", "m-pl", { step_id: "plan" }, t(9, 52, 10)),
  entry("task.completed", "k-8", "m-pl", { from: "plan", outcome: "done", since: Date.parse(t(9, 50)) }, t(9, 58, 30)),
  ...[9, 10, 11, 12].map((n) => entry("task.filed", `k-${n}`, "m-pl", { key: `MAIN-${n}`, project_id: MAIN.id, step_id: "build" }, t(9, 58, 30))),
  entry("task.filed", "k-13", "m-bu", { key: "MAIN-13", project_id: MAIN.id }, t(10, 5, 20)),
  entry("task.advanced", "k-6", "m-bu", { from: "build", to: "review", outcome: "no UI change", since: Date.parse(t(9, 20)) }, t(10, 18, 44)),
  entry("task.claimed", "k-12", "m-bu", { step_id: "build" }, t(10, 18, 50)),
  entry("task.claimed", "k-6", "m-rv", { step_id: "review" }, t(10, 20, 3)),
  entry("task.advanced", "k-12", "m-bu", { from: "build", to: "qa", outcome: "pass", since: Date.parse(t(9, 58, 30)) }, t(10, 21, 15)),
  entry("task.claimed", "k-9", "m-bu", { step_id: "build" }, t(10, 21, 20)),
  entry("task.claimed", "k-12", "m-qa", { step_id: "qa" }, t(10, 22, 10)),
  entry("task.advanced", "k-9", "m-bu", { from: "build", to: "qa", outcome: "pass", since: Date.parse(t(9, 58, 30)) }, t(10, 29, 30)),
  entry("task.filed", "k-18", "m-pl", { key: "MAIN-18", project_id: MAIN.id, step_id: "build" }, t(10, 33)),
  entry("task.filed", "k-19", "m-tu", { key: "MAIN-19", project_id: MAIN.id, step_id: "build" }, t(10, 34, 51)),
  entry("task.advanced", "k-12", "m-qa", { from: "qa", to: "review", outcome: "pass", since: Date.parse(t(10, 21, 15)) }, t(10, 36, 40)),
  entry("task.claimed", "k-9", "m-qa", { step_id: "qa" }, t(10, 36, 50)),
  entry("task.nudged", "k-6", undefined, { claim_id: "cl-6-m-rv", holder_id: "m-rv", nudge: 1 }, t(10, 40, 12)),
  entry("task.claimed", "k-10", "m-bu", { step_id: "build" }, t(10, 42, 5)),
];

const claimsOf: Record<string, unknown[]> = {
  "k-9": [claimOf(9, "m-bu", t(10, 21, 20), t(10, 29, 30), "advanced"), claimOf(9, "m-qa", t(10, 36, 50))],
  "k-10": [claimOf(10, "m-bu", t(10, 42, 5))],
  "k-6": [claimOf(6, "m-bu", t(9, 31), t(10, 18, 44), "advanced"), claimOf(6, "m-rv", t(10, 20, 3))],
  "k-12": [claimOf(12, "m-bu", t(10, 18, 50), t(10, 21, 15), "advanced"), claimOf(12, "m-qa", t(10, 22, 10), t(10, 36, 40), "advanced")],
};

/** Stands in for the browser's EventSource, so a lab can deliver Activity: `window.__darkoryEmit(entry)`. */
function fakeStream() {
  const open: EventTarget[] = [];
  class FakeSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    constructor(readonly url: string) {
      super();
      open.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.(new Event("open"));
      }, 0);
    }
    close() {
      this.readyState = 2;
    }
  }
  (window as unknown as { EventSource: unknown }).EventSource = FakeSource;
  (window as unknown as { __darkoryEmit: (entry: unknown) => void }).__darkoryEmit = (e) => {
    for (const s of open as FakeSource[]) if (s.readyState === 1) s.dispatchEvent(new MessageEvent("activity", { data: JSON.stringify(e) }));
  };
}

export async function emit(page: Page, e: Record<string, unknown>) {
  await page.evaluate((x) => (window as unknown as { __darkoryEmit: (entry: unknown) => void }).__darkoryEmit(x), e);
}

/** Answers every /v1 read the shell, the Workflow page and the Task pages make, as tuongaz. */
export async function mockLine(page: Page) {
  await page.clock.setFixedTime(CLOCK);
  await page.addInitScript(fakeStream);
  const tasks = [...mainTasks(), ...bigTasks(), ...swTasks()];
  const byRef = (ref: string) => tasks.find((x) => x.id === ref || x.key === ref);
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const me = members[0];
  const startOfDay = new Date(2026, 9, 8).getTime();
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path === "/v1/activity/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": idle\n\n" });
    // The seen mark the panels keep: "Since you looked · 10:25".
    if (path.endsWith("/seen")) return json(route, { seq: activity.filter((e) => Date.parse(e.at) <= Date.parse(t(10, 25))).at(-1)!.seq, at: t(10, 25) });
    if (req.method() !== "GET") return json(route, { code: "invalid", message: `${req.method()} ${path} is not mocked` }, 400);
    if (path === "/v1/health") return json(route, { status: "ok", version: "v2.0.0", sign_in_modes: ["printed_link"] });
    if (path === "/v1/me")
      return json(route, {
        organisation: { id: "o-1", name: "Sacca", created_at: at },
        member: me,
        projects,
        skills: [],
        session: { id: "browser-1", member_id: me.id, kind: "browser", started_at: at, last_seen_at: at },
      });
    if (path === "/v1/members") return json(route, { items: members });
    if (path === "/v1/projects") return json(route, { items: projects });
    for (const p of projects) {
      if (path === `/v1/projects/${p.key}` || path === `/v1/projects/${p.id}`) return json(route, { project: p, members });
      if (path === `/v1/projects/${p.key}/workflow` || path === `/v1/projects/${p.id}/workflow`) {
        const wf = workflows.get(p.id)!;
        const open = tasks.filter((x) => x.project_id === p.id && x.state === "open");
        return json(route, { ...wf, steps: wf.steps.map((s) => ({ ...s, tasks: open.filter((x) => x.step_id === s.id).length, working: open.filter((x) => x.step_id === s.id && x.claim).length })) });
      }
    }
    if (path.endsWith("/labels") || path === "/v1/labels") return json(route, { items: [] });
    if (path === "/v1/skills") return json(route, { items: skills });
    if (path === "/v1/tasks/takeable") return json(route, { items: tasks.filter((x) => x.id === "k-12") });
    if (path === "/v1/tasks") {
      const q = url.searchParams;
      const project = q.get("project");
      const proj = project ? projects.find((p) => p.key === project || p.id === project)?.id : undefined;
      const parent = q.get("parent") ? byRef(q.get("parent")!)?.id : undefined;
      const items = tasks.filter(
        (x) =>
          (!proj || x.project_id === proj) &&
          (!q.get("state") || x.state === q.get("state")) &&
          (!parent || x.parent_id === parent) &&
          q.getAll("filter").every((f) => !f.startsWith("completed_at:gte:") || (x.ended_at && Date.parse(x.ended_at as string) >= startOfDay)),
      );
      return json(route, { items });
    }
    const one = path.match(/^\/v1\/tasks\/([^/]+)$/);
    if (one) {
      const x = byRef(decodeURIComponent(one[1]));
      if (!x) return json(route, { code: "not_found", message: "No such Task" }, 404);
      const parent = x.parent_id ? byRef(x.parent_id) : undefined;
      const wf = workflows.get(x.project_id)!;
      const s = wf.steps.find((y) => y.id === x.step_id);
      return json(route, {
        task: x,
        parent: parent && { id: parent.id, key: parent.key, title: parent.title },
        subtasks: tasks.filter((y) => y.parent_id === x.id),
        step: s && { id: s.id, name: s.name, skill_id: s.skill_id, position: s.position, x: 0, y: 0 },
        connectors: wf.connectors.filter((c) => c.from_step_id === x.step_id),
        labels: [],
        workspaces: [],
        claims: claimsOf[x.id] ?? (x.claim ? [x.claim] : []),
        notes: [],
        evidence: [],
        blockers: ((x.open_blockers as { id: string }[] | undefined) ?? []).map((b) => byRef(b.id)).filter(Boolean),
        blocking: tasks.filter((y) => ((y.open_blockers as { id: string }[] | undefined) ?? []).some((b) => b.id === x.id)),
        observations: [],
        proposals: [],
      });
    }
    if (path === "/v1/runner/sessions") return json(route, { items: sessions, runner: true });
    if (path === "/v1/workspaces" || path === "/v1/views") return json(route, { items: [] });
    if (path === "/v1/activity") {
      const ref = url.searchParams.get("task");
      const x = ref ? byRef(ref) : undefined;
      const ids = x ? new Set([x.id, ...tasks.filter((y) => y.parent_id === x.id).map((y) => y.id)]) : undefined;
      // As the server does: `project` keeps only that Project's entries (MAIN's, here).
      const pref = url.searchParams.get("project");
      const proj = pref ? projects.find((p) => p.key === pref || p.id === pref)?.id : undefined;
      const items = activity.filter((e) => (!ids || ids.has(e.subject_id)) && (!proj || byRef(e.subject_id)?.project_id === proj));
      return json(route, { items: [...items].reverse(), last_seq: seq, first_seq: 1 });
    }
    return json(route, { code: "not_found", message: `GET ${path} is not mocked` }, 404);
  });
}
