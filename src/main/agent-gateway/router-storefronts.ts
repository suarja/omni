import { remoteUrl } from "../git-cli";
import { join } from "node:path";
import { createLocalJsonRegistryStore } from "../../adapters/registry/local-json";
import { activeWorkshop, activeStorefronts } from "../../domain/source-roles";
import { githubRepository } from "../../domain/storefront-origin";
import type { RegistryView } from "../../domain/project-source-registry";
import type { AgentSourceSummary } from "../../shared/agents-ipc";
import { createStorefrontService } from "../storefronts/service";
import { readGitText } from "../git-read";
export async function readAgentStorefronts(
  userDataPath: string,
  view: RegistryView,
): Promise<Readonly<{ workshop: AgentSourceSummary | null; storefronts: readonly AgentSourceSummary[] }>> {
  const loaded = await createLocalJsonRegistryStore(join(userDataPath, "omni/project-source-registry.json")).read();
  const drift = await createStorefrontService({ userDataPath }).readDrift();
  const summarize = async (
    entry: RegistryView["sources"][number],
    role: "workshop" | "storefront",
  ): Promise<AgentSourceSummary> => {
    const registration =
      loaded.status === "ready"
        ? loaded.state.sources.find((source) => source.id === entry.ref.id && source.archivedAt === undefined)
        : undefined;
    const remote =
      registration &&
      (role === "storefront"
        ? await remoteUrl(registration.locator.canonicalPath).catch(() => undefined)
        : await readGitText(registration.locator.canonicalPath, ["config", "--get", "remote.origin.url"]));
    const repository = remote && githubRepository(remote);
    const report =
      drift.status === "ready" ? drift.storefronts.find((source) => source.sourceId === entry.ref.id) : undefined;
    return {
      id: entry.ref.id,
      name: entry.displayName,
      role,
      ...(repository ? { githubRepository: repository } : {}),
      drift:
        role === "workshop"
          ? null
          : report
            ? {
                status: "ready",
                toPublish: report.toPublish,
                conflicts: report.conflicts,
                unavailablePlugins: report.unavailablePlugins,
              }
            : { status: "unavailable" },
    };
  };
  const workshop = activeWorkshop(view);
  return {
    workshop: workshop ? await summarize(workshop, "workshop") : null,
    storefronts: await Promise.all(activeStorefronts(view).map((entry) => summarize(entry, "storefront"))),
  };
}
