import { parsePublicationPlanSummary, type PublicationPlanSummary } from "./publication-operations-ipc";
import { z } from "zod";
import { publicationSchema } from "../domain/publications";
import { parseStorefrontInspectResponse, type StorefrontInspection, type StorefrontBlocked } from "./storefronts-ipc";

export const STOREFRONT_PRESENTATION_CHANNELS = {
  details: "omni:storefronts:details",
  contentChecks: "omni:storefronts:content-checks",
  capabilities: "omni:storefronts:capabilities",
  openRepository: "omni:storefronts:open-repository",
} as const;
const sourceRequest = z.object({ sourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u) }).strict();
const pluginRequest = z
  .object({
    pluginId: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .max(128),
  })
  .strict();
const label = z
  .string()
  .max(240)
  .regex(/^[^\u0000-\u001f\u007f]*$/u);
const detailsSchema = z
  .object({
    status: z.literal("ready"),
    inspection: z.unknown(),
    publications: z.array(publicationSchema),
    description: label.optional(),
    license: label.optional(),
  })
  .strict();
const blockedSchema = z
  .object({
    status: z.literal("blocked"),
    code: label.min(1),
    message: label.min(1),
    sourceId: sourceRequest.shape.sourceId.optional(),
  })
  .strict();
const capabilitiesSchema = z
  .object({
    gh: z.enum(["ready", "unavailable", "unauthenticated"]),
    login: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u)
      .optional(),
  })
  .strict();
const openedSchema = z.union([z.object({ status: z.literal("opened") }).strict(), blockedSchema]);
export type StorefrontDetails =
  | Readonly<{
      status: "ready";
      inspection: StorefrontInspection;
      publications: readonly z.infer<typeof publicationSchema>[];
      description?: string;
      license?: string;
    }>
  | StorefrontBlocked;
export type StorefrontCapabilities = Readonly<z.infer<typeof capabilitiesSchema>>;
export interface StorefrontPresentationDesktopApi {
  readPublicationContentChecks(request: Readonly<{ pluginId: string }>): Promise<PublicationPlanSummary>;
  readStorefrontDetails(request: Readonly<{ sourceId: string }>): Promise<StorefrontDetails>;
  readStorefrontCapabilities(): Promise<StorefrontCapabilities>;
  openStorefrontRepository(request: Readonly<{ sourceId: string }>): Promise<z.infer<typeof openedSchema>>;
}
export function parseStorefrontSourceRequest(value: unknown): Readonly<{ sourceId: string }> {
  return sourceRequest.parse(value);
}
export function parseStorefrontDetails(value: unknown): StorefrontDetails {
  const blocked = blockedSchema.safeParse(value);
  if (blocked.success) return blocked.data;
  const details = detailsSchema.parse(value);
  const inspection = parseStorefrontInspectResponse({
    ...(details.inspection as object),
    inspectionId: "presentation",
  });
  if (inspection.status !== "ready") throw new Error("Storefront inspection is not ready.");
  const { inspectionId: _id, ...display } = inspection;
  return { ...details, inspection: display };
}
export function parseStorefrontCapabilities(value: unknown): StorefrontCapabilities {
  return capabilitiesSchema.parse(value);
}
export function parseStorefrontOpened(value: unknown): z.infer<typeof openedSchema> {
  return openedSchema.parse(value);
}

export function parsePublicationContentRequest(value: unknown): Readonly<{ pluginId: string }> {
  return pluginRequest.parse(value);
}
export function parsePublicationContentChecks(value: unknown): PublicationPlanSummary {
  return parsePublicationPlanSummary(value);
}
