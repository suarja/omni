export { displayPath } from "../adapters/activity/evidence";
import { basename, relative, resolve, sep } from "node:path";

export type ActivityProjectRoot = Readonly<{
  projectId: string;
  projectName?: string;
  root: string;
}>;

export function isWithin(root: string, candidate: string): boolean {
  const distance = relative(resolve(root), resolve(candidate));
  return distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`));
}

export function absolutePath(displayedPath: string, homeDir: string): string {
  if (displayedPath === "~") return homeDir;
  return displayedPath.startsWith("~/") ? `${homeDir}/${displayedPath.slice(2)}` : displayedPath;
}

export function projectForPath(
  path: string | undefined,
  projects: readonly ActivityProjectRoot[],
): ActivityProjectRoot | undefined {
  if (!path) return undefined;
  return [...projects]
    .filter((project) => isWithin(project.root, path))
    .sort((left, right) => resolve(right.root).length - resolve(left.root).length)[0];
}

export function worktreeName(path: string): string {
  return basename(path);
}
