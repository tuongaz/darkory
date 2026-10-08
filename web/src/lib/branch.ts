// The branches the Runner works on in a git Workspace, named here the way the Runner names them
// (model-v2-plan.md, Runner: the lower-cased key, then the slug), so a record can say which
// branch holds its work. A Subtask's branch starts from its Parent's and merges back into it.

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

/**
 * The branch a Task's session works on, a Parent's included: its key in lower case, then its title
 * made short, as in main-7-support-emoji.
 */
export function taskBranch(key: string, title: string): string {
  return `${key.toLowerCase()}-${slug(title)}`;
}
