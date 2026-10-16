import { z } from "zod";
import type { InventorySnapshot } from "../domain/inventory";
import { parseInventorySnapshot } from "./inventory-dto";
import type { RegisterProjectResponse } from "./registry-ipc";

const grantRequest = z
  .object({
    grantHandle: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
  })
  .strict();
const inspected = z
  .object({
    status: z.literal("inspected"),
    grantHandle: grantRequest.shape.grantHandle,
    displayName: z.string().min(1).max(256),
    displayRoot: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.includes("\\") && (!value.includes("/") || value.startsWith("~/")) && !value.split("/").includes(".."),
      ),
    inventory: z.unknown(),
  })
  .strict();
const cancelled = z.object({ status: z.literal("cancelled") }).strict();
const inaccessible = z
  .object({
    status: z.literal("inaccessible"),
    diagnostic: z
      .string()
      .min(1)
      .max(240)
      .refine((value) => !/[\r\n]/u.test(value) && !/(?:^|\s)\//u.test(value)),
  })
  .strict();
export type InspectedProject = Readonly<{
  status: "inspected";
  grantHandle: string;
  displayName: string;
  displayRoot: string;
  inventory: InventorySnapshot;
}>;
export type ProjectInspectionResponse =
  InspectedProject | Readonly<{ status: "cancelled" }> | Readonly<{ status: "inaccessible"; diagnostic: string }>;
export interface ProjectInspectionDesktopApi {
  inspectProject(): Promise<ProjectInspectionResponse>;
  registerInspectedProject(request: Readonly<{ grantHandle: string }>): Promise<RegisterProjectResponse>;
}
export function parseProjectGrantRequest(value: unknown): Readonly<{ grantHandle: string }> {
  return grantRequest.parse(value);
}
export function parseProjectInspectionResponse(value: unknown): ProjectInspectionResponse {
  const result = z.union([inspected, cancelled, inaccessible]).parse(value);
  if (result.status !== "inspected") return result;
  const inventory = parseInventorySnapshot(result.inventory);
  if (inventory.rootHandle !== result.grantHandle)
    throw new Error("Project inspection inventory does not match its folder grant. Choose the folder again.");
  return { ...result, inventory };
}
