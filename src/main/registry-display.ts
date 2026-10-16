import { homedir } from "node:os";
import { basename, relative, resolve, isAbsolute } from "node:path";
import { createRegistryView, type RegistryState, type RegistryView } from "../domain/project-source-registry";

export function displayProjectRoot(path: string, home: string = homedir()): string {
  const root = resolve(path);
  const distance = relative(resolve(home), root);
  if (!distance) return "~";
  return distance !== ".." && !distance.startsWith("../") && !isAbsolute(distance)
    ? `~/${distance}`
    : basename(root) || "<root>";
}

export function createReadableRegistryView(
  state: RegistryState,
  availability?: Parameters<typeof createRegistryView>[1],
): RegistryView {
  const view = createRegistryView(state, availability);
  return {
    ...view,
    projects: view.projects.map((project, index) => ({
      ...project,
      displayRoot: displayProjectRoot(state.projects[index].locator.canonicalPath),
    })),
    sources: view.sources.map((source, index) => ({
      ...source,
      displayRoot: displayProjectRoot(state.sources[index].locator.canonicalPath),
    })),
  };
}
