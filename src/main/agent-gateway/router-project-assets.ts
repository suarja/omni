import type { Binding } from "../../domain/assignment-plan";
import { resolveTarget } from "../../domain/harness-targets";
import { coversArtifact } from "../../domain/managed-targets";
import type { AgentProjectAssetsResponse } from "../../shared/agents-ipc";
import { unitId } from "../assignment-resolution";
import type { BindingsStore } from "../bindings-store";
import type { RegistryIpcServices } from "../registry-ipc";
import { fail, id, keys, object } from "./router-inputs";

type Options = Readonly<{
  registry: RegistryIpcServices;
  bindingsStore: Pick<BindingsStore, "read">;
  resolveBindingState: (binding: Binding) => Promise<"current" | "update" | "conflict">;
}>;

export function createProjectAssetsReader(options: Options): (params: unknown) => Promise<AgentProjectAssetsResponse> {
  return async (params) => {
    const request = object(params, "list_project_assets parameters");
    keys(request, ["projectId"], "list_project_assets parameters");
    const projectId = id(request.projectId, "Project id");
    const observed = await options.registry.observeRegisteredEntry({ kind: "project", id: projectId });
    if (observed.status !== "observed") throw fail("The registered root could not be observed.");
    const loaded = await options.bindingsStore.read();
    if (loaded.status !== "ready") throw fail("Bindings are unavailable.");
    const projectBindings = loaded.bindings.filter((binding) => binding.projectId === projectId);
    const managed = await Promise.all(
      projectBindings.map(async (binding) => ({
        bindingId: binding.bindingId,
        harness: binding.harnessId,
        artifactPath: binding.artifactPath,
        state: await options.resolveBindingState(binding),
      })),
    );
    const targets = projectBindings.flatMap((binding) => {
      const target = resolveTarget({
        kind: binding.kind,
        id: unitId(binding.kind, binding.artifactPath),
        harnessId: binding.harnessId,
      });
      return target.status === "target" ? [target] : [];
    });
    return {
      status: "ready",
      projectId,
      managed,
      unmanaged: observed.observation.inventory.artifacts
        .filter((artifact) => !targets.some((target) => coversArtifact(target, artifact)))
        .map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          relativePath: artifact.relativePath,
          displayPath: artifact.displayPath,
          ...(artifact.summary ? { summary: artifact.summary } : {}),
        })),
    };
  };
}
