import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const startTimeoutMs = 60_000;

/**
 * Builds the darkory binary from this checkout (embedding web/dist/app, which `npm run e2e` has
 * just built), runs `darkory init` in a fresh data directory, and starts `darkory serve` on a free
 * port. The startup login link printed on stdout and the address it names reach the tests through
 * the environment. The returned function stops the server and removes the directories.
 */
export default async function startServer(): Promise<() => Promise<void>> {
  const bin = mkdtempSync(join(tmpdir(), "darkory-e2e-bin-"));
  const data = mkdtempSync(join(tmpdir(), "darkory-e2e-data-"));
  const exe = join(bin, "darkory");
  const env = { ...process.env, DARKORY_NO_UPDATE_CHECK: "1" };

  execFileSync("go", ["build", "-o", exe, "./cmd/darkory"], { cwd: repo, stdio: "inherit", env });
  const init = execFileSync(exe, ["init", "--data", data, "--org", "E2E Organisation", "--name", "ada"], { env, stdio: "pipe" });
  // ada's token, which init prints once: a spec that runs after the startup link is used signs in
  // by asking /v1 for a login link of its own.
  process.env.DARKORY_E2E_ADMIN_TOKEN = /dk_\S+/.exec(init.toString())?.[0] ?? "";

  // Port 0: the kernel picks a free port, and serve prints its link with the port it got.
  const server = spawn(exe, ["serve", "--no-browser", "--listen", "127.0.0.1:0", "--data", data], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = async () => {
    await stopProcess(server);
    rmSync(bin, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  };
  process.once("exit", () => server.kill("SIGKILL"));

  try {
    const link = await loginLink(server);
    process.env.DARKORY_E2E_LOGIN_LINK = link;
    process.env.DARKORY_E2E_BASE_URL = new URL(link).origin;
    process.env.DARKORY_E2E_DATA = data;
  } catch (err) {
    await stop();
    throw err;
  }
  return stop;
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
