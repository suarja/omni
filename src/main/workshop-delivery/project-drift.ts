import { freshGrant } from "../skill-management/adoption-reader";
import { createSkillBaseStore } from "../skill-reconciliation/bases";
import { createProjectSkillSourceReader } from "../skill-management/project-skill-sources";
import { compareProjectSkillUse } from "../skill-management/project-skill-revisions";
import { join } from "node:path";
import type { Binding } from "../../domain/assignment-plan";
import { isActiveAvailableProject } from "../../domain/active-projects";
import type { AgentDriftResponse } from "../../shared/agents-ipc";
import type { RegistryIpcServices } from "../registry-ipc";
import { bindingsFilePath, createBindingsStore } from "../bindings-store";
import type { BindingsIpcServices } from "../bindings-ipc";
import { createSkillRelationshipStore } from "../skill-reconciliation/store";
import { isManagedBinding } from "../skill-management/legacy-binding-guard";

type Options = Readonly<{
  userDataPath: string;
  registry: RegistryIpcServices;
  bindings: Pick<BindingsIpcServices, "previewBindings">;
}>;
async function readBindingState(
  binding: Binding,
  options: Options,
): Promise<AgentDriftResponse["bindings"][number]["state"]> {
  try {
    const sourceGrant = await options.registry.getGrantForEntry({ kind: "source", id: binding.sourceId });
    const projectGrant = await options.registry.getGrantForEntry({ kind: "project", id: binding.projectId });
    if (!sourceGrant || !projectGrant) return "unavailable";
    const preview = await options.bindings.previewBindings({
      source: { id: binding.sourceId, grantHandle: sourceGrant },
      packageId: binding.packageId,
      artifactPath: binding.artifactPath,
      projects: [{ projectId: binding.projectId, grantHandle: projectGrant, harnessIds: [binding.harnessId] }],
    });
    if (preview.status !== "ready") return "conflict";
    const state = preview.plans[0]?.actions.find((action) => action.bindingId === binding.bindingId)?.state;
    return state === "current" || state === "linked"
      ? "current"
      : state === "add" || state === "update"
        ? "update"
        : "conflict";
  } catch {
    return "unavailable";
  }
}
export async function readProjectDrift(options: Options, projectId?: string): Promise<AgentDriftResponse> {
  const registry = await options.registry.listRegistry();
  if (registry.status !== "ready") throw new Error("Project registry is unavailable. Reopen Omni and check again.");
  const loaded = await createBindingsStore(bindingsFilePath(options.userDataPath)).read();
  const relationships = await createSkillRelationshipStore(
    join(options.userDataPath, "omni", "skill-relationships.json"),
  ).read();
  if (loaded.status !== "ready" || relationships.status !== "ready")
    throw new Error("Project relationships are unavailable. Inspect their stores before checking drift.");
  const result: Array<AgentDriftResponse["bindings"][number]> = [];
  const bases = createSkillBaseStore(options.userDataPath);
  const sources = createProjectSkillSourceReader(registry.registry, { registry: options.registry });
  for (const project of registry.registry.projects.filter(
    (project) => !project.archivedAt && (!projectId || project.ref.id === projectId),
  )) {
    for (const binding of loaded.bindings.filter(
      (binding) => binding.projectId === project.ref.id && !isManagedBinding(binding, relationships.state.uses),
    )) {
      result.push({
        bindingId: binding.bindingId,
        projectId: project.ref.id,
        harness: binding.harnessId,
        projectAvailable: isActiveAvailableProject(project),
        ...(isActiveAvailableProject(project) ? {} : { reason: project.availability }),
        state: isActiveAvailableProject(project) ? await readBindingState(binding, options) : "unavailable",
        artifactPath: binding.artifactPath,
      });
    }
    const uses = relationships.state.uses.filter((use) => use.location.projectId === project.ref.id && !use.disabled);
    if (!uses.length) continue;
    const grant = isActiveAvailableProject(project)
      ? await freshGrant(options.registry, project.ref, Date.now)
      : undefined;
    for (const use of uses) {
      let state: AgentDriftResponse["bindings"][number]["state"] = "unavailable";
      if (grant) {
        try {
          const observed = await compareProjectSkillUse(use, grant, bases, sources.readRevision);
          state =
            observed === "current"
              ? "current"
              : observed === "update-available"
                ? "update"
                : observed === "modified-here" || observed === "removed-upstream"
                  ? "conflict"
                  : "unavailable";
        } catch {
          /* An unreadable copy remains explicitly unavailable. */
        }
      }
      result.push({
        bindingId: use.bindingId,
        projectId: project.ref.id,
        harness: use.location.harnessId,
        projectAvailable: Boolean(grant),
        artifactPath: `${use.location.folderPath}/SKILL.md`,
        state,
        ...(!grant ? { reason: "Fresh project access is unavailable. Reopen the project and check again." } : {}),
      });
    }
  }
  return { status: "ready", bindings: result };
}
