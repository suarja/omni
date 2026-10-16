import type { InventoryDiagnostic, InventorySnapshot } from "../../domain/inventory";
import type { RegistryIpcServices } from "../registry-ipc";

type ObservationResponse = Awaited<ReturnType<RegistryIpcServices["observeEntryWithGrant"]>>;
type ObservedResponse = Extract<ObservationResponse, { status: "observed" }>;

function relativePath(value: string): string | undefined {
  if (!value || value === "." || value === "root") return "";
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return undefined;
  if (!value.includes("/") && !value.includes(".")) return undefined;
  const segments = value.replace(/\/$/u, "").split("/");
  return segments.some((segment) => !segment || segment === "." || segment === "..") ? undefined : segments.join("/");
}

export function unscopedObservationIssue(inventory: InventorySnapshot): InventoryDiagnostic | undefined {
  return inventory.diagnostics.find(({ code, location }) => {
    const path = relativePath(location);
    return code !== "git-unavailable" && (path === undefined || path === "");
  });
}

/** Unknown diagnostic paths remain blocking because their scope cannot be proved. */
export function observationIssueForLocation(
  inventory: InventorySnapshot,
  folderPath: string,
): InventoryDiagnostic | undefined {
  const folder = relativePath(folderPath);
  return inventory.diagnostics.find(({ code, location }) => {
    if (code === "git-unavailable") return false;
    const path = relativePath(location);
    return (
      folder === undefined ||
      path === undefined ||
      !folder ||
      !path ||
      path === folder ||
      path.startsWith(`${folder}/`) ||
      folder.startsWith(`${path}/`)
    );
  });
}

export function hasCompleteObservationForLocation(
  value: ObservationResponse,
  folderPath: string,
): value is ObservedResponse {
  return value.status === "observed" && !observationIssueForLocation(value.observation.inventory, folderPath);
}
