import type { RegistryEntryView } from "./project-source-registry";

export function isActiveAvailableProject(project: RegistryEntryView<"project">): boolean {
  return project.archivedAt === undefined && project.availability === "available";
}

export function activeAvailableProjectIds(projects: readonly RegistryEntryView<"project">[]): ReadonlySet<string> {
  return new Set(projects.filter(isActiveAvailableProject).map((project) => project.ref.id));
}
