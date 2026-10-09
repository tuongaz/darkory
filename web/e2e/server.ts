import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const startTimeoutMs = 60_000;

/** An Install started for the tests: its address, the startup login link, ada's token, what init printed. */
export type Install = { base: string; link: string; token: string; data: string; init: string; stop: () => Promise<void> };

/**
 * Builds the darkory binary from this checkout (embedding web/dist/app, which `npm run e2e` has
 * just built), runs `darkory init` in a fresh data directory, and starts `darkory serve` on a free
 * port. init always makes the Organisation, ada and Project MAIN on the default Workflow; without
 * `roster` it seeds no agents (--no-agents), with it the roster's agents too. init runs in the
 * data directory, outside any git repository, so MAIN has no Workspace.
 */
export async function startInstall(opts: { roster?: boolean } = {}): Promise<Install> {
  const bin = mkdtempSync(join(tmpdir(), "darkory-e2e-bin-"));
  const data = mkdtempSync(join(tmpdir(), "darkory-e2e-data-"));
  const exe = join(bin, "darkory");
  const env = { ...process.env, DARKORY_NO_UPDATE_CHECK: "1" };
  let server: ChildProcess | undefined;
  const stop = async () => {
    if (server) await stopProcess(server);
    rmSync(bin, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  };

  try {
    execFileSync("go", ["build", "-o", exe, "./cmd/darkory"], { cwd: repo, stdio: "inherit", env });
    const args = ["init", "--data", data, "--org", "E2E Organisation", "--name", "ada", ...(opts.roster ? [] : ["--no-agents"])];
    const init = execFileSync(exe, args, { cwd: data, env, stdio: "pipe" }).toString();
    // ada's token, which init prints once: a spec that runs after the startup link is used signs
    // in by asking /v1 for a login link of its own.
    const token = /^\s+(dk_\S+)$/m.exec(init)?.[1] ?? "";

    // Port 0: the kernel picks a free port, and serve prints its link with the port it got.
    // --runner=off: no agent the specs create ever gets a session started for it.
    server = spawn(exe, ["serve", "--no-browser", "--runner=off", "--listen", "127.0.0.1:0", "--data", data], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running = server;
    process.once("exit", () => running.kill("SIGKILL"));
    const link = await loginLink(server);
    return { base: new URL(link).origin, link, token, data, init, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * The shared Install every spec talks to unless it starts its own: `startInstall()`, whose startup
 * login link, address, data directory and admin token reach the tests through the environment
 * (DARKORY_E2E_LOGIN_LINK, _BASE_URL, _DATA and _ADMIN_TOKEN). The returned function stops it.
 */
export default async function startServer(): Promise<() => Promise<void>> {
  const install = await startInstall();
  process.env.DARKORY_E2E_LOGIN_LINK = install.link;
  process.env.DARKORY_E2E_BASE_URL = install.base;
  process.env.DARKORY_E2E_DATA = install.data;
  process.env.DARKORY_E2E_ADMIN_TOKEN = install.token;
  return install.stop;
}

/** An Install whose server runs the Runner beside it, for the Session panel's live terminal. */
export type RunnerInstall = { base: string; token: string; stop: () => Promise<void> };

// The Runner's clocks for a test: next answers within a second and progress is read twice a
// second, while a session lives for minutes (no nudge or lapse inside a test) and exits in 3 s.
const runnerTimings = "wait=1s,timeout=2m,tick=500ms,stale=2m,nudge=5m,exit=3s,poll=1m,retry=300ms";

/**
 * Starts an Install that runs agent sessions, as e2e/runner_test.go does: `darkory init` in a fresh
 * git repository seeds its roster (Team MAIN, the repository as its Workspace, planner, builder,
 * reviewer, tester and retro with tokens in <data>/agents); `setup` readies the agents through /v1 on a
 * first `serve --runner=off`, so no session ever starts the roster's default command (Claude
 * Code); then `serve --runner=on` takes over the same data. `tmux` is DARKORY_RUNNER_TMUX: "on"
 * runs sessions in tmux, "off" as child processes. setup gets the fake agent (tools/fakeagent,
 * built beside darkory) and a directory for its progress files. Nothing goes through the
 * environment, so the shared Install's variables stay as they are.
 */
export async function startRunnerInstall(
  tmux: "on" | "off",
  setup: (install: { base: string; token: string; fakeagent: string; scratch: string }) => Promise<void>,
): Promise<RunnerInstall> {
  const bin = mkdtempSync(join(tmpdir(), "darkory-e2e-bin-"));
  const data = mkdtempSync(join(tmpdir(), "darkory-e2e-data-"));
  const work = mkdtempSync(join(tmpdir(), "darkory-e2e-repo-"));
  const scratch = mkdtempSync(join(tmpdir(), "darkory-e2e-progress-"));
  const exe = join(bin, "darkory");
  const fakeagent = join(bin, "fakeagent");
  const env = { ...process.env, DARKORY_NO_UPDATE_CHECK: "1" };
  let server: ChildProcess | undefined;
  const stop = async () => {
    if (server) await stopProcess(server);
    // The Runner's own tmux server (tmux -L darkory-<the data directory's hash>), which outlives
    // it, and its socket, which tmux leaves behind.
    if (tmux === "on") {
      const socket = "darkory-" + createHash("sha256").update(realpathSync(data)).digest("hex").slice(0, 8);
      try {
        execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      } catch {
        // No tmux server left.
      }
      rmSync(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.()}`, socket), { force: true });
    }
    for (const dir of [bin, data, work, scratch]) rmSync(dir, { recursive: true, force: true });
  };

  try {
    execFileSync("go", ["build", "-o", exe, "./cmd/darkory"], { cwd: repo, stdio: "inherit", env });
    execFileSync("go", ["build", "-o", fakeagent, "./tools/fakeagent"], { cwd: repo, stdio: "inherit", env });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: work, stdio: "pipe", env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Ada");
    git("config", "user.email", "ada@example.com");
    writeFileSync(join(work, "README"), "the product\n");
    git("add", "README");
    git("commit", "-q", "-m", "first");
    const init = execFileSync(exe, ["init", "--data", data, "--org", "E2E Runner", "--name", "ada"], { cwd: work, env, stdio: "pipe" }).toString();
    // ada's token, the first init prints; the agents' are in <data>/agents.
    const token = /^\s+(dk_\S+)$/m.exec(init)?.[1] ?? "";

    const listen = ["serve", "--no-browser", "--listen", "127.0.0.1:0", "--data", data];
    server = spawn(exe, [...listen, "--runner=off"], { env, stdio: ["ignore", "pipe", "pipe"] });
    process.once("exit", () => server?.kill("SIGKILL"));
    await setup({ base: new URL(await loginLink(server)).origin, token, fakeagent, scratch });
    await stopProcess(server);

    server = spawn(exe, [...listen, "--runner=on"], {
      env: { ...env, DARKORY_RUNNER_TIMINGS: runnerTimings, DARKORY_RUNNER_TMUX: tmux },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runner = server;
    process.once("exit", () => runner.kill("SIGKILL"));
    return { base: new URL(await loginLink(server)).origin, token, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Waits for serve's startup login link on stdout; the server's log on stderr is passed through. */
function loginLink(server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`darkory serve printed no login link within ${startTimeoutMs} ms:\n${out}`)), startTimeoutMs);
    server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[darkory] ${chunk.toString()}`));
    server.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = /http:\/\/\S+\/v1\/login-links\/\S+/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`darkory serve exited with ${code} before printing a login link:\n${out}`));
    });
  });
}

function stopProcess(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => p.kill("SIGKILL"), 15_000);
    p.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    p.kill("SIGTERM");
  });
}
