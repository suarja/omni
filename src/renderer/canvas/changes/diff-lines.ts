export type DiffLine = Readonly<{
  kind: "hunk" | "context" | "add" | "remove";
  text: string;
  before?: number;
  after?: number;
}>;
export type DiffExcerpt = Readonly<{ lines: readonly DiffLine[]; truncated: boolean; summary?: string }>;
export type SplitDiffLine = Readonly<{ kind: "hunk" | "row"; text?: string; before?: DiffLine; after?: DiffLine }>;

export function parseDiffLines(text: string): DiffExcerpt {
  const bounded = text.slice(0, 64 * 1024);
  const rows: DiffLine[] = [];
  let before: number | undefined;
  let after: number | undefined;
  let truncated = text.length > bounded.length;
  for (const line of bounded.split(/\r?\n/u)) {
    if (rows.length >= 1200) {
      truncated = true;
      break;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (before !== undefined && after !== undefined && /^[ +\-]/u.test(line)) {
      const kind = line[0] === "+" ? "add" : line[0] === "-" ? "remove" : "context";
      rows.push({
        kind,
        text: line.slice(1),
        ...(kind !== "add" ? { before: before++ } : {}),
        ...(kind !== "remove" ? { after: after++ } : {}),
      });
    }
  }
  return { lines: rows, truncated, ...(!rows.length ? { summary: bounded } : {}) };
}

export function pairDiffLines(lines: readonly DiffLine[]): readonly SplitDiffLine[] {
  const rows: SplitDiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index++];
    if (line.kind === "hunk") {
      rows.push({ kind: "hunk", text: line.text });
      continue;
    }
    if (line.kind === "context") {
      rows.push({ kind: "row", before: line, after: line });
      continue;
    }
    const removed: DiffLine[] = line.kind === "remove" ? [line] : [];
    const added: DiffLine[] = line.kind === "add" ? [line] : [];
    while (index < lines.length && (lines[index].kind === "remove" || lines[index].kind === "add")) {
      const next = lines[index++];
      (next.kind === "remove" ? removed : added).push(next);
    }
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair++)
      rows.push({
        kind: "row",
        ...(removed[pair] ? { before: removed[pair] } : {}),
        ...(added[pair] ? { after: added[pair] } : {}),
      });
  }
  return rows;
}
