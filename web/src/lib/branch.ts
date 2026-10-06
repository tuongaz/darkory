// The branches the Runner works on in a git Workspace (ADR 0014), named here the way
// internal/runner/workspace.go names them, so a record can say which branch holds its work.

const maxSlug = 40;

/**
 * A title made short and plain for a branch name: lower case, every run of characters other than
 * a–z and 0–9 made one "-", cut at 40 characters on a word boundary; "task" when nothing is left.
 * The Runner's Slug, character for character.
 */
export function slug(title: string): string {
  let s = "";
  let dash = false;
  for (const ch of title) {
    // Go lowers rune by rune, one rune for one: İ is i, where JavaScript's whole-string lowering adds a dot.
    const c = [...ch.toLowerCase()][0];
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) {
      if (dash && s.length > 0) s += "-";
      s += c;
      dash = false;
      continue;
    }
    dash = true;
  }
  if (s.length > maxSlug) {
    s = s.slice(0, maxSlug);
    const i = s.lastIndexOf("-");
    if (i > 20) s = s.slice(0, i);
    s = s.replace(/-+$/, "");
  }
  return s || "task";
}

/** The branch a Task's session works on: its key, then its title made short, as in WEB-12/cart-page. */
export function taskBranch(key: string, title: string): string {
  return `${key}/${slug(title)}`;
}

/** The branch a Feature's Tasks merge into, made at Break down; a quick Feature has none. */
export function featureBranch(key: string): string {
  return `feature/${key}`;
}
