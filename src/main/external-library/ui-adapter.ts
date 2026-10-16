import { createHash } from "node:crypto";
import { mkdtemp, rm, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { cloneExternalReadCopy, classifyGitFailure } from "../git-command";
import { readGitText } from "../git-read";
import { parseExternalRepository } from "../../domain/external-library";
import {
  parseExternalDiscovery,
  parseExternalSkillDocumentRequest,
  type ExternalDiscovery,
  type ExternalImportSource,
} from "../../shared/external-library-ui-ipc";
import { readExternalLicence, readExternalSkills } from "./trees";
import { summarizeExternalSource } from "./reader";
import type { ExternalLibraryService } from "./service";
import type { RegistryGrantStore } from "../registry-ipc";
import type { ReadArtifactResponse } from "../../shared/artifact-ipc";
import { readGrantedArtifact } from "../artifact-reader";

export function createExternalLibraryUiAdapter(
  options: Readonly<{
    library: ExternalLibraryService;
    grants: RegistryGrantStore;
    resolveUrl?: (repo: string) => string;
    now?: () => number;
    openRepository: (url: string) => Promise<void>;
  }>,
): Readonly<{
  discover(repository: string): Promise<ExternalDiscovery>;
  importSource(request: { sourceId: string; skillPath: string }): Promise<ExternalImportSource>;
  readDocument(request: { sourceId: string; skillPath: string }): Promise<ReadArtifactResponse>;
  openRepository(sourceId: string): Promise<{ status: "opened" } | { status: "blocked"; message: string }>;
}> {
  const cached = new Map<string, Promise<ExternalDiscovery>>();
  async function discover(repository: string): Promise<ExternalDiscovery> {
    const repo = parseExternalRepository(repository);
    const pending = cached.get(repo);
    if (pending) return pending;
    const read = inspect(repo);
    if (cached.size >= 32) cached.delete(cached.keys().next().value!);
    cached.set(repo, read);
    const result = await read;
    if (result.status === "failed") cached.delete(repo);
    return result;
  }
  async function inspect(repo: string): Promise<ExternalDiscovery> {
    let temporary: string | undefined;
    try {
      const existing = await options.library.readSource(repo);
      const matches = (await options.library.onMac()).marketplaces.filter((item) => item.repo === repo);
      if (existing.source?.head && !existing.source.lastError)
        return parseExternalDiscovery({
          status: "ready",
          source: existing.source,
          skills: existing.skills,
          uses: existing.uses,
          marketplaceMatches: matches,
        });
      // Discovery owns only this temporary directory. It never registers a source or runs the update policy.
      temporary = await mkdtemp(join(tmpdir(), "omni-external-discovery-"));
      const root = join(temporary, "read-copy");
      await cloneExternalReadCopy(temporary, options.resolveUrl?.(repo) ?? `https://github.com/${repo}.git`, root);
      const licence = await readExternalLicence(createLocalInventoryPort(root));
      const skills = await readExternalSkills(root, licence);
      const commit = (await readGitText(root, ["rev-parse", "HEAD"]))?.trim();
      const date = (await readGitText(root, ["log", "-1", "--format=%cI"]))?.trim();
      if (!commit || !date) throw new Error("The source revision could not be read. Retry discovery.");
      const source = {
        ...summarizeExternalSource(repo, repo),
        kind: "github" as const,
        repo,
        licence,
        head: { commit, date: new Date(date).toISOString() },
        skillCount: skills.length,
        unusedSkills: skills.length,
        readCopy: "Omni temporary read copy",
        lastCheckAt: new Date((options.now ?? Date.now)()).toISOString(),
      };
      return parseExternalDiscovery({ status: "ready", source, skills, uses: [], marketplaceMatches: matches });
    } catch (failure) {
      return { status: "failed", error: classifyGitFailure(failure) };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }
  async function importSource(request: { sourceId: string; skillPath: string }): Promise<ExternalImportSource> {
    const observation = await options.library.operationObservation();
    const details = observation.sources.find((item) => item.source?.id === request.sourceId);
    const root = observation.roots.get(request.sourceId);
    if (
      !details?.source ||
      details.source.lastError ||
      !root ||
      !details.skills.some((skill) => skill.path === request.skillPath)
    )
      throw new Error("The checked external skill is unavailable. Check the library before copying it.");
    const canonical = await realpath(root),
      identity = await stat(root);
    if (canonical !== root || !identity.isDirectory())
      throw new Error("The external read copy changed. Check the library again.");
    const id = `external-copy-${createHash("sha256").update(request.sourceId).digest("hex").slice(0, 32)}`;
    const grantHandle = options.grants.issue({
      subject: { kind: "source", id },
      root,
      device: String(identity.dev),
      inode: String(identity.ino),
      displayName: details.source.repo ?? details.source.name,
    });
    return { kind: "source", id, grantHandle, relativePath: request.skillPath };
  }
  async function openRepository(
    sourceId: string,
  ): Promise<{ status: "opened" } | { status: "blocked"; message: string }> {
    const details = await options.library.readSource(sourceId);
    if (!details.source?.repo)
      return { status: "blocked", message: "The source has no GitHub repository. Open its registered folder instead." };
    await options.openRepository(`https://github.com/${parseExternalRepository(details.source.repo)}`);
    return { status: "opened" };
  }
  async function readDocument(request: { sourceId: string; skillPath: string }): Promise<ReadArtifactResponse> {
    const parsed = parseExternalSkillDocumentRequest(request);
    const observation = await options.library.operationObservation();
    const details = observation.sources.find((item) => item.source?.id === parsed.sourceId);
    const root = observation.roots.get(parsed.sourceId);
    if (!details?.source || !root || !details.skills.some((skill) => skill.path === parsed.skillPath))
      throw new Error(
        `The cached skill ${parsed.skillPath} from ${parsed.sourceId} is unavailable. Check the library again.`,
      );
    const canonical = await realpath(root),
      identity = await stat(root);
    if (canonical !== root || !identity.isDirectory())
      throw new Error(`The read copy for ${parsed.sourceId} changed. Check the library again.`);
    const id = `external-document-${createHash("sha256").update(parsed.sourceId).digest("hex").slice(0, 32)}`;
    // Keep this grant inside main. A document read cannot authorize an import or another file.
    const grantHandle = options.grants.issue({
      subject: { kind: "source", id },
      root,
      device: String(identity.dev),
      inode: String(identity.ino),
    });
    return readGrantedArtifact(
      { kind: "source", id, grantHandle, relativePath: `${parsed.skillPath}/SKILL.md` },
      options.grants,
    );
  }
  return { discover, importSource, readDocument, openRepository };
}
