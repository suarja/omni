import { z } from "zod";
import {
  publicationSchema,
  publicationPathSchema,
  publicationCommitSchema,
  publicationTimeSchema,
} from "../domain/publications";
import { publicationClassifications } from "../domain/publication-drift";

export const STOREFRONTS_IPC_CHANNELS = {
  inspect: "omni:storefronts:inspect",
  link: "omni:storefronts:link",
  drift: "omni:storefronts:drift",
} as const;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const label = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const repository = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u);
const blocked = z.object({ status: z.literal("blocked"), code: id, message: label, sourceId: id.optional() }).strict();
const originSchema = z
  .object({
    sourceRepository: repository,
    sourcePath: publicationPathSchema,
    sourceCommit: publicationCommitSchema,
    publishedTime: publicationTimeSchema,
  })
  .strict();
const pluginSchema = z
  .object({
    pluginId: id,
    name: label,
    relativeRoot: publicationPathSchema,
    manifestPaths: z.array(publicationPathSchema),
    origin: originSchema.optional(),
    recognition: z.enum(["recognized", "not-from-your-marketplace"]),
    behindSkills: z.number().int().nonnegative().optional(),
    driftDiagnostic: label.optional(),
  })
  .strict();
const inspectionSchema = z
  .object({
    status: z.literal("ready"),
    displayName: label,
    displayRoot: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)
      .optional(),
    isGitRepository: z.boolean(),
    githubRepository: repository.optional(),
    originUrl: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)
      .optional(),
    licenseFile: publicationPathSchema.optional(),
    license: label.optional(),
    storefrontCommit: publicationCommitSchema.optional(),
    plugins: z.array(pluginSchema),
  })
  .strict();
const countsSchema = z
  .object({
    unchanged: z.number().int().nonnegative(),
    "workshop-changed": z.number().int().nonnegative(),
    "storefront-only": z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    "added-in-workshop": z.number().int().nonnegative(),
    "removed-in-workshop": z.number().int().nonnegative(),
  })
  .strict();
const pluginDrift = z.union([
  z
    .object({
      status: z.literal("ready"),
      pluginId: id,
      files: z.array(
        z.object({ path: publicationPathSchema, classification: z.enum(publicationClassifications) }).strict(),
      ),
      counts: countsSchema,
      behind: z.boolean(),
      toPublish: z.number().int().nonnegative(),
      conflicts: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ status: z.enum(["missing-base", "unavailable"]), pluginId: id, code: id, message: label }).strict(),
]);
const driftSchema = z.union([
  blocked,
  z
    .object({
      status: z.literal("ready"),
      storefronts: z.array(
        z
          .object({
            sourceId: id,
            name: label,
            plugins: z.array(pluginDrift),
            counts: countsSchema,
            behind: z.boolean(),
            behindPlugins: z.number().int().nonnegative(),
            unavailablePlugins: z.number().int().nonnegative(),
            toPublish: z.number().int().nonnegative(),
            conflicts: z.number().int().nonnegative(),
          })
          .strict(),
      ),
    })
    .strict(),
]);
const linkSchema = z.union([
  blocked,
  z
    .object({
      status: z.literal("linked"),
      sourceId: id,
      inspection: inspectionSchema,
      publications: z.array(publicationSchema),
    })
    .strict(),
]);
const inspectResponseSchema = z.union([
  blocked,
  z.object({ status: z.literal("cancelled") }).strict(),
  inspectionSchema.extend({ inspectionId: id }),
]);
const linkRequestSchema = z.object({ inspectionId: id }).strict();
export type StorefrontInspection = Readonly<z.infer<typeof inspectionSchema>>;
export type StorefrontBlocked = Readonly<z.infer<typeof blocked>>;
export type StorefrontLinkResult = Readonly<z.infer<typeof linkSchema>>;
export type StorefrontDriftReport = Readonly<z.infer<typeof driftSchema>>;
export type StorefrontPluginDrift = z.infer<typeof pluginDrift>;
export type StorefrontInspectResponse = z.infer<typeof inspectResponseSchema>;
export interface StorefrontsDesktopApi {
  inspectStorefront(): Promise<StorefrontInspectResponse>;
  linkStorefront(request: Readonly<{ inspectionId: string }>): Promise<StorefrontLinkResult>;
  readStorefrontDrift(): Promise<StorefrontDriftReport>;
}
export function parseStorefrontLinkRequest(value: unknown): Readonly<{ inspectionId: string }> {
  return linkRequestSchema.parse(value);
}
export function parseStorefrontInspectResponse(value: unknown): StorefrontInspectResponse {
  return inspectResponseSchema.parse(value);
}
export function parseStorefrontLinkResult(value: unknown): StorefrontLinkResult {
  return linkSchema.parse(value);
}
export function parseStorefrontDriftReport(value: unknown): StorefrontDriftReport {
  return driftSchema.parse(value);
}
