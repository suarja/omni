import { z } from "zod";
import { publicationPathSchema, publicationCommitSchema, publicationSchema } from "../domain/publications";
import { publicationClassifications } from "../domain/publication-drift";
const id = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .max(128);
const sourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const safeText = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const repositoryUrl = safeText.refine(
  (url) => !url.startsWith("-") && !/\s/u.test(url) && /^(?:https:\/\/|ssh:\/\/|git@|file:\/\/|\/)/u.test(url),
  "Use a repository URL or absolute local repository path.",
);
export const conflictChoicesSchema = z
  .custom<Record<string, unknown>>((value) => typeof value === "object" && value !== null && !Array.isArray(value))
  .transform((value) => Object.entries(value))
  .pipe(z.array(z.tuple([publicationPathSchema, z.enum(["keep-storefront", "take-workshop"])])))
  .transform((entries) => Object.fromEntries(entries));
export type ConflictChoices = Readonly<z.infer<typeof conflictChoicesSchema>>;
export const newStorefrontSchema = z
  .object({
    name: id,
    description: safeText.max(240).optional(),
    license: z.enum(["MIT", "Apache-2.0"]),
    login: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u)
      .optional(),
    repositoryUrl: repositoryUrl.optional(),
  })
  .strict();
export type NewStorefront = Readonly<z.infer<typeof newStorefrontSchema>>;
const publishSchema = z
  .object({
    kind: z.literal("publish-plugin"),
    pluginId: id,
    storefrontId: sourceId.optional(),
    newStorefront: newStorefrontSchema.optional(),
    conflictChoices: conflictChoicesSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.storefrontId) !== Boolean(value.newStorefront),
    "Select exactly one storefront destination.",
  );
const createSchema = newStorefrontSchema.extend({ kind: z.literal("create-storefront") }).strict();
const retrySchema = z.object({ kind: z.literal("retry-push"), operationId: sourceId }).strict();
export type PublishPluginRequest = Readonly<z.infer<typeof publishSchema>>;
export type CreateStorefrontRequest = Readonly<z.infer<typeof createSchema>>;
export type RetryPushRequest = Readonly<z.infer<typeof retrySchema>>;
export function parsePublishPluginRequest(value: unknown): PublishPluginRequest {
  return publishSchema.parse(value);
}
export function parseCreateStorefrontRequest(value: unknown): CreateStorefrontRequest {
  return createSchema.parse(value);
}
export function parseRetryPushRequest(value: unknown): RetryPushRequest {
  return retrySchema.parse(value);
}
const findingSchema = z
  .object({
    severity: z.literal("error"),
    code: safeText,
    message: safeText,
    fix: safeText,
    file: publicationPathSchema,
    line: z.number().int().positive(),
    excerpt: z.string().max(120),
  })
  .strict();
const summarySchema = z
  .object({
    approvalFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    files: z.array(
      z
        .object({
          path: publicationPathSchema,
          classification: z.enum(publicationClassifications),
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
          choice: z.enum(["keep-storefront", "take-workshop"]).optional(),
        })
        .strict(),
    ),
    conflicts: z.array(publicationPathSchema),
    findings: z.array(findingSchema),
  })
  .strict();
export type PublicationPlanSummary = Readonly<z.infer<typeof summarySchema>>;
export function parsePublicationPlanSummary(value: unknown): PublicationPlanSummary {
  return summarySchema.parse(value);
}
const receiptSchema = z
  .object({
    state: z.enum(["committed-not-pushed", "push-outcome-unknown", "pushed", "restored", "failed"]),
    storefrontId: sourceId,
    pluginId: id.optional(),
    branch: safeText,
    remoteUrl: repositoryUrl,
    previousPublication: publicationSchema.optional(),
    publication: publicationSchema.optional(),
    retryOf: sourceId.optional(),
  })
  .strict();
export type PublicationReceipt = Readonly<z.infer<typeof receiptSchema>>;
export function parsePublicationReceipt(value: unknown): PublicationReceipt {
  return receiptSchema.parse(value);
}
