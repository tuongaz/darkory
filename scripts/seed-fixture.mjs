#!/usr/bin/env node
// Seeds a scratch Install with the Workflow page's fixture (web/e2e/fixture/workflow-reads.json, the
// figures of the vertical line's mockups vf-1 … vf-10) through /v1, for web/e2e/compare.mjs:
//
//   DARK    Darkory on g2 (Implementation · Bug triage · Retrospective): the fixture's Tasks at their
//           Steps under their holders, the question DARK-27 aimed at the admin blocking DARK-22, the
//           busy Build (DARK-21 held, DARK-28 … DARK-40 waiting), done today 3 + 1.
//   DARKG1  "Darkory g1", today's seed (Implementation with Retro and Skill review, Bug triage): the
//           same story without the busy Build, so Build reads DARK-21 held and DARK-23 waiting.
//   NEWS    Newsletter on Editorial (Draft · Edit · Legal, a hold · Publish), NEWS-39 … NEWS-42.
//   ACME    Platform: 12 Steps, 20 Connectors; counts per Step and who holds, no named Tasks.
//
//   DARKORY_URL=http://127.0.0.1:51616 DARKORY_TOKEN=dk_... node scripts/seed-fixture.mjs
//
// DARKORY_TOKEN is the admin's from a fresh `darkory init --name "Tuong Le"` (the fixture's
// tuongaz; the name gives the avatar TL). Node 20+, no dependencies. FIXTURE overrides the fixture.
//
// Keys are the fixture's: a Project's keys are given in order, so the seed files every key from 1 in
// turn and drops the ones the fixture does not name (dropped is not done, so "N today" is not
// touched). What /v1 cannot make: ages and medians (every since, held for and median is the seed's
// own seconds; the fixture's clock, Fri 10 Oct 14:30 AEDT, cannot be set), DARK-22's kind (a
// Breakdown Subtask is filed with its Parent and takes the key after it, so DARK-22 is a plain
// Subtask at Plan titled "Break down: …"), and Runner sessions (the server runs with --runner=off).
//
// Safe to run again: Members, Skills and Projects are made only when missing, the Workflows keep
// their ids by name, and a Project's Tasks are filed only while it has none. It refuses an Install
// with Projects other than MAIN and its own, so it never writes into a real one.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(process.env.FIXTURE ?? join(here, "..", "web", "e2e", "fixture", "workflow-reads.json"), "utf8"));
const base = (process.env.DARKORY_URL ?? "").replace(/\/$/, "");
const adminToken = process.env.DARKORY_TOKEN ?? "";
if (!base || !adminToken) throw new Error("set DARKORY_URL to the Install's address and DARKORY_TOKEN to an admin's token");
if (new URL(base).port === "7357") throw new Error("7357 is the owner's make dev; seed a scratch Install on another port");

const say = (s) => console.error(`· ${s}`);
// Milliseconds between the story's moves, so "What's happening" orders them as the fixture does.
const pause = Number(process.env.SEED_PAUSE ?? 150);
const step = () => new Promise((r) => setTimeout(r, pause));

/** One /v1 call as `token` in `session`; throws with the reply on an error, returns null on a 404 when `missing` is set. */
async function v1(method, path, body, { token = adminToken, session = "seed-fixture", missing = false } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Darkory-Session": session,
      "Idempotency-Key": crypto.randomUUID(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body && JSON.stringify(body),
  });
  if (missing && res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ------------------------------------------------------------------ the guard
const ours = ["MAIN", "DARK", "DARKG1", "NEWS", "ACME"];
const me = (await v1("GET", "/v1/me")).member;
const projectsBefore = (await v1("GET", "/v1/projects")).items ?? [];
const foreign = projectsBefore.filter((p) => !ours.includes(p.key)).map((p) => p.key);
if (foreign.length) throw new Error(`this Install has Projects the seed did not make (${foreign.join(", ")}); seed a fresh one`);
if (!me.admin) throw new Error("DARKORY_TOKEN must be an admin's");
say(`seeding ${base} as ${me.name}`);

// ------------------------------------------------------------------ Skills and Members
const skills = new Set(((await v1("GET", "/v1/skills")).items ?? []).map((s) => s.name));
async function ensureSkill(name) {
  if (skills.has(name)) return;
  await v1("POST", "/v1/skills", { name, kind: "generic", body: `Work a Task at a Step carrying ${name}.` });
  skills.add(name);
  say(`Skill ${name}`);
}

/** The fixture's Members by their fixture id: { id (the server's), name, kind, skills }. tuongaz is the admin running the seed. */
const people = {};
async function ensureMember(fid, { name, kind, admin = false, skills: want = [] }) {
  let member = fid === "tuongaz" ? me : (await v1("GET", `/v1/members/${encodeURIComponent(name)}`, undefined, { missing: true }))?.member;
  if (!member) {
    const made = await v1("POST", "/v1/members", { name, kind, ...(admin ? { admin } : {}) });
    member = made.member ?? made;
    if (kind === "agent") await v1("PATCH", `/v1/members/${member.id}/agent`, { model: "claude-sonnet-5-5", paused: false });
    say(`${kind} ${name}`);
  }
  for (const s of want) {
    await ensureSkill(s);
    await v1("PUT", `/v1/members/${member.id}/skills/${s}`);
  }
  people[fid] = { id: member.id, name: member.name, kind, token: undefined };
  return people[fid];
}
for (const [fid, m] of Object.entries(fixture.members)) {
  // An agent's name is its id (planner → PL); a human's is the fixture's name (Mai Tran → MT).
  await ensureMember(fid, { name: m.kind === "agent" ? m.id : m.name, kind: m.kind, admin: m.admin, skills: m.skills });
}
// ACME's Members are named by kind only; each takes the Skill of the Step it holds at.
const acmeSkills = {
  triager: ["triage"], "planner-a": ["breakdown"], designer: ["design"], "eng-1": ["engineer"], "eng-2": ["engineer"],
  "reviewer-a": ["review"], "tester-a": ["qa"], sec: ["security"], "writer-a": ["docs"], "release-bot": ["release"], "retro-a": ["retro"],
};
for (const [fid, kind] of Object.entries(fixture.projects.ACME.memberKinds)) {
  if (people[fid]) continue;
  await ensureMember(fid, { name: fid, kind, skills: acmeSkills[fid] ?? [] });
}

/** A Member's token, issued once per run, for moves made as them. */
async function tokenOf(fid) {
  const p = people[fid];
  if (fid === "tuongaz") return adminToken;
  p.token ??= (await v1("POST", `/v1/members/${p.id}/tokens`, { name: "seed-fixture" })).secret;
  return p.token;
}
/** `as(fid)`: the /v1 calls a Member makes in their own Session. */
function as(fid) {
  const opts = async () => ({ token: await tokenOf(fid), session: `seed-fixture-${fid}` });
  return {
    file: async (body) => (await v1("POST", "/v1/tasks", body, await opts())).task.key,
    claim: async (key) => (await v1("POST", `/v1/tasks/${key}/claim`, { heartbeat_timeout_seconds: 0 }, await opts()), await step()),
    advance: async (key, outcome) => (await v1("POST", `/v1/tasks/${key}/advance`, { outcome }, await opts()), await step()),
    move: async (key, to) => (await v1("POST", `/v1/tasks/${key}/step`, { step: to }, await opts()), await step()),
    drop: async (key) => v1("POST", `/v1/tasks/${key}/drop`, {}, await opts()),
  };
}

// ------------------------------------------------------------------ Projects and Workflows
const hues = { DARK: 8, DARKG1: 8, NEWS: 1, ACME: 4 }; // Blue, Orange, Green: the fixture's --mark-dark 250°, --mark-news 60°, --mark-acme 150°

/** Makes the Project when missing, with the fixture's Members in it; returns whether it has no Tasks yet. */
async function ensureProject(key, name, members, workflow) {
  const have = await v1("GET", `/v1/projects/${key}`, undefined, { missing: true });
  if (!have) {
    await v1("POST", "/v1/projects", { key, name, color: hues[key], workflow, members: members.map((m) => people[m].id) });
    say(`Project ${key} (${name})`);
  }
  const tasks = (await v1("GET", `/v1/tasks?project=${key}&limit=1`)).items ?? [];
  const dropped = (await v1("GET", `/v1/tasks?project=${key}&state=dropped&limit=1`)).items ?? [];
  const done = (await v1("GET", `/v1/tasks?project=${key}&state=done&limit=1`)).items ?? [];
  return tasks.length + dropped.length + done.length === 0;
}

/** Puts the fixture's Workflows (`{workflows: [{name, position, steps, connectors}]}`) on the Project, each Workflow and Step keeping the id of the one of its name. */
async function setWorkflows(key, shape) {
  const cur = await v1("GET", `/v1/projects/${key}/workflow`);
  const lc = (s) => s.toLowerCase();
  const wid = Object.fromEntries(cur.workflows.map((w) => [lc(w.name), w.id]));
  const sid = Object.fromEntries(cur.steps.map((s) => [lc(s.name), s.id]));
  const body = { workflows: [], steps: [], connectors: [] };
  for (const w of shape.workflows) {
    body.workflows.push({ ...(wid[lc(w.name)] ? { id: wid[lc(w.name)] } : {}), name: w.name, position: w.position });
    for (const s of w.steps) {
      body.steps.push({ ...(sid[lc(s.name)] ? { id: sid[lc(s.name)] } : {}), workflow: w.name, name: s.name, position: s.position, ...(s.skill ? { skill: s.skill } : {}) });
      await (s.skill ? ensureSkill(s.skill) : null);
    }
    const out = {};
    for (const c of w.connectors) {
      out[c.from] = (out[c.from] ?? 0) + 1;
      body.connectors.push({ from: c.from, ...(c.to ? { to: c.to } : {}), name: c.name, position: out[c.from] });
    }
  }
  await v1("PUT", `/v1/projects/${key}/workflow`, body);
}

const made = {}; // Project key → the keys filed, for the report

/** Files `n` Tasks that the fixture does not name, and drops them, so the next key is the fixture's. */
async function fillTo(key, who, upTo) {
  const a = as(who);
  for (;;) {
    const next = await a.file({ project: key, title: "Not in the fixture (dropped)" });
    await a.drop(next);
    if (Number(next.split("-")[1]) >= upTo - 1) return;
  }
}
/** Files one fixture Task and checks it took the fixture's key. */
async function fileAs(who, project, fkey, body) {
  const key = await as(who).file(body.parent ? body : { project, ...body });
  const want = `${project}-${fkey.split("-")[1]}`;
  if (key !== want) throw new Error(`${project}: filed ${key} where the fixture has ${fkey}`);
  (made[project] ??= []).push(key);
  return key;
}

// ------------------------------------------------------------------ DARK and DARKG1
const D = fixture.projects.DARK;
const dt = Object.fromEntries([...D.tasks, ...D.busy.waiting, ...D.questions, ...D.parents].map((t) => [t.key, t]));

/** The DARK story in a Project `key`: the fixture's keys from DARK-12 on, the moves in the order "What's happening" tells them. */
async function darkStory(key, { busy }) {
  const k = (fkey) => `${key}-${fkey.split("-")[1]}`;
  const T = (fkey) => dt[fkey].title;
  const [planner, builder, reviewer, tester] = ["planner", "builder", "reviewer", "tester"].map(as);
  await fillTo(key, "tuongaz", 12);
  // DARK-12 (Bug triage) and DARK-13, 15, 17 (Implementation) reached Done today; the others wait.
  await fileAs("tuongaz", key, "DARK-12", { title: "Inbox: a dropped Task's question closes", step: "Triage" });
  await fileAs("tuongaz", key, "DARK-13", { title: "Settings: Labels page sorts by name", step: "Build" });
  await fileAs("tuongaz", key, "DARK-14", { title: T("DARK-14"), step: "Fix" });
  await fileAs("tuongaz", key, "DARK-15", { title: "Activity: a move by hand names its mover", step: "Build" });
  await fileAs("tuongaz", key, "DARK-16", { title: T("DARK-16"), step: "Code review" });
  await fileAs("tuongaz", key, "DARK-17", { title: "Sidebar: a Project's chevron keeps its state", step: "Build" });
  await fileAs("tuongaz", key, "DARK-18", { title: T("DARK-18"), step: "Backlog" });
  await fileAs("tuongaz", key, "DARK-19", { title: T("DARK-19"), step: "Build" });
  await fileAs("tuongaz", key, "DARK-20", { title: T("DARK-20"), owner: people.tuongaz.id });
  await fileAs("tuongaz", key, "DARK-21", { title: T("DARK-21"), step: "Build" });
  // A Breakdown Subtask takes the key after its Parent's, so DARK-22 is filed as a Subtask at Plan.
  await fileAs("tuongaz", key, "DARK-22", { parent: k("DARK-20"), title: T("DARK-22"), step: "Plan" });
  // On g1 and g2 Build waits with DARK-23; the busy Build has DARK-28 … DARK-40 instead.
  if (busy) await fillTo(key, "tuongaz", 26);
  else {
    await fileAs("tuongaz", key, "DARK-23", { title: T("DARK-23"), step: "Build" });
    await fillTo(key, "tuongaz", 26);
  }
  await fileAs("tuongaz", key, "DARK-26", { title: T("DARK-26"), step: "Triage" });

  // The morning, then the afternoon as "What's happening" has it.
  await planner.claim(k("DARK-12"));
  await planner.advance(k("DARK-12"), "bug");
  await builder.claim(k("DARK-12"));
  await builder.advance(k("DARK-12"), "ready");
  await reviewer.claim(k("DARK-12"));
  await reviewer.advance(k("DARK-12"), "pass");
  await tester.claim(k("DARK-12"));
  await tester.advance(k("DARK-12"), "pass");
  for (const f of ["DARK-13", "DARK-15", "DARK-17"]) {
    await builder.claim(k(f));
    await builder.advance(k(f), "pass");
    await reviewer.claim(k(f));
    await reviewer.advance(k(f), "pass");
  }
  await builder.claim(k("DARK-21"));
  await reviewer.claim(k("DARK-16"));
  await reviewer.advance(k("DARK-16"), "pass");
  await tester.claim(k("DARK-16"));
  await builder.claim(k("DARK-19"));
  await builder.advance(k("DARK-19"), "pass");
  await reviewer.claim(k("DARK-19"));
  await planner.claim(k("DARK-22"));
  const q = D.questions[0];
  const question = await planner.file({ title: q.title, aim: people[q.aimedAt].id, blocks: k(q.blocks) });
  if (question !== k(q.key)) throw new Error(`${key}: the question is ${question}, the fixture's ${q.key}`);
  made[key].push(question);
  if (busy) for (const t of D.busy.waiting) await fileAs("tuongaz", key, t.key, { title: t.title, step: "Build" });
}

const darkMembers = D.members;
if (await ensureProject("DARK", "Darkory", darkMembers, "default")) {
  await setWorkflows("DARK", D.g2);
  await darkStory("DARK", { busy: true });
} else {
  await setWorkflows("DARK", D.g2);
  say("DARK has Tasks; none filed");
}
if (await ensureProject("DARKG1", "Darkory g1", darkMembers, "default")) {
  await setWorkflows("DARKG1", D.g1);
  await darkStory("DARKG1", { busy: false });
} else say("DARKG1 has Tasks; none filed");

// ------------------------------------------------------------------ NEWS
const N = fixture.projects.NEWS;
const nt = Object.fromEntries(N.tasks.map((t) => [t.key, t]));
const newsFresh = await ensureProject("NEWS", N.name, N.members, "empty");
await setWorkflows("NEWS", N.g1);
if (newsFresh) {
  const [jo, mai, writer, publisher] = ["jo", "mai", "writer", "publisher"].map(as);
  await fillTo("NEWS", "jo", 37);
  // NEWS-37 and NEWS-38 went the whole way today: Legal cleared by hand, then published.
  for (const [f, title, editor] of [["NEWS-37", "Release notes: October", jo], ["NEWS-38", "Customer story: the clinic's rota", mai]]) {
    await fileAs("jo", "NEWS", f, { title, step: "Draft" });
    await writer.claim(f);
    await writer.advance(f, "ready");
    await editor.claim(f);
    await editor.advance(f, "approved");
    await jo.move(f, "Publish");
    await publisher.claim(f);
    await publisher.advance(f, "published");
  }
  await fileAs("jo", "NEWS", "NEWS-39", { title: nt["NEWS-39"].title, step: "Publish" });
  await fileAs("jo", "NEWS", "NEWS-40", { title: nt["NEWS-40"].title, step: "Legal" });
  await fileAs("jo", "NEWS", "NEWS-41", { title: nt["NEWS-41"].title, step: "Edit" });
  await fileAs("jo", "NEWS", "NEWS-42", { title: nt["NEWS-42"].title, step: "Draft" });
  await mai.claim("NEWS-41");
  await writer.claim("NEWS-42");
} else say("NEWS has Tasks; none filed");

// ------------------------------------------------------------------ ACME
const A = fixture.projects.ACME;
const acmeFresh = await ensureProject("ACME", A.name, A.members, "empty");
await setWorkflows("ACME", A.g1);
if (acmeFresh) {
  const jo = as("jo");
  const titles = ["Rate limits per API key", "SSO for the admin console", "Audit log export", "Webhooks retry with backoff", "Billing: usage-based tiers",
    "Search: typo tolerance", "Mobile: offline drafts", "Status page", "Data retention settings", "Bulk user import", "Dark mode", "Two-factor recovery codes",
    "CSV export for reports", "Slack notifications", "Custom domains", "Role-based access", "Password policy", "API pagination", "Team invites expire", "Session timeout"];
  let n = 0;
  const file = async (step) => {
    const key = await jo.file({ project: "ACME", title: titles[n++ % titles.length], step });
    (made.ACME ??= []).push(key);
    return key;
  };
  // Five reached Done today, through Release and Retro.
  for (let i = 0; i < A.doneToday; i++) {
    const key = await file("Release");
    await as("release-bot").claim(key);
    await as("release-bot").advance(key, "pass");
    await as("retro-a").claim(key);
    await as("retro-a").advance(key, "pass");
  }
  for (const [step, at] of Object.entries(A.at)) {
    for (let i = 0; i < at.waiting; i++) await file(step);
    for (const holder of at.holders) await as(holder).claim(await file(step));
  }
} else say("ACME has Tasks; none filed");

// ------------------------------------------------------------------ the report
for (const key of ["DARK", "DARKG1", "NEWS", "ACME"]) {
  const wf = await v1("GET", `/v1/projects/${key}/workflow`);
  const byWf = Object.fromEntries(wf.workflows.map((w) => [w.id, w.name]));
  const steps = wf.steps.map((s) => `${byWf[s.workflow_id]} › ${s.name} ${s.tasks - s.working}w ${s.working}h`).join(" · ");
  const done = (await v1("GET", `/v1/tasks?project=${key}&state=done&limit=200`)).items?.length ?? 0;
  console.log(`${key}: ${steps} · done ${done}`);
  if (made[key]) console.log(`  filed ${made[key].join(" ")}`);
}
