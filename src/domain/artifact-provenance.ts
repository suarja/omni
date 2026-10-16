import { z } from "zod";

const safeText = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u);
const relativePath = safeText.refine(
  (path) =>
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== ".."),
);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const schema = z
  .object({
    source: safeText,
    ref: safeText.optional(),
    skillPath: relativePath.optional(),
    // A lock hash identifies the recorded upstream tree; contentHash identifies the copied bytes.
    computedHash: hash,
    contentHash: hash,
    relativePath,
    importedAt: z.string().datetime(),
    project: z
      .object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u), name: safeText })
      .strict()
      .optional(),
    reason: safeText.optional(),
  })
  .strict();

export type ArtifactProvenance = z.infer<typeof schema>;

export function parseArtifactProvenance(value: unknown): ArtifactProvenance {
  return schema.parse(value);
}
