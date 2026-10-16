import type { OperationReceipt } from "../../../shared/operations-ipc";
import type { StorefrontPluginDrift } from "../../../shared/storefronts-ipc";
export function changedSkillCount(drift: StorefrontPluginDrift): number {
  if (drift.status !== "ready") return 0;
  return new Set(
    drift.files
      .filter((file) => file.classification !== "unchanged" && file.classification !== "storefront-only")
      .flatMap((file) => {
        const name = file.path.match(/(?:^|\/)skills\/([^/]+)/u)?.[1];
        return name ? [name] : [];
      }),
  ).size;
}
export function latestStorefrontReceipts(
  receipts: readonly OperationReceipt[],
  sourceId: string,
): readonly OperationReceipt[] {
  const latest = new Map<string, OperationReceipt>();
  for (const receipt of [...receipts].reverse().sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))) {
    if (receipt.publication?.storefrontId !== sourceId) continue;
    const key = receipt.publication.pluginId ?? "creation";
    if (!latest.has(key)) latest.set(key, receipt);
  }
  return [...latest.values()];
}
export function publicationDate(time: string | undefined, language: "en" | "fr"): string {
  return time
    ? new Date(time).toLocaleDateString(language === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short" })
    : "";
}
export function pluginIdFor(packagePath: string): string {
  return packagePath.split("/").at(-1) ?? packagePath;
}
export function displayPluginFile(path: string): string {
  return path.replace(/^plugins\/[^/]+\//u, "").replace(/^skills\//u, "");
}

export function publicationTimestamp(time: string, language: "en" | "fr"): string {
  return `${publicationDate(time, language)} ${new Date(time).toLocaleTimeString(language === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}
