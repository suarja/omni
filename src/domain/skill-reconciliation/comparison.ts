import { createUnifiedDiff } from "../unified-diff";
import type { SkillRevision } from "./types";

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TEXT_LINES = 1200;
const MAX_LCS_CELLS = 1_000_000;
const MAX_DIFF_BYTES = 64 * 1024;

export type SkillCopyFileChange = "add" | "change" | "delete" | "unchanged";
export type SkillCopyFileSummary = Readonly<{
  path: string;
  change: SkillCopyFileChange;
  left?: Readonly<{ hash: string; byteLength: number }>;
  right?: Readonly<{ hash: string; byteLength: number }>;
}>;
export type SkillCopyFilePresentation = Readonly<{
  presentation: "text" | "binary" | "too-large" | "unchanged";
  diff?: string;
  summary?: string;
  truncated?: boolean;
  byteDifferenceNotice?: boolean;
}>;
export type UnifiedDiffRenderer = typeof createUnifiedDiff;

function fileMap(revision: SkillRevision): Map<string, SkillRevision["files"][number]> {
  return new Map(revision.files.map((file) => [file.path, file]));
}

export function unionSkillCopyFiles(left: SkillRevision, right: SkillRevision): readonly SkillCopyFileSummary[] {
  if (left.algorithm !== right.algorithm) throw new Error("Skill copy revisions use different algorithms.");
  const leftFiles = fileMap(left);
  const rightFiles = fileMap(right);
  return [...new Set([...leftFiles.keys(), ...rightFiles.keys()])]
    .sort((first, second) => (first < second ? -1 : first > second ? 1 : 0))
    .map((path) => {
      const before = leftFiles.get(path);
      const after = rightFiles.get(path);
      const change: SkillCopyFileChange = !before
        ? "add"
        : !after
          ? "delete"
          : before.hash === after.hash && before.byteLength === after.byteLength
            ? "unchanged"
            : "change";
      return {
        path,
        change,
        ...(before ? { left: { hash: before.hash, byteLength: before.byteLength } } : {}),
        ...(after ? { right: { hash: after.hash, byteLength: after.byteLength } } : {}),
      };
    });
}

export function chooseSkillCopyFile(
  files: readonly SkillCopyFileSummary[],
  requestedPath?: string,
): string | undefined {
  if (requestedPath !== undefined) return files.some((file) => file.path === requestedPath) ? requestedPath : undefined;
  return (
    files.find((file) => file.change !== "unchanged")?.path ??
    (files.some((file) => file.path === "SKILL.md") ? "SKILL.md" : files[0]?.path)
  );
}

function decodeText(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return "";
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function normalizedLines(value: string): readonly string[] {
  const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineDifference(left: string, right: string): boolean {
  const leftLines = normalizedLines(left);
  const rightLines = normalizedLines(right);
  return leftLines.length !== rightLines.length || leftLines.some((line, index) => line !== rightLines[index]);
}

function tooLarge(summary: string): SkillCopyFilePresentation {
  return { presentation: "too-large", summary };
}

export function compareSkillCopyFileBytes(
  file: Pick<SkillCopyFileSummary, "path" | "change">,
  leftBytes: Uint8Array | undefined,
  rightBytes: Uint8Array | undefined,
  renderDiff: UnifiedDiffRenderer = createUnifiedDiff,
): SkillCopyFilePresentation {
  if (file.change === "unchanged") return { presentation: "unchanged" };
  if ((leftBytes && leftBytes.byteLength > MAX_TEXT_BYTES) || (rightBytes && rightBytes.byteLength > MAX_TEXT_BYTES)) {
    return tooLarge("Text comparison exceeds the 64 KiB per-file limit.");
  }
  const leftText = decodeText(leftBytes);
  const rightText = decodeText(rightBytes);
  if (leftText === undefined || rightText === undefined) {
    return { presentation: "binary", summary: "Binary or invalid UTF-8 file; text diff is unavailable." };
  }
  const leftLines = normalizedLines(leftText);
  const rightLines = normalizedLines(rightText);
  if (leftLines.length > MAX_TEXT_LINES || rightLines.length > MAX_TEXT_LINES) {
    return tooLarge("Text comparison exceeds the 1,200 line per-file limit.");
  }
  const cells = (leftLines.length + 1) * (rightLines.length + 1);
  if (cells > MAX_LCS_CELLS) {
    return tooLarge("Text comparison exceeds the 1,000,000-cell diff limit.");
  }
  const diff = renderDiff("A", "B", leftText, rightText, MAX_DIFF_BYTES);
  const byteDifferenceNotice = Boolean(
    leftBytes &&
    rightBytes &&
    !lineDifference(leftText, rightText) &&
    (leftBytes.byteLength !== rightBytes.byteLength ||
      Buffer.compare(Buffer.from(leftBytes), Buffer.from(rightBytes)) !== 0),
  );
  return {
    presentation: "text",
    diff: diff.text,
    truncated: diff.truncated,
    ...(byteDifferenceNotice ? { byteDifferenceNotice: true } : {}),
  };
}
