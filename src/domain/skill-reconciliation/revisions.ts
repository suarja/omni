import type { SkillRevision } from "./types";

export type SkillFileRevision = Readonly<{ path: string; hash: string; byteLength: number }>;
export type TextDigest = (manifest: string) => string;

export function createSkillRevision(files: readonly SkillFileRevision[], digest: TextDigest): SkillRevision {
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  return {
    algorithm: "omni-tree-v1",
    hash: digest(sorted.map((file) => `${file.path}:${file.hash}`).join("\n")),
    files: sorted,
  };
}

export function revisionsEqual(left: SkillRevision, right: SkillRevision): boolean {
  return left.algorithm === right.algorithm && left.hash === right.hash;
}
