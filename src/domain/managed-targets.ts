import type { HarnessTarget } from "./harness-targets";
import type { ObservedArtifact } from "./inventory";

type ManagedTarget = Pick<Extract<HarnessTarget, { status: "target" }>, "relativePath" | "unit">;

function coversPath(target: ManagedTarget, relativePath: string): boolean {
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  )
    return false;
  return (
    relativePath === target.relativePath ||
    (target.unit === "folder" && relativePath.startsWith(`${target.relativePath}/`))
  );
}

export function coversArtifact(
  target: ManagedTarget,
  artifact: Pick<ObservedArtifact, "relativePath" | "projectionPaths">,
): boolean {
  return coversPath(target, artifact.relativePath) || artifact.projectionPaths.some((path) => coversPath(target, path));
}
