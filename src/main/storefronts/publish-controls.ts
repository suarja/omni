import type { PackageManifest } from "../../domain/marketplace-format";
import type { SkillCheckFile } from "../../domain/skill-checks";
import { buildNewPluginProjections, buildPluginProjectionActions } from "../new-plugin-projections";
import { hashContent, parseObject } from "../marketplace-manifests";
import { bytes, edit, retainCommitEdit, updatePluginList, type PublicationEdit } from "./publish-content";
import type { NewDestination } from "./publish-plan";
type ReadFile = (path: string) => Promise<Uint8Array | undefined>;
export type StorefrontControls = Readonly<{
  edits: readonly PublicationEdit[];
  controls: Readonly<Record<string, string | undefined>>;
  checkFiles: readonly SkillCheckFile[];
  license: Uint8Array | undefined;
}>;
export async function buildStorefrontControls(
  root: string,
  pluginId: string,
  manifest: PackageManifest,
  fileAt: ReadFile,
  committedAt: ReadFile,
  replacingPackagePath?: string,
  destination?: NewDestination,
): Promise<StorefrontControls> {
  const projections = destination
    ? buildPluginProjectionActions(
        root,
        `plugins/${pluginId}`,
        manifest,
        (["claude-code", "codex"] as const).map((harness) => {
          const relativePath =
            harness === "claude-code" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json";
          const content = Buffer.from(destination.files[relativePath]!).toString("utf8");
          return { harness, relativePath, content, manifest: parseObject(content) };
        }),
      )
    : await buildNewPluginProjections(
        root,
        `plugins/${pluginId}`,
        manifest,
        ["claude-code", "codex"],
        replacingPackagePath,
      );
  const controls: Record<string, string | undefined> = Object.create(null);
  const checkFiles: SkillCheckFile[] = [];
  const edits: PublicationEdit[] = [];
  for (const projection of projections.filter((action) => !action.relativePath.endsWith("/plugin.json"))) {
    const before = await fileAt(projection.relativePath);
    controls[projection.relativePath] = before && hashContent(before);
    const change =
      edit(projection.relativePath, before, bytes(projection.content)) ??
      retainCommitEdit(projection.relativePath, before, await committedAt(projection.relativePath));
    if (change) edits.push(change);
    checkFiles.push({ path: projection.relativePath, content: projection.content });
  }
  const readme = await fileAt("README.md");
  if (!readme) throw new Error("The storefront README is unavailable.");
  controls["README.md"] = hashContent(readme);
  const readmeAfter = bytes(updatePluginList(Buffer.from(readme).toString("utf8"), pluginId, manifest.description));
  const readmeEdit =
    edit("README.md", readme, readmeAfter) ?? retainCommitEdit("README.md", readme, await committedAt("README.md"));
  if (readmeEdit) edits.push(readmeEdit);
  checkFiles.push({ path: "README.md", content: Buffer.from(readmeAfter).toString("utf8") });
  const license = await fileAt("LICENSE");
  controls["LICENSE"] = license && hashContent(license);
  if (license) {
    checkFiles.push({ path: "LICENSE", content: Buffer.from(license).toString("utf8") });
    const licenseEdit = retainCommitEdit("LICENSE", license, await committedAt("LICENSE"));
    if (licenseEdit) edits.push(licenseEdit);
  }
  return { edits, controls, checkFiles, license };
}
