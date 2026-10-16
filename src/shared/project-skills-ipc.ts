import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const harness = z.enum(["claude-code", "codex"]);
const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !/^[A-Za-z]:/u.test(path) &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
  );
const origin = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mine"),
      sourceId: id,
      packageId: relativePath,
      artifactPath: relativePath,
      label: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      source: z.string().max(4096),
      sourceId: id.optional(),
      packageId: relativePath.optional(),
      artifactPath: relativePath.optional(),
      label: z.string().max(4096).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("project-only") }).strict(),
]);
const agent = z
  .object({
    state: z.enum(["installed", "disabled", "absent"]),
    symlink: z.boolean().optional(),
    folderPath: relativePath.optional(),
  })
  .strict();
export const projectSkillRowSchema = z
  .object({
    id,
    skillId: z.string().uuid().optional(),
    name: z.string().min(1).max(4096),
    description: z.string().max(65536),
    origin,
    agents: z.object({ "claude-code": agent, codex: agent }).strict(),
    state: z.enum(["current", "update-available", "modified-here", "removed-upstream", "unknown"]),
  })
  .strict();
const counts = z
  .object({ "claude-code": z.number().int().nonnegative(), codex: z.number().int().nonnegative() })
  .strict();
const response = z
  .object({
    projectId: id,
    skills: z.array(projectSkillRowSchema).max(10000),
    activeSkillCount: counts,
    startupCost: counts,
    git: z
      .array(
        z
          .object({
            id: relativePath,
            relativeRoot: relativePath,
            branch: z
              .string()
              .max(1024)
              .regex(/^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/u)
              .refine((value) => !value.includes(".."))
              .optional(),
            head: z
              .string()
              .regex(/^[0-9a-f]{4,64}$/iu)
              .optional(),
            dirty: z.union([z.boolean(), z.literal("unknown")]),
          })
          .strict(),
      )
      .max(1000)
      .optional(),
    diagnostics: z.array(
      z
        .object({
          location: relativePath,
          code: z.string().max(128),
          severity: z.enum(["info", "warning", "error"]),
          message: z.string().max(4096),
        })
        .strict(),
    ),
  })
  .strict();
const intent = z
  .object({
    kind: z.literal("project-skill"),
    projectId: id,
    rowId: id,
    action: z.enum(["disable", "enable", "delete", "install-agent", "remove-agent"]),
    harnessIds: z.array(harness).min(1).max(2).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.harnessIds && new Set(value.harnessIds).size !== value.harnessIds.length)
      context.addIssue({ code: "custom", message: "Project skill harnesses must be unique." });
    if ((value.action === "install-agent" || value.action === "remove-agent") && value.harnessIds?.length !== 1)
      context.addIssue({ code: "custom", message: "An agent action requires exactly one agent." });
    if (value.action === "delete" && value.harnessIds)
      context.addIssue({ code: "custom", message: "Delete applies to the whole logical project skill." });
  });

export type ProjectSkillHarness = z.infer<typeof harness>;
export type ProjectSkillRow = z.infer<typeof projectSkillRowSchema>;
export type ProjectSkills = z.infer<typeof response>;
export type ProjectSkillIntent = Readonly<
  Omit<z.infer<typeof intent>, "harnessIds"> & { harnessIds?: readonly ProjectSkillHarness[] }
>;
export function parseProjectSkillIntent(value: unknown): ProjectSkillIntent {
  return intent.parse(value);
}
export function parseProjectSkills(value: unknown): ProjectSkills {
  return response.parse(value);
}
export function parseProjectSkillsRequest(value: unknown): { projectId: string } {
  return z.object({ projectId: id }).strict().parse(value);
}
