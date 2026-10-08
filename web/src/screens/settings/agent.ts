// An agent's settings as the Member page edits them: how the Runner starts its sessions.

/** The model an agent made in the web app runs on unless the admin names another. */
export const defaultModel = "claude-sonnet-5-5";

/** The model ids the Model field suggests; any other is taken as typed. */
export const knownModels = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"];

/** What the Runner puts in place of each placeholder in the command, its arguments and the progress file. */
export const placeholders: [string, string][] = [
  ["{session_id}", "the session's id, chosen by the Runner"],
  ["{model}", "the model below"],
  ["{prompt_file}", "the prompt the Runner writes from the record"],
  ["{mcp_config}", "a config file pointing at darkory mcp"],
  ["{workspace}", "the session's directory"],
  ["{task}", "the Task's key"],
];

/** Arguments typed one per line; a blank line is none. */
export function argsOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function argsText(args: string[]): string {
  return args.join("\n");
}

const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Variables typed one `KEY = value` per line, split at the first "="; a blank line is none. What
 * /v1 would refuse is said in words, by line, before sending.
 */
export function envOf(text: string): { env: Record<string, string> } | { problem: string } {
  const env: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    const key = eq < 0 ? line : line.slice(0, eq).trim();
    if (eq < 0) return { problem: `Line ${i + 1} needs a value: KEY = value.` };
    if (!envName.test(key)) return { problem: `Line ${i + 1}: ${key ? `“${key}”` : "the part before ="} is not a variable's name.` };
    if (key.toUpperCase().startsWith("DARKORY_")) return { problem: `Line ${i + 1}: the Runner sets ${key} itself.` };
    if (key in env) return { problem: `Line ${i + 1}: ${key} is named twice.` };
    env[key] = line.slice(eq + 1).trim();
  }
  return { env };
}

export function envText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n");
}
