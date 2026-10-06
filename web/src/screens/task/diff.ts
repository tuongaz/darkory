export type DiffLine = { op: "same" | "add" | "del"; text: string };

/**
 * The lines of `from` and `to` as a diff: the longest run of lines both keep, with what `to`
 * removes and adds around it, removals first. A Skill's text is short, so the table is cheap.
 */
export function lineDiff(from: string, to: string): DiffLine[] {
  const a = lines(from);
  const b = lines(to);
  // keep[i][j]: how many lines a[i:] and b[j:] have in common, in order.
  const keep = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      keep[i][j] = a[i] === b[j] ? keep[i + 1][j + 1] + 1 : Math.max(keep[i + 1][j], keep[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || keep[i + 1][j] >= keep[i][j + 1])) {
      out.push({ op: "del", text: a[i++] });
    } else {
      out.push({ op: "add", text: b[j++] });
    }
  }
  return out;
}

/** "1 line added", "2 lines added, 1 removed", "No change". */
export function diffSummary(diff: DiffLine[]): string {
  const added = diff.filter((l) => l.op === "add").length;
  const removed = diff.filter((l) => l.op === "del").length;
  const lineWord = (n: number) => (n === 1 ? "line" : "lines");
  if (added && removed) return `${added} ${lineWord(added)} added, ${removed} removed`;
  if (added) return `${added} ${lineWord(added)} added`;
  if (removed) return `${removed} ${lineWord(removed)} removed`;
  return "No change";
}

function lines(text: string): string[] {
  const out = text.replace(/\r\n/g, "\n").split("\n");
  // A closing newline ends the last line rather than starting an empty one.
  if (out.length > 1 && out.at(-1) === "") out.pop();
  return out;
}
