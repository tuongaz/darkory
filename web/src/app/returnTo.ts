// Where Settings' Back leads: the app page last shown in this tab, kept for a reload in Settings.
const storageKey = "darkory.settings-return";
let last: string | null = null;

export function rememberAppLocation(path: string) {
  last = path;
  try {
    sessionStorage.setItem(storageKey, path);
  } catch {
    // Storage refused (a private window): Back still knows this page until the tab reloads.
  }
}

/** The app page Settings' Back returns to: the last one shown, else the Inbox. */
export function appReturnPath(): string {
  if (last) return last;
  try {
    return sessionStorage.getItem(storageKey) ?? "/inbox";
  } catch {
    return "/inbox";
  }
}
