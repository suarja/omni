import { publicationCommitSchema, publicationPathSchema, publicationTimeSchema } from "./publications";

export type OriginRecord = Readonly<{
  sourceRepository: string;
  sourcePath: string;
  sourceCommit: string;
  publishedTime: string;
}>;

export function githubRepository(remote: string): string | undefined {
  const cleaned = remote
    .trim()
    .replace(/^`|`$/gu, "")
    .replace(/\s+\([^)]*\)$/u, "");
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/u.exec(
      cleaned,
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function parseOriginRecord(text: string): OriginRecord | undefined {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match =
      /^\s*[-*]\s+(?:\*\*)?(Source repository|Source path|Source commit|Published)(?:\*\*)?\s*:\s*(.+?)\s*$/iu.exec(
        line,
      );
    if (match) fields.set(match[1].toLowerCase(), match[2].replace(/`/gu, "").trim());
  }
  const sourceRepository = githubRepository(fields.get("source repository") ?? "");
  const sourcePath = fields.get("source path")?.replace(/^\.\//u, "");
  const sourceCommit = fields.get("source commit");
  const date = fields.get("published");
  const publishedTime = date && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? `${date}T00:00:00.000Z` : date;
  if (
    !sourceRepository ||
    !publicationPathSchema.safeParse(sourcePath).success ||
    !publicationCommitSchema.safeParse(sourceCommit).success ||
    !publicationTimeSchema.safeParse(publishedTime).success
  )
    return undefined;
  return { sourceRepository, sourcePath: sourcePath!, sourceCommit: sourceCommit!, publishedTime: publishedTime! };
}
