import { z } from "zod";

export const publicationPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.includes("\\") &&
      !/[\u0000-\u001f\u007f:]/u.test(path) &&
      path.split("/").every((part) => Boolean(part) && part !== "." && part !== ".."),
    "Publication paths must be safe relative paths.",
  );
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
export const publicationCommitSchema = z.string().regex(/^[0-9a-f]{7,64}$/u);
export const publicationTimeSchema = z.string().datetime();
const fileHashesSchema = z
  .custom<Record<string, unknown>>((value) => typeof value === "object" && value !== null && !Array.isArray(value))
  .transform((value) => Object.entries(value))
  .pipe(z.array(z.tuple([publicationPathSchema, z.string().regex(/^[0-9a-f]{64}$/u)])))
  .transform((entries) => Object.fromEntries(entries));
export const publicationSchema = z
  .object({
    storefrontSourceId: id,
    pluginId: id,
    workshopPackagePath: publicationPathSchema,
    baseCommit: publicationCommitSchema,
    publishedHashes: fileHashesSchema,
    storefrontCommit: publicationCommitSchema.optional(),
    publishedTime: publicationTimeSchema,
  })
  .strict();
export type Publication = Readonly<z.infer<typeof publicationSchema>>;
const publicationsStateSchema = z
  .object({ schemaVersion: z.literal(1), publications: z.array(publicationSchema) })
  .strict()
  .refine(
    ({ publications }) =>
      new Set(publications.map((record) => `${record.storefrontSourceId}/${record.pluginId}`)).size ===
      publications.length,
    "Publication identities must be unique.",
  );
export type PublicationsState = Readonly<z.infer<typeof publicationsStateSchema>>;

export function parsePublicationsState(value: unknown): PublicationsState {
  return publicationsStateSchema.parse(value);
}
